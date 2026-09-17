import { PointCloud, boundsFromExtent, chooseOrigin, type PointCloudOrigin } from "../core/point-cloud.js";
import type { ByteSource } from "./byte-source.js";
import type { ReadProgress } from "./las-reader.js";

/** Bytes searched for the end of the header. */
const headerLimit = 64 * 1024;
/** Bytes of vertex records decoded per read. */
const blockBytes = 16 * 1024 * 1024;

interface PlyProperty {
  readonly name: string;
  readonly size: number;
  readonly read: (view: DataView, offset: number) => number;
}

const readers: Record<string, { size: number; read: (view: DataView, offset: number) => number }> = {
  char: { size: 1, read: (v, o) => v.getInt8(o) },
  int8: { size: 1, read: (v, o) => v.getInt8(o) },
  uchar: { size: 1, read: (v, o) => v.getUint8(o) },
  uint8: { size: 1, read: (v, o) => v.getUint8(o) },
  short: { size: 2, read: (v, o) => v.getInt16(o, true) },
  int16: { size: 2, read: (v, o) => v.getInt16(o, true) },
  ushort: { size: 2, read: (v, o) => v.getUint16(o, true) },
  uint16: { size: 2, read: (v, o) => v.getUint16(o, true) },
  int: { size: 4, read: (v, o) => v.getInt32(o, true) },
  int32: { size: 4, read: (v, o) => v.getInt32(o, true) },
  uint: { size: 4, read: (v, o) => v.getUint32(o, true) },
  uint32: { size: 4, read: (v, o) => v.getUint32(o, true) },
  float: { size: 4, read: (v, o) => v.getFloat32(o, true) },
  float32: { size: 4, read: (v, o) => v.getFloat32(o, true) },
  double: { size: 8, read: (v, o) => v.getFloat64(o, true) },
  float64: { size: 8, read: (v, o) => v.getFloat64(o, true) },
};

/**
 * Reads little-endian binary PLY straight into typed arrays. Three's PLYLoader
 * accumulates every scalar into a plain Array first, which caps a load at
 * roughly forty million points; writing into the destination buffers directly
 * removes that ceiling and avoids the intermediate copy. Vertex records are
 * read a block at a time, so the file is never in memory whole. Returns
 * undefined for anything this fast path does not recognise so the caller can
 * fall back.
 *
 * This is also the only place that sees a georeferenced coordinate at full
 * precision, so it is where the cloud's local frame is established.
 */
