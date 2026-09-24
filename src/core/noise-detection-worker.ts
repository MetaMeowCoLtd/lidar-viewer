import { detectNoise, noiseSearchRadius } from "./noise-detection.js";
import type { NoiseDetectionMessage, NoiseDetectionRequest } from "./noise-detection-protocol.js";
import { requestGpu } from "../gpu/gpu-context.js";
import { gpuFindIsolated } from "../gpu/isolated-points.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<NoiseDetectionRequest>) => void) | null;
  postMessage: (message: NoiseDetectionMessage, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = async (event: MessageEvent<NoiseDetectionRequest>) => {
  const { positions, bounds, classification, options, useGpu } = event.data;
  const progress = (stage: string, fraction: number) => scope.postMessage({ kind: "progress", stage, fraction });
  try {
    // The neighbour search is the costly part; on the GPU it runs one thread per point.
    let isolated: Uint8Array | undefined;
    if (useGpu === true) {
      try {
        const gpu = await requestGpu();
        if (gpu !== undefined) {
          progress("Finding isolated points on the GPU", 0.1);
          isolated = (await gpuFindIsolated(gpu, positions, bounds, noiseSearchRadius(bounds, positions.length / 3, options), options.minNeighbours)).isolated;
        }
      } catch {
        isolated = undefined;
      }
    }
    const result = detectNoise({ positions, bounds, classification, isolated }, options, progress);
    scope.postMessage({ kind: "done", classification: result.classification, stats: result.stats, usedGpu: isolated !== undefined }, [result.classification.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "Finding noise failed" });
  }
};
