/// <reference types="@webgpu/types" />
import type { GroundDetectionOptions, GroundPreparation } from "../core/ground-detection.js";
import { computePipeline, emptyBuffer, flatIndexWgsl, readBack, runPass, storageBuffer, throwOnGpuError, uniformBuffer, workgroupSize, type GpuContext } from "./gpu-context.js";

/**
 * A running minimum or maximum along every line of the grid, over a window of
 * `radius` cells each way. Lines are extended past their ends along the slope
 * of their last `radius` cells, exactly as the CPU filter pads them, so a
 * tilted plane opens to itself at the edges on both paths.
 */
const lineShader = /* wgsl */ `
struct Line {
  lineCount: u32,
  lineLength: u32,
  lineStride: u32,
  step: u32,
  radius: u32,
  takeMinimum: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> line: Line;
@group(0) @binding(1) var<storage, read> lineIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> lineOut: array<f32>;

${flatIndexWgsl}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = flatIndex(id);
  if (index >= line.lineCount * line.lineLength) { return; }
  let lineIndex = index / line.lineLength;
  let k = i32(index % line.lineLength);
  let start = lineIndex * line.lineStride;
  let length = i32(line.lineLength);
  let radius = i32(line.radius);
  let reach = min(radius, length - 1);
  let first = lineIn[start];
  let last = lineIn[start + u32(length - 1) * line.step];
  var headSlope = 0.0;
  var tailSlope = 0.0;
  if (reach > 0) {
    headSlope = (first - lineIn[start + u32(reach) * line.step]) / f32(reach);
    tailSlope = (last - lineIn[start + u32(length - 1 - reach) * line.step]) / f32(reach);
  }
  var best = select(-3.0e38, 3.0e38, line.takeMinimum == 1u);
  for (var j = -radius; j <= radius; j++) {
    let p = k + j;
    var value: f32;
    if (p < 0) {
      value = first + headSlope * f32(-p);
    } else if (p >= length) {
      value = last + tailSlope * f32(p - length + 1);
    } else {
      value = lineIn[start + u32(p) * line.step];
    }
    best = select(max(best, value), min(best, value), line.takeMinimum == 1u);
  }
  lineOut[start + u32(k) * line.step] = best;
}
`;

/** Clamps the opening to the surface it opened, marks what it shaved off, and carries it on to the next radius. */
const finishShader = /* wgsl */ `
struct Finish {
  cells: u32,
  threshold: f32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> finish: Finish;
@group(0) @binding(1) var<storage, read_write> previous: array<f32>;
@group(0) @binding(2) var<storage, read_write> opened: array<f32>;
@group(0) @binding(3) var<storage, read_write> isObject: array<u32>;

${flatIndexWgsl}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = flatIndex(id);
  if (cell >= finish.cells) { return; }
  let before = previous[cell];
  let after = min(opened[cell], before);
  if (before - after > finish.threshold) { isObject[cell] = 1u; }
  previous[cell] = after;
}
`;

function lineParams(lineCount: number, lineLength: number, lineStride: number, step: number, radius: number, takeMinimum: boolean): ArrayBuffer {
  return new Uint32Array([lineCount, lineLength, lineStride, step, radius, takeMinimum ? 1 : 0, 0, 0]).buffer;
}

/**
 * The costly middle stage of ground detection on the GPU: the surface opened
 * at every radius up to the largest window, each opening four separable
 * passes plus one to mark what it removed, all recorded into one submission.
 * Returns the same object mask as {@link markObjects}.
 */
export async function gpuMarkObjects(context: GpuContext, prepared: GroundPreparation, options: GroundDetectionOptions): Promise<Uint8Array> {
  const { device } = context;
  const { grid, lowest, maxRadius } = prepared;
  const { cols, rows, cellSize } = grid;
  const cells = cols * rows;
  device.pushErrorScope("validation");
  const lines = computePipeline(device, lineShader);
  const finish = computePipeline(device, finishShader);

  const previous = storageBuffer(device, lowest);
  const scratch = emptyBuffer(device, cells * 4);
  const eroded = emptyBuffer(device, cells * 4);
  const opened = emptyBuffer(device, cells * 4);
  const mask = emptyBuffer(device, cells * 4, 0);
  const uniforms: GPUBuffer[] = [];
  const uniform = (data: ArrayBuffer) => {
    const buffer = uniformBuffer(device, data);
    uniforms.push(buffer);
    return buffer;
  };

  const encoder = device.createCommandEncoder();
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    // Along rows, then along columns: erosion, then dilation.
    runPass(encoder, device, lines, [uniform(lineParams(rows, cols, cols, 1, radius, true)), previous, scratch], cells);
    runPass(encoder, device, lines, [uniform(lineParams(cols, rows, 1, cols, radius, true)), scratch, eroded], cells);
    runPass(encoder, device, lines, [uniform(lineParams(rows, cols, cols, 1, radius, false)), eroded, scratch], cells);
    runPass(encoder, device, lines, [uniform(lineParams(cols, rows, 1, cols, radius, false)), scratch, opened], cells);
    const finishParams = new ArrayBuffer(16);
    new Uint32Array(finishParams, 0, 1)[0] = cells;
    new Float32Array(finishParams, 4, 1)[0] = options.slope * radius * cellSize;
    runPass(encoder, device, finish, [uniform(finishParams), previous, opened, mask], cells);
  }
  device.queue.submit([encoder.finish()]);
  await throwOnGpuError(device);
  const flags = new Uint32Array(await readBack(device, mask, cells * 4));
  for (const buffer of [previous, scratch, eroded, opened, mask, ...uniforms]) buffer.destroy();
  const isObject = new Uint8Array(cells);
  for (let cell = 0; cell < cells; cell += 1) isObject[cell] = flags[cell]!;
  return isObject;
}
