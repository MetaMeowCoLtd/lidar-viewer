import type { PointCloud } from "./point-cloud.js";
import type { TerrainModel, TerrainOptions } from "./terrain.js";
import type { ContourSet } from "./contours.js";
import type { TerrainMessage, TerrainRequest } from "./terrain-protocol.js";

export interface TerrainResult {
  readonly model: TerrainModel;
  readonly contours: ContourSet;
}

export interface TerrainJob {
  readonly result: Promise<TerrainResult>;
  /** Stops the work at once. The result promise rejects with {@link TerrainCancelled}. */
  cancel(): void;
}

export class TerrainCancelled extends Error {
  public constructor() {
    super("Building the terrain was cancelled");
    this.name = "TerrainCancelled";
  }
}

/**
 * Builds a cloud's terrain model and its contour lines on a worker of its own.
 *
 * As with the other analyses, the cloud's positions and classes are copied
 * rather than transferred so it stays drawable, and the worker is terminated
 * the moment the job settles or is cancelled.
 */
export function startTerrainBuild(
  cloud: PointCloud,
  options: TerrainOptions,
  onProgress?: (stage: string, fraction: number) => void,
): TerrainJob {
  let cancel: () => void = () => undefined;

  const result = new Promise<TerrainResult>((resolve, reject) => {
    const classification = cloud.classification;
    if (classification === undefined) throw new Error("This scan has no classes to find ground in. Detect ground first.");
    const worker = new Worker(new URL("./terrain-worker.ts", import.meta.url), { type: "module" });
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
      if (settle()) reject(new TerrainCancelled());
    };
    worker.onmessage = (event: MessageEvent<TerrainMessage>) => {
      const message = event.data;
      if (message.kind === "progress") {
        if (!settled) onProgress?.(message.stage, message.fraction);
        return;
      }
      if (!settle()) return;
      if (message.kind === "done") resolve({ model: message.model, contours: message.contours });
      else reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      if (settle()) reject(new Error(event.message || "The terrain worker stopped unexpectedly"));
    };

    const request: TerrainRequest = {
      positions: cloud.positions,
      bounds: cloud.bounds,
      classification,
      originY: cloud.origin[1],
      options,
    };
    worker.postMessage(request);
  });

  return { result, cancel: () => cancel() };
}
