/// <reference types="@webgpu/types" />

/**
 * The WebGPU device the compute kernels run on, shared by everything in one
 * page or worker. WebGPU works in dedicated workers as well as on the page, so
 * analyses can use it without leaving their worker.
 */
export interface GpuContext {
  readonly device: GPUDevice;
  /** What the browser says the adapter is, for benchmarks: vendor, architecture, description. */
  readonly adapterName: string;
}

let pending: Promise<GpuContext | undefined> | undefined;

/** Whether this browser exposes WebGPU at all; an adapter can still be refused. */
export function gpuSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu !== undefined;
}

/**
 * The shared device, asking for the adapter's own buffer limits: the defaults
 * (128 MB per binding) are far below what a 60-million-point scan needs.
 * Resolves undefined when WebGPU is missing or refused, so callers fall back
 * to the CPU.
 */
export function requestGpu(): Promise<GpuContext | undefined> {
  pending ??= (async () => {
    if (!gpuSupported()) return undefined;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (adapter === null) return undefined;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    void device.lost.then(() => {
      pending = undefined;
    });
    const info = adapter.info;
    const adapterName = [info.vendor, info.architecture, info.description].filter((part) => part !== undefined && part.length > 0).join(" ") || "WebGPU adapter";
    return { device, adapterName };
  })().catch(() => undefined);
  return pending;
}

/** A storage buffer holding `data`, padded to a whole number of 32-bit words. */
export function storageBuffer(device: GPUDevice, data: ArrayBufferView, extraUsage = 0): GPUBuffer {
  const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
  const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extraUsage, mappedAtCreation: true });
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buffer.unmap();
  return buffer;
}

/** An empty storage buffer of `bytes`, optionally filled with one 32-bit value. */
export function emptyBuffer(device: GPUDevice, bytes: number, fill?: number): GPUBuffer {
  const size = Math.max(4, Math.ceil(bytes / 4) * 4);
  const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, mappedAtCreation: fill !== undefined });
  if (fill !== undefined) {
    new Uint32Array(buffer.getMappedRange()).fill(fill);
    buffer.unmap();
  }
  return buffer;
}

export function uniformBuffer(device: GPUDevice, data: ArrayBuffer): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/**
 * Surfaces errors from the work recorded since `device.pushErrorScope("validation")`.
 * WebGPU reports a shader that fails to compile or a bad dispatch without
 * throwing - the work is simply skipped - so every kernel checks, and a failure
 * sends the caller back to the CPU instead of returning an empty answer.
 */
export async function throwOnGpuError(device: GPUDevice): Promise<void> {
  const error = await device.popErrorScope();
  if (error !== null) throw new Error(`GPU validation failed: ${error.message}`);
}

/** Copies a buffer back to the CPU. */
export async function readBack(device: GPUDevice, source: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
  const size = Math.max(4, Math.ceil(bytes / 4) * 4);
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, staging, 0, size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0, bytes);
  staging.unmap();
  staging.destroy();
  return copy;
}

const pipelines = new WeakMap<GPUDevice, Map<string, GPUComputePipeline>>();

/** A compute pipeline for a WGSL module, built once per device. */
export function computePipeline(device: GPUDevice, code: string, entryPoint = "main"): GPUComputePipeline {
  let cache = pipelines.get(device);
  if (cache === undefined) {
    cache = new Map();
    pipelines.set(device, cache);
  }
  const key = `${entryPoint}\n${code}`;
  let pipeline = cache.get(key);
  if (pipeline === undefined) {
    pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint } });
    cache.set(key, pipeline);
  }
  return pipeline;
}

export const workgroupSize = 256;
const maxGroups = 65_535;

/**
 * Workgroup counts for `items` threads of {@link workgroupSize}. Past
 * 65,535 groups in one dimension the dispatch wraps into a second, and
 * kernels recover the flat index with {@link flatIndexWgsl}.
 */
export function dispatchSize(items: number): [number, number] {
  const groups = Math.max(1, Math.ceil(items / workgroupSize));
  return groups <= maxGroups ? [groups, 1] : [maxGroups, Math.ceil(groups / maxGroups)];
}

/** WGSL for the flat thread index of a dispatch sized by {@link dispatchSize}. */
export const flatIndexWgsl = `fn flatIndex(id: vec3<u32>) -> u32 { return id.x + id.y * ${maxGroups * workgroupSize}u; }`;

/** Runs one compute pass of `pipeline` over `items` threads with the given bindings. */
export function runPass(encoder: GPUCommandEncoder, device: GPUDevice, pipeline: GPUComputePipeline, buffers: readonly GPUBuffer[], items: number): void {
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  const [x, y] = dispatchSize(items);
  pass.dispatchWorkgroups(x, y);
  pass.end();
}
