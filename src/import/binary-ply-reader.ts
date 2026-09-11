import { PointCloud, boundsFromExtent, chooseOrigin, type PointCloudOrigin } from "../core/point-cloud.js";

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
 * removes that ceiling and avoids the intermediate copy. Returns undefined for
 * anything this fast path does not recognise so the caller can fall back.
 *
 * This is also the only place that sees a georeferenced coordinate at full
 * precision, so it is where the cloud's local frame is established.
 */
export function readBinaryPly(buffer: ArrayBuffer, name: string): PointCloud | undefined {
  const headerLimit = Math.min(buffer.byteLength, 64 * 1024);
  const headerText = new TextDecoder().decode(new Uint8Array(buffer, 0, headerLimit));
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

  const offsets: number[] = [];
  let stride = 0;
  for (const property of properties) {
    offsets.push(stride);
    stride += property.size;
  }
  const start = terminator + "end_header\n".length;
  if (buffer.byteLength - start < vertexCount * stride) return undefined;

  const view = new DataView(buffer, start);
  const readX = (base: number) => properties[ix]!.read(view, base + offsets[ix]!);
  const readY = (base: number) => properties[iy]!.read(view, base + offsets[iy]!);
  const readZ = (base: number) => properties[iz]!.read(view, base + offsets[iz]!);

  const origin = estimateOrigin(vertexCount, stride, readX, readY, readZ);

  const positions = new Float32Array(vertexCount * 3);
  const hasRgb = ir !== -1 && ig !== -1 && ib !== -1;
  const colors = hasRgb ? new Uint8Array(vertexCount * 3) : undefined;
  const intensity = ii !== -1 ? new Float32Array(vertexCount) : undefined;
  const colorScale = hasRgb && properties[ir]!.size > 1 ? 1 / 256 : 1;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let point = 0, base = 0, target = 0; point < vertexCount; point += 1, base += stride, target += 3) {
    // Both operands are still doubles here, so the subtraction happens before
    // anything is narrowed. Assigning into the Float32Array is the only
    // rounding step, and by then the magnitude is local rather than planetary.
    const x = readX(base) - origin[0];
    const y = readY(base) - origin[1];
    const z = readZ(base) - origin[2];
    positions[target] = x;
    positions[target + 1] = y;
    positions[target + 2] = z;
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
  }

  return new PointCloud({
    positions,
    ...(colors === undefined ? {} : { colors }),
    ...(intensity === undefined ? {} : { intensity }),
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
function estimateOrigin(
  vertexCount: number,
  stride: number,
  readX: (base: number) => number,
  readY: (base: number) => number,
  readZ: (base: number) => number,
): PointCloudOrigin {
  const step = Math.max(1, Math.floor(vertexCount / 1024));
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let point = 0; point < vertexCount; point += step) {
    const base = point * stride;
    const sample = [readX(base), readY(base), readZ(base)];
    for (let axis = 0; axis < 3; axis += 1) {
      if (sample[axis]! < min[axis]!) min[axis] = sample[axis]!;
      if (sample[axis]! > max[axis]!) max[axis] = sample[axis]!;
    }
  }
  return chooseOrigin(min, max);
}
