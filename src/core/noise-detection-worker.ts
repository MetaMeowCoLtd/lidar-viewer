import { detectNoise } from "./noise-detection.js";
import type { NoiseDetectionMessage, NoiseDetectionRequest } from "./noise-detection-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<NoiseDetectionRequest>) => void) | null;
  postMessage: (message: NoiseDetectionMessage, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = (event: MessageEvent<NoiseDetectionRequest>) => {
  const { positions, bounds, classification, options } = event.data;
  try {
    const result = detectNoise({ positions, bounds, classification }, options, (stage, fraction) => {
      scope.postMessage({ kind: "progress", stage, fraction });
    });
    scope.postMessage({ kind: "done", classification: result.classification, stats: result.stats }, [result.classification.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "Finding noise failed" });
  }
};
