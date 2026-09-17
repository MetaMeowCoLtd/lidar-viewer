import {
  isSpatialReferenceRecord,
  spatialReferenceFromRecords,
  type SpatialReference,
  type SpatialReferenceRecord,
} from "../core/spatial-reference.js";
import type { ByteSource } from "./byte-source.js";
import type { LasHeader } from "./las-header.js";

/** A variable-length record header: reserved, user id, record id, u16 length, description. */
export const recordHeaderSize = 54;
/** LAS 1.4's extended record header widens the length to 64 bits. */
export const extendedRecordHeaderSize = 60;
/** Larger record blocks than this are not coordinate systems, and are skipped rather than read. */
const maxRecordBytes = 64 * 1024 * 1024;

/**
 * Collects the coordinate-system records of a LAS or LAZ file.
 *
 * They live in the variable-length records between the header and the points,
 * or - in LAS 1.4, where a WKT definition can outgrow a 16-bit length - in the
 * extended records after the points. Both are uncompressed in LAZ as well, so
 * this needs no decompression, and only those bytes are read, never the points
 * around them. A record that runs past the end of the file ends the walk
 * rather than failing the load: the points are still good.
 */
export async function readLasSpatialReference(source: ByteSource, header: LasHeader): Promise<SpatialReference | undefined> {
  const records: SpatialReferenceRecord[] = [];

  const blockEnd = Math.min(source.size, header.pointDataOffset);
  const blockLength = blockEnd - header.headerSize;
  if (header.recordCount > 0 && blockLength > 0 && blockLength <= maxRecordBytes) {
    const block = await source.read(header.headerSize, blockLength);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    let base = 0;
    for (let record = 0; record < header.recordCount; record += 1) {
      if (base + recordHeaderSize > block.byteLength) break;
      const length = view.getUint16(base + 20, true);
      const start = base + recordHeaderSize;
      if (start + length > block.byteLength) break;
      const userId = readText(block, base + 2, 16);
      const recordId = view.getUint16(base + 18, true);
      if (isSpatialReferenceRecord(userId, recordId)) {
        records.push({
          userId,
          recordId,
          description: readText(block, base + 22, 32),
          // Copied, so the record does not keep the block it was read from alive.
          data: block.slice(start, start + length),
        });
      }
      base = start + length;
    }
  }

  let base = header.extendedRecordOffset;
  for (let record = 0; base > 0 && record < header.extendedRecordCount; record += 1) {
    if (base + extendedRecordHeaderSize > source.size) break;
    const recordHeader = await source.read(base, extendedRecordHeaderSize);
    const view = new DataView(recordHeader.buffer, recordHeader.byteOffset, recordHeader.byteLength);
    const length = Number(view.getBigUint64(20, true));
    const start = base + extendedRecordHeaderSize;
    if (start + length > source.size) break;
    const userId = readText(recordHeader, 2, 16);
    const recordId = view.getUint16(18, true);
    if (isSpatialReferenceRecord(userId, recordId) && length <= maxRecordBytes) {
      records.push({
        userId,
        recordId,
        description: readText(recordHeader, 28, 32),
        data: (await source.read(start, length)).slice(),
      });
    }
    base = start + length;
  }

  return spatialReferenceFromRecords(records);
}

function readText(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return String.fromCharCode(...(end === -1 ? field : field.subarray(0, end)));
}
