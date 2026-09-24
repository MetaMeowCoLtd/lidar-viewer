import { toMapCoordinates, type PointCloud } from "../core/point-cloud.js";
import { ogcWktRecordId, type SpatialReferenceRecord } from "../core/spatial-reference.js";

/**
 * Writes a cloud back out as an uncompressed LAS 1.4 file, carrying whatever
 * the viewer has learned about it: the classes, heights above ground and
 * object ids from ground detection and counting, alongside the coordinates,
 * intensity, returns and colour it was loaded with.
 *
 * Point format 6 is used, or 7 when the cloud has colour. They are the first
 * formats with a full byte of classification and room for fifteen returns, so
 * nothing a LAS 1.4 source carried is squeezed on the way out. Height above
 * ground and object id have no standard field and go in as extra bytes, each
 * described in an extra-bytes record so PDAL, LAStools, CloudCompare and laspy
 * read them back as named dimensions.
 *
 * LAZ is not offered: the laz-perf build the viewer loads can decompress but
 * not compress.
 *
 * The output is a list of chunks rather than one buffer, so a file of several
 * hundred megabytes never has to exist as a single contiguous allocation
 * before the browser streams it to disk.
 */
export interface LasExportOptions {
  /** Stamped into the header's creation date. Defaults to now. */
  readonly createdAt?: Date;
  /** Points per chunk of output. */
  readonly chunkPoints?: number;
}

export const lasPublicHeaderSize = 375;
const recordHeaderSize = 54;
const extraBytesDescriptorSize = 192;
const extraBytesRecordId = 4;

/** Extra-bytes data type codes from the LAS 1.4 specification. */
const extraBytesType = { uint32: 5, float32: 9 } as const;

interface ExtraDimension {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  readonly size: number;
  readonly write: (view: DataView, at: number, point: number) => void;
}

export function writeLas(cloud: PointCloud, options: LasExportOptions = {}): Uint8Array[] {
  const { createdAt = new Date(), chunkPoints = 1 << 20 } = options;
  const pointCount = cloud.pointCount;
  const hasColor = cloud.colors !== undefined;
  const pointFormat = hasColor ? 7 : 6;
  const standardLength = hasColor ? 36 : 30;

  const extras: ExtraDimension[] = [];
  const heightAboveGround = cloud.heightAboveGround;
  if (heightAboveGround !== undefined) {
    extras.push({
      name: "HeightAboveGround",
      description: "Height above detected ground",
      type: extraBytesType.float32,
      size: 4,
      write: (view, at, point) => view.setFloat32(at, heightAboveGround[point]!, true),
    });
  }
  const objectId = cloud.objectId;
  if (objectId !== undefined) {
    extras.push({
      name: "ObjectId",
      description: "Building or tree id; 0 for none",
      type: extraBytesType.uint32,
      size: 4,
      write: (view, at, point) => view.setUint32(at, objectId[point]!, true),
    });
  }
  const recordLength = standardLength + extras.reduce((sum, extra) => sum + extra.size, 0);

  // Records: the source's CRS records verbatim, then the extra-bytes descriptors.
  const crsRecords = cloud.spatialReference?.records ?? [];
  const records: { userId: string; recordId: number; description: string; data: Uint8Array }[] = crsRecords
    // A VLR's length field is 16 bits; a longer definition could only have come from an extended record.
    .filter((record) => record.data.byteLength <= 0xffff)
    .map((record: SpatialReferenceRecord) => ({ ...record }));
  if (extras.length > 0) records.push(extraBytesRecord(extras));
  const recordsSize = records.reduce((sum, record) => sum + recordHeaderSize + record.data.byteLength, 0);
  const pointDataOffset = lasPublicHeaderSize + recordsSize;

  const frame = lasFrame(cloud);
  const intensityScale = intensityScaleFor(cloud.intensity);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const pointsByReturn = new Float64Array(15);

  const chunks: Uint8Array[] = [];
  for (let first = 0; first < pointCount; first += chunkPoints) {
    const last = Math.min(pointCount, first + chunkPoints);
    const chunk = new Uint8Array((last - first) * recordLength);
    const view = new DataView(chunk.buffer);
    for (let point = first, base = 0; point < last; point += 1, base += recordLength) {
      const offset = point * 3;
      // Viewer axes (x east, y up, z south) back to LAS axes (x east, y north, z up).
      const local = [cloud.positions[offset]!, -cloud.positions[offset + 2]!, cloud.positions[offset + 1]!];
      for (let axis = 0; axis < 3; axis += 1) {
        const stored = Math.round(local[axis]! / frame.scale[axis]!);
        view.setInt32(base + axis * 4, stored, true);
        const world = frame.offset[axis]! + stored * frame.scale[axis]!;
        if (world < min[axis]!) min[axis] = world;
        if (world > max[axis]!) max[axis] = world;
      }

      if (cloud.intensity !== undefined) {
        view.setUint16(base + 12, clamp(Math.round(cloud.intensity[point]! * intensityScale), 0, 0xffff), true);
      }
      const returnNumber = clamp(cloud.returnNumber?.[point] ?? 1, 0, 15);
      const numberOfReturns = clamp(cloud.numberOfReturns?.[point] ?? 1, 0, 15);
      view.setUint8(base + 14, returnNumber | (numberOfReturns << 4));
      if (returnNumber >= 1) pointsByReturn[returnNumber - 1] = pointsByReturn[returnNumber - 1]! + 1;
      view.setUint8(base + 16, cloud.classification?.[point] ?? 0);
      if (cloud.pointSourceId !== undefined) view.setUint16(base + 20, cloud.pointSourceId[point]!, true);

      if (cloud.colors !== undefined) {
        // Colour was narrowed to 8 bits on import; LAS stores 16, and 257 maps 255 to 65535 exactly.
        view.setUint16(base + 30, cloud.colors[offset]! * 257, true);
        view.setUint16(base + 32, cloud.colors[offset + 1]! * 257, true);
        view.setUint16(base + 34, cloud.colors[offset + 2]! * 257, true);
      }

      let at = base + standardLength;
      for (const extra of extras) {
        extra.write(view, at, point);
        at += extra.size;
      }
    }
    chunks.push(chunk);
  }

  const head = new Uint8Array(pointDataOffset);
  const view = new DataView(head.buffer);
  writeText(head, 0, "LASF", 4);
  // Bit 4 marks the CRS as WKT, which format 6 and up require. A source that
  // only carried GeoTIFF keys has them passed through unchanged; the major
  // readers still honour them.
  const hasWkt = records.some((record) => record.recordId === ogcWktRecordId);
  view.setUint16(6, hasWkt ? 1 << 4 : 0, true);
  view.setUint8(24, 1);
  view.setUint8(25, 4);
  writeText(head, 26, "OTHER", 32);
  writeText(head, 58, "Vertex LiDAR", 32);
  view.setUint16(90, dayOfYear(createdAt), true);
  view.setUint16(92, createdAt.getUTCFullYear(), true);
  view.setUint16(94, lasPublicHeaderSize, true);
  view.setUint32(96, pointDataOffset, true);
  view.setUint32(100, records.length, true);
  view.setUint8(104, pointFormat);
  view.setUint16(105, recordLength, true);
  // The legacy 32-bit counts must be zero for formats 6 and up; the 64-bit ones below are authoritative.
  for (let axis = 0; axis < 3; axis += 1) {
    view.setFloat64(131 + axis * 8, frame.scale[axis]!, true);
    view.setFloat64(155 + axis * 8, frame.offset[axis]!, true);
    view.setFloat64(179 + axis * 16, max[axis]!, true);
    view.setFloat64(187 + axis * 16, min[axis]!, true);
  }
  view.setBigUint64(247, BigInt(pointCount), true);
  pointsByReturn.forEach((count, index) => view.setBigUint64(255 + index * 8, BigInt(count), true));

  let base = lasPublicHeaderSize;
  for (const record of records) {
    writeText(head, base + 2, record.userId, 16);
    view.setUint16(base + 18, record.recordId, true);
    view.setUint16(base + 20, record.data.byteLength, true);
    writeText(head, base + 22, record.description, 32);
    head.set(record.data, base + recordHeaderSize);
    base += recordHeaderSize + record.data.byteLength;
  }

  return [head, ...chunks];
}

