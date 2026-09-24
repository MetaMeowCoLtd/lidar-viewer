import { classifyGround, markObjects, prepareGround } from "./ground-detection.js";
import type { GroundDetectionMessage, GroundDetectionRequest } from "./ground-detection-protocol.js";
import { requestGpu } from "../gpu/gpu-context.js";
import { gpuMarkObjects } from "../gpu/ground-openings.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GroundDetectionRequest>) => void) | null;
  postMessage: (message: GroundDetectionMessage, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = async (event: MessageEvent<GroundDetectionRequest>) => {
  const { positions, bounds, classification, options, useGpu } = event.data;
  const progress = (stage: string, fraction: number) => scope.postMessage({ kind: "progress", stage, fraction });
  try {
    const input = { positions, bounds, classification };
    const prepared = prepareGround(input, options, progress);
    // The openings at every window size are the costly stage; on the GPU each is five passes over the grid.
    let isObject: Uint8Array | undefined;
    if (useGpu === true) {
      try {
        const gpu = await requestGpu();
        if (gpu !== undefined) {
          progress("Filtering out buildings and vegetation on the GPU", 0.1);
          isObject = await gpuMarkObjects(gpu, prepared, options);
        }
      } catch {
        isObject = undefined;
      }
    }
    const usedGpu = isObject !== undefined;
    const result = classifyGround(input, options, prepared, isObject ?? markObjects(prepared, options, progress), progress);
    scope.postMessage(
      { kind: "done", classification: result.classification, heightAboveGround: result.heightAboveGround, stats: result.stats, usedGpu },
      [result.classification.buffer as ArrayBuffer, result.heightAboveGround.buffer as ArrayBuffer],
    );
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "Ground detection failed" });
  }
};
