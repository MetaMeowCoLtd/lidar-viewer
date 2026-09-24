/// <reference types="@webgpu/types" />
import type { PointCloudBounds } from "../core/point-cloud.js";
import { computePipeline, emptyBuffer, flatIndexWgsl, readBack, runPass, storageBuffer, throwOnGpuError, uniformBuffer, workgroupSize, type GpuContext } from "./gpu-context.js";

const empty = 0xffffffff;
/**
 * In-voxel offsets are summed as integers in 1/4096ths of a voxel, rounded:
 * WGSL has no float atomics. That is a tenth of a millimetre at 0.5 m voxels,
 * and a voxel can hold a million points before the sum overflows.
 */
const fixedScale = 4096;

const common = /* wgsl */ `
struct Params {
  pointCount: u32,
  cols: u32,
  rows: u32,
  tableMask: u32,
  minX: f32,
  minY: f32,
  minZ: f32,
  voxelSize: f32,
}
const EMPTY: u32 = ${empty}u;
const FIXED: f32 = ${fixedScale}.0;
${flatIndexWgsl}
fn hashKey(key: u32) -> u32 {
  var h = key * 2654435761u;
  h = h ^ (h >> 13u);
  h = h * 1274126177u;
  return h ^ (h >> 16u);
}
`;

const accumulateShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> positions: array<f32>;
@group(0) @binding(2) var<storage, read> colors: array<u32>;
@group(0) @binding(3) var<storage, read_write> keys: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> sums: array<atomic<u32>>;

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let point = flatIndex(id);
  if (point >= params.pointCount) { return; }
  let p = vec3<f32>(positions[point * 3u] - params.minX, positions[point * 3u + 1u] - params.minY, positions[point * 3u + 2u] - params.minZ) / params.voxelSize;
  let cell = floor(p);
  let key = u32(cell.x) + params.cols * (u32(cell.y) + params.rows * u32(cell.z));
  var slot = hashKey(key) & params.tableMask;
  loop {
    let result = atomicCompareExchangeWeak(&keys[slot], EMPTY, key);
    if (result.exchanged || result.old_value == key) { break; }
    // A weak exchange can fail on an empty slot; only a slot taken by another voxel moves the probe on.
    if (result.old_value != EMPTY) { slot = (slot + 1u) & params.tableMask; }
  }
  let offset = min(round((p - cell) * FIXED), vec3<f32>(FIXED - 1.0));
  atomicAdd(&counts[slot], 1u);
  atomicAdd(&sums[slot * 6u], u32(offset.x));
  atomicAdd(&sums[slot * 6u + 1u], u32(offset.y));
  atomicAdd(&sums[slot * 6u + 2u], u32(offset.z));
  let colour = colors[point];
  atomicAdd(&sums[slot * 6u + 3u], colour & 255u);
  atomicAdd(&sums[slot * 6u + 4u], (colour >> 8u) & 255u);
  atomicAdd(&sums[slot * 6u + 5u], (colour >> 16u) & 255u);
}
`;

const compactShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> keys: array<u32>;
@group(0) @binding(2) var<storage, read> counts: array<u32>;
@group(0) @binding(3) var<storage, read> sums: array<u32>;
@group(0) @binding(4) var<storage, read_write> outCount: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> outPositions: array<f32>;
@group(0) @binding(6) var<storage, read_write> outColors: array<u32>;

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let slot = flatIndex(id);
  if (slot > params.tableMask) { return; }
  let key = keys[slot];
  if (key == EMPTY) { return; }
  let n = f32(counts[slot]);
  let ix = key % params.cols;
  let iy = (key / params.cols) % params.rows;
  let iz = key / (params.cols * params.rows);
  let at = atomicAdd(&outCount[0], 1u);
  let base = vec3<f32>(f32(ix), f32(iy), f32(iz));
  let offset = vec3<f32>(f32(sums[slot * 6u]), f32(sums[slot * 6u + 1u]), f32(sums[slot * 6u + 2u])) / (n * FIXED);
  let world = (base + offset) * params.voxelSize + vec3<f32>(params.minX, params.minY, params.minZ);
  outPositions[at * 3u] = world.x;
  outPositions[at * 3u + 1u] = world.y;
  outPositions[at * 3u + 2u] = world.z;
  let r = u32(round(f32(sums[slot * 6u + 3u]) / n));
  let g = u32(round(f32(sums[slot * 6u + 4u]) / n));
  let b = u32(round(f32(sums[slot * 6u + 5u]) / n));
  outColors[at] = r | (g << 8u) | (b << 16u);
}
`;