/**
 * The scale and offset stored coordinates are quantised against, in LAS axes.
 *
 * The offset is the cloud's own local origin, so a stored integer is simply
 * the local coordinate divided by the scale and no precision is spent on the
 * scan's distance from the projection's origin. The scale is a millimetre
 * unless the scan is so wide that a millimetre step would overflow a 32-bit
 * integer, in which case it coarsens by factors of ten.
 */
export function lasFrame(cloud: PointCloud): { scale: [number, number, number]; offset: [number, number, number] } {
  const { min, max } = cloud.bounds;
  const reach = [
    Math.max(Math.abs(min[0]), Math.abs(max[0])),
    Math.max(Math.abs(min[2]), Math.abs(max[2])),
    Math.max(Math.abs(min[1]), Math.abs(max[1])),
  ];
  const scale = reach.map((extent) => {
    let step = 0.001;
    while (extent / step > 2_000_000_000) step *= 10;
    return step;
  }) as [number, number, number];
  return { scale, offset: toMapCoordinates(cloud.origin, 0, 0, 0) };
}

/**
 * LAS intensity is a 16-bit integer. Scans loaded from LAS already hold raw
 * values; a PLY may hold intensity normalised to one, which is stretched to
 * the full range rather than rounded to nothing.
 */
function intensityScaleFor(intensity: Float32Array | undefined): number {
  if (intensity === undefined) return 1;
  let maximum = 0;
  for (let index = 0; index < intensity.length; index += 1) {
    if (intensity[index]! > maximum) maximum = intensity[index]!;
  }
  return maximum > 0 && maximum <= 1 ? 0xffff : 1;
}

function extraBytesRecord(extras: readonly ExtraDimension[]) {
  const data = new Uint8Array(extras.length * extraBytesDescriptorSize);
  extras.forEach((extra, index) => {
    const base = index * extraBytesDescriptorSize;
    data[base + 2] = extra.type;
    writeText(data, base + 4, extra.name, 32);
    writeText(data, base + 160, extra.description, 32);
  });
  return { userId: "LASF_Spec", recordId: extraBytesRecordId, description: "Extra bytes", data };
}

function writeText(target: Uint8Array, at: number, text: string, width: number): void {
  for (let index = 0; index < Math.min(text.length, width); index += 1) {
    target[at + index] = text.charCodeAt(index) & 0x7f;
  }
}

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86_400_000) + 1;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
