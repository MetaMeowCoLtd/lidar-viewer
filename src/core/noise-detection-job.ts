import type { PointCloud } from "./point-cloud.js";
import type { NoiseDetectionOptions, NoiseDetectionProgress, NoiseDetectionResult } from "./noise-detection.js";
import type { NoiseDetectionMessage, NoiseDetectionRequest } from "./noise-detection-protocol.js";

export interface NoiseDetectionJob {
  /** The result, and whether the neighbour search ran on the GPU. */
  readonly result: Promise<NoiseDetectionResult & { readonly usedGpu: boolean }>;
  /** Stops the work at once. The result promise rejects with {@link NoiseDetectionCancelled}. */
  cancel(): void;
}

export class NoiseDetectionCancelled extends Error {
  public constructor() {
    super("Finding noise was cancelled");
    this.name = "NoiseDetectionCancelled";
  }
}

/**
 * Finds a cloud's noise on a worker of its own. As with the other analyses,
 * positions are copied rather than transferred so the cloud stays drawable,
 * and the worker is terminated as soon as the job settles or is cancelled.
 */
export function startNoiseDetection(cloud: PointCloud, options: NoiseDetectionOptions, onProgress?: NoiseDetectionProgress, useGpu = false): NoiseDetectionJob {
  const worker = new Worker(new URL("./noise-detection-worker.ts", import.meta.url), { type: "module" });
  let cancel: () => void = () => undefined;

  const result = new Promise<NoiseDetectionResult & { readonly usedGpu: boolean }>((resolve, reject) => {
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
      if (settle()) reject(new NoiseDetectionCancelled());
    };
    worker.onmessage = (event: MessageEvent<NoiseDetectionMessage>) => {
      const message = event.data;
      if (message.kind === "progress") {
        if (!settled) onProgress?.(message.stage, message.fraction);
        return;
      }
      if (!settle()) return;
      if (message.kind === "done") resolve({ classification: message.classification, stats: message.stats, usedGpu: message.usedGpu });
      else reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      if (settle()) reject(new Error(event.message || "The noise worker stopped unexpectedly"));
    };
    const request: NoiseDetectionRequest = {
      positions: cloud.positions,
      bounds: cloud.bounds,
      ...(cloud.classification === undefined ? {} : { classification: cloud.classification }),
      options,
      useGpu,
    };
    worker.postMessage(request);
  });

  return { result, cancel: () => cancel() };
}
