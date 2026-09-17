import {
  isSpatialReferenceRecord,
  spatialReferenceFromRecords,
  type SpatialReference,
  type SpatialReferenceRecord,
} from "../core/spatial-reference.js";
import type { LasHeader } from "./las-header.js";

/** A variable-length record header: reserved, user id, record id, u16 length, description. */
export const recordHeaderSize = 54;
/** LAS 1.4's extended record header widens the length to 64 bits. */
export const extendedRecordHeaderSize = 60;

/**
 * Collects the coordinate-system records of a LAS or LAZ file.
 *
 * They live in the variable-length records between the header and the points,
 * or - in LAS 1.4, where a WKT definition can outgrow a 16-bit length - in the
 * extended records after the points. Both are uncompressed in LAZ as well, so
 * this needs no decompression. A record that runs past the end of the buffer
 * ends the walk rather than failing the load: the points are still good.
 */
export function readLasSpatialReference(buffer: ArrayBuffer, header: LasHeader): SpatialReference | undefined {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const records: SpatialReferenceRecord[] = [];

  let base = header.headerSize;
  for (let record = 0; record < header.recordCount; record += 1) {
    if (base + recordHeaderSize > Math.min(buffer.byteLength, header.pointDataOffset)) break;
    const length = view.getUint16(base + 20, true);
    const start = base + recordHeaderSize;
    if (start + length > buffer.byteLength) break;
    collect(records, bytes, view, base, 20, start, length);
    base = start + length;
  }

  if (header.extendedRecordOffset > 0) {
    base = header.extendedRecordOffset;
    for (let record = 0; record < header.extendedRecordCount; record += 1) {
      if (base + extendedRecordHeaderSize > buffer.byteLength) break;
      const length = Number(view.getBigUint64(base + 20, true));
      const start = base + extendedRecordHeaderSize;
      if (start + length > buffer.byteLength) break;
      collect(records, bytes, view, base, 28, start, length);
      base = start + length;
    }
  }

  return spatialReferenceFromRecords(records);
}

function collect(
  records: SpatialReferenceRecord[],
  bytes: Uint8Array,
  view: DataView,
  base: number,
  descriptionOffset: number,
  start: number,
  length: number,
): void {
  const userId = readText(bytes, base + 2, 16);
  const recordId = view.getUint16(base + 18, true);
  if (!isSpatialReferenceRecord(userId, recordId)) return;
  records.push({
    userId,
    recordId,
    description: readText(bytes, base + descriptionOffset, 32),
    // Copied, so the record does not keep the whole file's buffer alive.
    data: bytes.slice(start, start + length),
  });
}

function readText(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return String.fromCharCode(...(end === -1 ? field : field.subarray(0, end)));
}
