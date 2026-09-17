import type { PointCloud } from "../core/point-cloud.js";
import { viewerConfig } from "../config.js";
import { readPly } from "./ply-file-importer.js";
import { readLasHeader, minimumLasHeaderSize } from "./las-header.js";
import { readLasPoints } from "./las-reader.js";
import { readLazPoints } from "./laz-reader.js";
import { blobSource, type ByteSource } from "./byte-source.js";

/** Extensions offered in the file picker, in the order a user is likely to meet them. */
export const supportedScanExtensions = [".las", ".laz", ".ply"] as const;

/**
 * Reads a local scan into the core's point-cloud contract.
 *
 * Format is decided by the file's own leading bytes rather than its
 * extension, because `.laz` and `.las` are routinely used interchangeably by
 * the tools that write them, and a compressed file carries the same header as
 * an uncompressed one. The extension is only used to reject files the reader
 * has no chance with before spending time on them.
 */
export async function importScanFile(file: File): Promise<PointCloud> {
  const lowerName = file.name.toLowerCase();
  if (!supportedScanExtensions.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(`Select a ${supportedScanExtensions.join(", ")} point-cloud file`);
  }
  if (file.size === 0) throw new Error("The selected file is empty");

  const maxImportSizeMb = viewerConfig().maxImportSizeMb;
  if (file.size > maxImportSizeMb * 1024 * 1024) {
    throw new Error(`This build reads scans up to ${maxImportSizeMb} MB. Larger scans need the planned streaming pipeline.`);
  }

  const name = file.name.replace(/\.(las|laz|ply)$/i, "");
  return importScan(blobSource(file), name);
}

/** Bytes read up front: enough for any LAS header and a PLY header. */
const leadingBytes = 64 * 1024;

/** Format dispatch, separated from the File plumbing so it can be exercised directly. */
export async function importScan(source: ByteSource, name: string, onProgress?: (fraction: number) => void): Promise<PointCloud> {
  const leading = (await source.read(0, leadingBytes)).slice();
  if (leading.byteLength >= minimumLasHeaderSize) {
    const header = readLasHeader(leading.buffer);
    if (header !== undefined) {
      return header.isCompressed ? readLazPoints(source, header, name, onProgress) : readLasPoints(source, header, name, onProgress);
    }
  }
  if (looksLikePly(leading)) return readPly(source, name, onProgress);
  throw new Error("That file is not a readable LAS, LAZ or PLY point cloud");
}

function looksLikePly(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79;
}
