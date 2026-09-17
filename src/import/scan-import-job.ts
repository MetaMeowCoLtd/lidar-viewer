import { PointCloud, definedChannels } from "../core/point-cloud.js";
import type { ScanImportMessage, ScanImportRequest } from "./scan-import-protocol.js";
import { scanName, validateScanFile } from "./scan-file-importer.js";
import type { ImportedScan } from "./read-options.js";

export interface ScanImportJob {
  readonly result: Promise<ImportedScan>;
  /** Stops reading at once. The result promise rejects with {@link ScanImportCancelled}. */
  cancel(): void;
}

export class ScanImportCancelled extends Error {
  public constructor() {
    super("Reading the scan was cancelled");
    this.name = "ScanImportCancelled";
  }
}

/**
 * Reads a scan file on a worker of its own.
 *
 * Decoding tens of millions of records takes seconds, and on the page's own
 * thread every one of those seconds is a frozen tab: no progress, no
 * scrolling, no way to pick a different file. On a worker the page stays
 * live and can report how far the read has got. The worker is handed the
 * `File` itself - a handle, not its bytes - reads it in slices, and transfers
 * the finished arrays back without copying them. It is terminated the moment
 * the job settles or is cancelled, which also frees everything it was holding.
 */
export function startScanImport(file: File, maxPoints: number, onProgress?: (fraction: number) => void): ScanImportJob {
  let cancel: () => void = () => undefined;

  const result = new Promise<ImportedScan>((resolve, reject) => {
    validateScanFile(file);
    const worker = new Worker(new URL("./scan-import-worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      return true;
    };

    cancel = () => {
      if (settle()) reject(new ScanImportCancelled());
    };
    worker.onmessage = (event: MessageEvent<ScanImportMessage>) => {
      const message = event.data;
      if (message.kind === "progress") {
        if (!settled) onProgress?.(message.fraction);
        return;
      }
      if (!settle()) return;
      if (message.kind === "failed") {
        reject(new Error(message.message));
        return;
      }
      resolve({
        cloud: new PointCloud({
          positions: message.positions,
          ...definedChannels(message),
          bounds: message.bounds,
          origin: message.origin,
          spatialReference: message.spatialReference,
          name: message.name,
        }),
        sourcePointCount: message.sourcePointCount,
      });
    };
    worker.onerror = (event) => {
      // A worker that dies outright - most often by running out of memory
      // while allocating a very large scan - reports no message of its own.
      if (settle()) reject(new Error(event.message || "Reading the scan stopped unexpectedly, most likely for lack of memory"));
    };

    const request: ScanImportRequest = { file, name: scanName(file), maxPoints };
    worker.postMessage(request);
  });

  return { result, cancel: () => cancel() };
}
