import { readPly } from "./ply-file-importer.js";
import { readLasHeader, minimumLasHeaderSize } from "./las-header.js";
import { readLasPoints } from "./las-reader.js";
import { readLazPoints } from "./laz-reader.js";
import type { ByteSource } from "./byte-source.js";
import { plyVertexCount } from "./binary-ply-reader.js";
import { keepEveryFor, type ImportedScan, type ReadProgress } from "./read-options.js";

export interface ScanImportOptions {
  readonly onProgress?: ReadProgress | undefined;
  /**
   * The most points to load. A scan with more is thinned evenly to fit,
   * rather than exhausting the tab's memory partway through.
   */
  readonly maxPoints?: number | undefined;
}

/** Extensions offered in the file picker, in the order a user is likely to meet them. */
export const supportedScanExtensions = [".las", ".laz", ".ply"] as const;

/** Rejects a file no reader could take, before any work is spent on it. */
export function validateScanFile(file: File): void {
  const lowerName = file.name.toLowerCase();
  if (!supportedScanExtensions.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(`Select a ${supportedScanExtensions.join(", ")} point-cloud file`);
  }
  if (file.size === 0) throw new Error("The selected file is empty");
}

/** The name a scan is shown and exported under: its file name without the extension. */
export function scanName(file: File): string {
  return file.name.replace(/\.(las|laz|ply)$/i, "");
}

/** Bytes read up front: enough for any LAS header and a PLY header. */
const leadingBytes = 64 * 1024;

/**
 * Reads a scan into the core's point-cloud contract. Format is decided by the
 * file's own leading bytes rather than its extension, because `.laz` and
 * `.las` are routinely used interchangeably by the tools that write them.
 */
export async function importScan(source: ByteSource, name: string, options: ScanImportOptions = {}): Promise<ImportedScan> {
  const { onProgress, maxPoints } = options;
  const leading = (await source.read(0, leadingBytes)).slice();
  if (leading.byteLength >= minimumLasHeaderSize) {
    const header = readLasHeader(leading.buffer);
    if (header !== undefined) {
      // A truncated file holds fewer records than its header declares.
      const sourcePointCount = header.isCompressed
        ? header.pointCount
        : Math.max(0, Math.min(header.pointCount, Math.floor((source.size - header.pointDataOffset) / header.pointLength)));
      const readOptions = { onProgress, keepEvery: keepEveryFor(sourcePointCount, maxPoints) };
      const cloud = header.isCompressed
        ? await readLazPoints(source, header, name, readOptions)
        : await readLasPoints(source, header, name, readOptions);
      return { cloud, sourcePointCount };
    }
  }
  if (looksLikePly(leading)) {
    const sourcePointCount = plyVertexCount(leading) ?? 0;
    const cloud = await readPly(source, name, { onProgress, keepEvery: keepEveryFor(sourcePointCount, maxPoints) });
    return { cloud, sourcePointCount: Math.max(sourcePointCount, cloud.pointCount) };
  }
  throw new Error("That file is not a readable LAS, LAZ or PLY point cloud");
}

function looksLikePly(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79;
}
