import type { PointCloud } from "../core/point-cloud.js";
import { viewerConfig } from "../config.js";
import { parsePlyBuffer } from "./ply-file-importer.js";
import { readLasHeader, minimumLasHeaderSize } from "./las-header.js";
import { readLasPoints } from "./las-reader.js";
import { readLazPoints } from "./laz-reader.js";

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
  const buffer = await file.arrayBuffer();
  return parseScanBuffer(buffer, name);
}

/** Format dispatch, separated from the File plumbing so it can be exercised directly. */
export async function parseScanBuffer(buffer: ArrayBuffer, name: string): Promise<PointCloud> {
  if (buffer.byteLength >= minimumLasHeaderSize) {
    const header = readLasHeader(buffer);
    if (header !== undefined) {
      return header.isCompressed ? readLazPoints(buffer, header, name) : readLasPoints(buffer, header, name);
    }
  }
  if (looksLikePly(buffer)) return parsePlyBuffer(buffer, name);
  throw new Error("That file is not a readable LAS, LAZ or PLY point cloud");
}

function looksLikePly(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 3) return false;
  const magic = new Uint8Array(buffer, 0, 3);
  return magic[0] === 0x70 && magic[1] === 0x6c && magic[2] === 0x79;
}