export interface GpuThinned {
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
}

/**
 * Voxel-grid thinning on the GPU: every point averaged into the voxel it falls
 * in, positions and colour, in two passes over an atomic hash table. Voxels
 * come out in no particular order. Throws when the grid cannot be indexed in
 * 32 bits or the table would not fit, so the caller can use the CPU instead.
 */
export async function gpuVoxelThin(context: GpuContext, positions: Float32Array, colors: Uint8Array | undefined, bounds: PointCloudBounds, voxelSize: number): Promise<GpuThinned> {
  const { device } = context;
  const pointCount = positions.length / 3;
  const cols = Math.floor(bounds.size[0] / voxelSize) + 1;
  const rows = Math.floor(bounds.size[1] / voxelSize) + 1;
  const layers = Math.floor(bounds.size[2] / voxelSize) + 1;
  if (cols * rows * layers >= empty) throw new Error("The voxel grid is too fine to index on the GPU");
  let tableSize = 1;
  while (tableSize < Math.min(pointCount, cols * rows * layers) * 2) tableSize *= 2;
  if (tableSize * 6 * 4 > device.limits.maxStorageBufferBindingSize) throw new Error("The voxel table is too large for this GPU");

  const packed = new Uint32Array(pointCount);
  if (colors !== undefined) for (let point = 0; point < pointCount; point += 1) packed[point] = colors[point * 3]! | (colors[point * 3 + 1]! << 8) | (colors[point * 3 + 2]! << 16);

  const params = new ArrayBuffer(32);
  new Uint32Array(params, 0, 4).set([pointCount, cols, rows, tableSize - 1]);
  new Float32Array(params, 16, 4).set([bounds.min[0], bounds.min[1], bounds.min[2], voxelSize]);
  const uniforms = uniformBuffer(device, params);
  const positionBuffer = storageBuffer(device, positions);
  const colorBuffer = storageBuffer(device, packed);
  const keys = emptyBuffer(device, tableSize * 4, empty);
  const counts = emptyBuffer(device, tableSize * 4, 0);
  const sums = emptyBuffer(device, tableSize * 6 * 4, 0);
  const outCount = emptyBuffer(device, 4, 0);
  const outPositions = emptyBuffer(device, Math.min(pointCount, tableSize) * 12);
  const outColors = emptyBuffer(device, Math.min(pointCount, tableSize) * 4);

  device.pushErrorScope("validation");
  const encoder = device.createCommandEncoder();
  runPass(encoder, device, computePipeline(device, accumulateShader), [uniforms, positionBuffer, colorBuffer, keys, counts, sums], pointCount);
  runPass(encoder, device, computePipeline(device, compactShader), [uniforms, keys, counts, sums, outCount, outPositions, outColors], tableSize);
  device.queue.submit([encoder.finish()]);
  await throwOnGpuError(device);

  const voxels = new Uint32Array(await readBack(device, outCount, 4))[0]!;
  const [positionBytes, colorBytes] = await Promise.all([readBack(device, outPositions, voxels * 12), readBack(device, outColors, voxels * 4)]);
  for (const buffer of [uniforms, positionBuffer, colorBuffer, keys, counts, sums, outCount, outPositions, outColors]) buffer.destroy();

  const words = new Uint32Array(colorBytes);
  const outColorsRgb = new Uint8Array(voxels * 3);
  for (let voxel = 0; voxel < voxels; voxel += 1) {
    outColorsRgb[voxel * 3] = words[voxel]! & 255;
    outColorsRgb[voxel * 3 + 1] = (words[voxel]! >> 8) & 255;
    outColorsRgb[voxel * 3 + 2] = (words[voxel]! >> 16) & 255;
  }
  return { positions: new Float32Array(positionBytes), colors: outColorsRgb };
}
