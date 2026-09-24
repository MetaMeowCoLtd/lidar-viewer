/// <reference types="@webgpu/types" />
import type { PointCloudBounds } from "../core/point-cloud.js";
import { columnIndex } from "../core/noise-detection.js";
import { computePipeline, emptyBuffer, flatIndexWgsl, readBack, runPass, storageBuffer, throwOnGpuError, uniformBuffer, workgroupSize, type GpuContext } from "./gpu-context.js";

const shader = /* wgsl */ `
struct Params {
  cols: u32,
  rows: u32,
  pointCount: u32,
  minNeighbours: u32,
  minX: f32,
  minZ: f32,
  cellSize: f32,
  radiusSq: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> positions: array<f32>;
@group(0) @binding(2) var<storage, read> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read> order: array<u32>;
@group(0) @binding(4) var<storage, read_write> isolated: array<u32>;

${flatIndexWgsl}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let point = flatIndex(id);
  if (point >= params.pointCount) { return; }
  let p = vec3<f32>(positions[point * 3u], positions[point * 3u + 1u], positions[point * 3u + 2u]);
  let col = i32(clamp(floor((p.x - params.minX) / params.cellSize), 0.0, f32(params.cols - 1u)));
  let row = i32(clamp(floor((p.z - params.minZ) / params.cellSize), 0.0, f32(params.rows - 1u)));
  var neighbours = 0u;
  for (var r = max(row - 1, 0); r <= min(row + 1, i32(params.rows) - 1); r++) {
    for (var c = max(col - 1, 0); c <= min(col + 1, i32(params.cols) - 1); c++) {
      let cell = u32(r) * params.cols + u32(c);
      for (var slot = cellStart[cell]; slot < cellStart[cell + 1u]; slot++) {
        let other = order[slot];
        if (other == point) { continue; }
        let d = vec3<f32>(positions[other * 3u], positions[other * 3u + 1u], positions[other * 3u + 2u]) - p;
        if (dot(d, d) < params.radiusSq) {
          neighbours++;
          if (neighbours >= params.minNeighbours) { break; }
        }
      }
      if (neighbours >= params.minNeighbours) { break; }
    }
    if (neighbours >= params.minNeighbours) { break; }
  }
  isolated[point] = select(0u, 1u, neighbours < params.minNeighbours);
}
`;

export interface GpuTiming {
  /** Building the column index on the CPU. */
  readonly indexMs: number;
  /** Uploading, running and reading back on the GPU. */
  readonly gpuMs: number;
}

/**
 * The radius outlier test on the GPU, one thread per point. The column index
 * is built on the CPU - a counting sort, linear and cheap - and the neighbour
 * search, which is the costly part, runs in parallel.
 */
export async function gpuFindIsolated(
  context: GpuContext,
  positions: Float32Array,
  bounds: PointCloudBounds,
  radius: number,
  minNeighbours: number,
): Promise<{ isolated: Uint8Array; timing: GpuTiming }> {
  const { device } = context;
  const pointCount = positions.length / 3;
  const indexStarted = performance.now();
  const index = columnIndex(positions, bounds, radius);
  const indexMs = performance.now() - indexStarted;

  const gpuStarted = performance.now();
  const params = new ArrayBuffer(32);
  new Uint32Array(params, 0, 4).set([index.cols, index.rows, pointCount, minNeighbours]);
  new Float32Array(params, 16, 4).set([bounds.min[0], bounds.min[2], index.size, radius * radius]);
  const buffers = [
    uniformBuffer(device, params),
    storageBuffer(device, positions),
    storageBuffer(device, new Uint32Array(index.start.buffer, index.start.byteOffset, index.start.length)),
    storageBuffer(device, new Uint32Array(index.order.buffer, index.order.byteOffset, index.order.length)),
    emptyBuffer(device, pointCount * 4),
  ];
  device.pushErrorScope("validation");
  const encoder = device.createCommandEncoder();
  runPass(encoder, device, computePipeline(device, shader), buffers, pointCount);
  device.queue.submit([encoder.finish()]);
  await throwOnGpuError(device);
  const flags = new Uint32Array(await readBack(device, buffers[4]!, pointCount * 4));
  for (const buffer of buffers) buffer.destroy();
  const isolated = new Uint8Array(pointCount);
  for (let point = 0; point < pointCount; point += 1) isolated[point] = flags[point]!;
  return { isolated, timing: { indexMs, gpuMs: performance.now() - gpuStarted } };
}
