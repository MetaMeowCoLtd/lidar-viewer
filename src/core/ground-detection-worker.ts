import { detectGround } from "./ground-detection.js";
import type { GroundDetectionMessage, GroundDetectionRequest } from "./ground-detection-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GroundDetectionRequest>) => void) | null;
  postMessage: (message: GroundDetectionMessage, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = (event: MessageEvent<GroundDetectionRequest>) => {
  const { positions, bounds, classification, options } = event.data;
  try {
    const result = detectGround({ positions, bounds, classification }, options, (stage, fraction) => {
      scope.postMessage({ kind: "progress", stage, fraction });
    });
    scope.postMessage(
      { kind: "done", classification: result.classification, heightAboveGround: result.heightAboveGround, stats: result.stats },
      [result.classification.buffer as ArrayBuffer, result.heightAboveGround.buffer as ArrayBuffer],
    );
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "Ground detection failed" });
  }
};
