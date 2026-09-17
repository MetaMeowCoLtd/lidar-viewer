import type { PointCloud } from "./point-cloud.js";
import type { GroundDetectionOptions } from "./ground-detection.js";
import type { ObjectDetectionOptions, ObjectDetectionProgress } from "./object-detection.js";
import type { ObjectDetectionMessage, ObjectDetectionRequest } from "./object-detection-protocol.js";

export type ObjectDetectionOutcome = Omit<Extract<ObjectDetectionMessage, { kind: "done" }>, "kind">;

export interface ObjectDetectionJob {
  readonly result: Promise<ObjectDetectionOutcome>;
  /** Stops the work at once. The result promise rejects with {@link ObjectDetectionCancelled}. */
  cancel(): void;
}

export class ObjectDetectionCancelled extends Error {
  public constructor() {
    super("Counting buildings and trees was cancelled");
    this.name = "ObjectDetectionCancelled";
  }
}

/**
 * Counts the buildings and trees in a cloud on a worker of its own, running
 * ground detection first when the cloud has no heights to measure against.
 *
 * As with ground detection, the cloud's buffers are copied rather than
 * transferred so it stays drawable throughout, and the worker is terminated the
 * moment the job settles or is cancelled.
 */
export function startObjectDetection(
  cloud: PointCloud,
  groundOptions: GroundDetectionOptions,
  objectOptions: ObjectDetectionOptions,
  onProgress?: ObjectDetectionProgress,
): ObjectDetectionJob {
  const worker = new Worker(new URL("./object-detection-worker.ts", import.meta.url), { type: "module" });
  let cancel: () => void = () => undefined;

  const result = new Promise<ObjectDetectionOutcome>((resolve, reject) => {
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
      if (settle()) reject(new ObjectDetectionCancelled());
    };
    worker.onmessage = (event: MessageEvent<ObjectDetectionMessage>) => {
      const message = event.data;
      if (message.kind === "progress") {
        if (!settled) onProgress?.(message.stage, message.fraction);
        return;
      }
      if (!settle()) return;
      if (message.kind === "failed") {
        reject(new Error(message.message));
        return;
      }
      const { kind: _kind, ...outcome } = message;
      resolve(outcome);
    };
    worker.onerror = (event) => {
      if (settle()) reject(new Error(event.message || "The counting worker stopped unexpectedly"));
    };

    const request: ObjectDetectionRequest = {
      positions: cloud.positions,
      bounds: cloud.bounds,
      ...(cloud.classification === undefined ? {} : { classification: cloud.classification }),
      ...(cloud.heightAboveGround === undefined ? {} : { heightAboveGround: cloud.heightAboveGround }),
      ...(cloud.numberOfReturns === undefined ? {} : { numberOfReturns: cloud.numberOfReturns }),
      groundOptions,
      objectOptions,
    };
    worker.postMessage(request);
  });

  return { result, cancel: () => cancel() };
}
