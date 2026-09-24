import type { PointCloud } from "./point-cloud.js";
import type {
  GroundDetectionOptions,
  GroundDetectionProgress,
  GroundDetectionResult,
} from "./ground-detection.js";
import type { GroundDetectionMessage, GroundDetectionRequest } from "./ground-detection-protocol.js";

export interface GroundDetectionJob {
  /** The result, and whether the surface openings ran on the GPU. */
  readonly result: Promise<GroundDetectionResult & { readonly usedGpu: boolean }>;
  /** Stops the work at once. The result promise rejects with {@link GroundDetectionCancelled}. */
  cancel(): void;
}

/** Rejection reason for a job that was cancelled, so callers can tell it apart from a failure. */
export class GroundDetectionCancelled extends Error {
  public constructor() {
    super("Ground detection was cancelled");
    this.name = "GroundDetectionCancelled";
  }
}

/**
 * Runs ground detection for a cloud on its own worker.
 *
 * A dense scan takes seconds, which would freeze the page on the main thread.
 * Positions are copied to the worker rather than transferred, so the cloud
 * stays fully usable - still drawn, still re-tiled if the point budget moves -
 * while its ground is worked out; only the results travel back without a copy.
 *
 * Each job owns its worker and terminates it when it settles, so a cancelled
 * job stops consuming CPU immediately instead of finishing unseen.
 */
export function startGroundDetection(
  cloud: PointCloud,
  options: GroundDetectionOptions,
  onProgress?: GroundDetectionProgress,
  useGpu = false,
): GroundDetectionJob {
  const worker = new Worker(new URL("./ground-detection-worker.ts", import.meta.url), { type: "module" });
  let cancel: () => void = () => undefined;

  const result = new Promise<GroundDetectionResult & { readonly usedGpu: boolean }>((resolve, reject) => {
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
      if (settle()) reject(new GroundDetectionCancelled());
    };
    worker.onmessage = (event: MessageEvent<GroundDetectionMessage>) => {
      const message = event.data;
      if (message.kind === "progress") {
        if (!settled) onProgress?.(message.stage, message.fraction);
        return;
      }
      if (!settle()) return;
      if (message.kind === "done") {
        resolve({ classification: message.classification, heightAboveGround: message.heightAboveGround, stats: message.stats, usedGpu: message.usedGpu });
      } else {
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      if (settle()) reject(new Error(event.message || "The ground detection worker stopped unexpectedly"));
    };

    const request: GroundDetectionRequest = {
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