export async function readBinaryPly(source: ByteSource, name: string, onProgress?: ReadProgress): Promise<PointCloud | undefined> {
  const headerText = new TextDecoder().decode(await source.read(0, headerLimit));
  const terminator = headerText.indexOf("end_header\n");
  if (!headerText.startsWith("ply") || terminator === -1) return undefined;
  if (!/format\s+binary_little_endian/.test(headerText)) return undefined;

  const lines = headerText.slice(0, terminator).split("\n").map((line) => line.trim());
  const properties: PlyProperty[] = [];
  let vertexCount = 0;
  let inVertexElement = false;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === "element") {
      inVertexElement = parts[1] === "vertex";
      if (inVertexElement) vertexCount = Number(parts[2]);
      continue;
    }
    if (parts[0] !== "property" || !inVertexElement) continue;
    if (parts[1] === "list") return undefined;
    const reader = readers[parts[1]!];
    if (reader === undefined) return undefined;
    properties.push({ name: parts[3] ?? parts[2]!, size: reader.size, read: reader.read });
  }
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 1) return undefined;

  const index = (n: string) => properties.findIndex((p) => p.name === n);
  const ix = index("x");
  const iy = index("y");
  const iz = index("z");
  if (ix === -1 || iy === -1 || iz === -1) return undefined;
  const ir = index("red");
  const ig = index("green");
  const ib = index("blue");
  const ii = properties.findIndex((p) => p.name === "intensity" || p.name === "scalar_Intensity");
  // PLY has no notion of a classification field, so exporters invent one.
  // These are the spellings the common desktop tools write.
  const ic = properties.findIndex(
    (p) => p.name === "classification" || p.name === "scalar_Classification" || p.name === "class",
  );

  const offsets: number[] = [];
  let stride = 0;
  for (const property of properties) {
    offsets.push(stride);
    stride += property.size;
  }
  // The header is ASCII, so its character count is its byte count.
  const start = terminator + "end_header\n".length;
  if (source.size - start < vertexCount * stride) return undefined;

  const readX = (view: DataView, base: number) => properties[ix]!.read(view, base + offsets[ix]!);
  const readY = (view: DataView, base: number) => properties[iy]!.read(view, base + offsets[iy]!);
  const readZ = (view: DataView, base: number) => properties[iz]!.read(view, base + offsets[iz]!);

  const origin = await estimateOrigin(source, start, vertexCount, stride, readX, readY, readZ);

  const positions = new Float32Array(vertexCount * 3);
  const hasRgb = ir !== -1 && ig !== -1 && ib !== -1;
  const colors = hasRgb ? new Uint8Array(vertexCount * 3) : undefined;
  const intensity = ii !== -1 ? new Float32Array(vertexCount) : undefined;
  const classification = ic !== -1 ? new Uint8Array(vertexCount) : undefined;
  const colorScale = hasRgb && properties[ir]!.size > 1 ? 1 / 256 : 1;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const recordsPerBlock = Math.max(1, Math.floor(blockBytes / stride));
  let view: DataView<ArrayBufferLike> = new DataView(new ArrayBuffer(0));
  for (let point = 0, base = 0, target = 0; point < vertexCount; point += 1, base += stride, target += 3) {
    if (point % recordsPerBlock === 0) {
      if (point > 0) onProgress?.(point / vertexCount);
      const block = await source.read(start + point * stride, Math.min(recordsPerBlock, vertexCount - point) * stride);
      view = new DataView(block.buffer, block.byteOffset, block.byteLength);
      base = 0;
    }
    // Both operands are still doubles here, so the subtraction happens before
    // anything is narrowed. Assigning into the Float32Array is the only
    // rounding step, and by then the magnitude is local rather than planetary.
    positions[target] = readX(view, base) - origin[0];
    positions[target + 1] = readY(view, base) - origin[1];
    positions[target + 2] = readZ(view, base) - origin[2];

    // Measure what was stored, not what was computed: that rounding can move a
    // coordinate just outside the double it came from, and bounds must bracket
    // their own points for spatial indexing to be sound.
    const x = positions[target]!;
    const y = positions[target + 1]!;
    const z = positions[target + 2]!;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
    if (colors !== undefined) {
      colors[target] = properties[ir]!.read(view, base + offsets[ir]!) * colorScale;
      colors[target + 1] = properties[ig]!.read(view, base + offsets[ig]!) * colorScale;
      colors[target + 2] = properties[ib]!.read(view, base + offsets[ib]!) * colorScale;
    }
    if (intensity !== undefined) {
      intensity[point] = properties[ii]!.read(view, base + offsets[ii]!);
    }
    if (classification !== undefined) {
      classification[point] = properties[ic]!.read(view, base + offsets[ic]!);
    }
  }

  onProgress?.(1);
  return new PointCloud({
    positions,
    ...(colors === undefined ? {} : { colors }),
    ...(intensity === undefined ? {} : { intensity }),
    ...(classification === undefined ? {} : { classification }),
    bounds: boundsFromExtent(min, max),
    origin,
    name,
  });
}

/**
 * Picks the local frame before a single coordinate is narrowed to Float32.
 *
 * The anchor only has to land *near* the cloud - what matters is that local
 * coordinates stay small, and the cloud's own extent already bounds them - so
 * it is estimated from an evenly spaced sample instead of a second full pass
 * over every vertex. On a forty-million-point scan that is a thousand reads
 * rather than a hundred and twenty million.
 */
async function estimateOrigin(
  source: ByteSource,
  start: number,
  vertexCount: number,
  stride: number,
  readX: (view: DataView, base: number) => number,
  readY: (view: DataView, base: number) => number,
  readZ: (view: DataView, base: number) => number,
): Promise<PointCloudOrigin> {
  // Evenly spaced runs of vertices rather than single ones, so a thousand
  // samples cost a few dozen reads.
  const runs = Math.min(32, vertexCount);
  const runLength = Math.max(1, Math.min(32, Math.floor(vertexCount / runs)));
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let run = 0; run < runs; run += 1) {
    const first = Math.floor((run * vertexCount) / runs);
    const block = await source.read(start + first * stride, runLength * stride);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let base = 0; base + stride <= block.byteLength; base += stride) {
      const sample = [readX(view, base), readY(view, base), readZ(view, base)];
      for (let axis = 0; axis < 3; axis += 1) {
        if (sample[axis]! < min[axis]!) min[axis] = sample[axis]!;
        if (sample[axis]! > max[axis]!) max[axis] = sample[axis]!;
      }
    }
  }
  return chooseOrigin(min, max);
}
