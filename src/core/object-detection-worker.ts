import { detectGround, heightAboveClassifiedGround, type GroundDetectionStats } from "./ground-detection.js";
import { detectObjects } from "./object-detection.js";
import type { GroundSource, ObjectDetectionMessage, ObjectDetectionRequest } from "./object-detection-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ObjectDetectionRequest>) => void) | null;
  postMessage: (message: ObjectDetectionMessage, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = (event: MessageEvent<ObjectDetectionRequest>) => {
  const { positions, bounds, numberOfReturns, groundOptions, objectOptions } = event.data;
  const progress = (from: number, to: number) => (stage: string, fraction: number) =>
    scope.postMessage({ kind: "progress", stage, fraction: from + (to - from) * fraction });

  try {
    let { classification, heightAboveGround } = event.data;
    let groundSource: GroundSource = "existing-heights";
    let groundStats: GroundDetectionStats | undefined;

    // Cheapest honest route to heights: reuse them, else measure from a ground
    // class the file already has, and only filter for ground when neither exists.
    if (heightAboveGround === undefined && classification !== undefined) {
      progress(0, 1)("Measuring height above the scan's own ground", 0.01);
      heightAboveGround = heightAboveClassifiedGround({ positions, bounds, classification }, groundOptions);
      groundSource = "existing-classes";
    }
    if (heightAboveGround === undefined) {
      const ground = detectGround({ positions, bounds, classification }, groundOptions, progress(0, 0.45));
      classification = ground.classification;
      heightAboveGround = ground.heightAboveGround;
      groundStats = ground.stats;
      groundSource = "detected";
    }

    const start = groundSource === "detected" ? 0.45 : 0.05;
    const result = detectObjects(
      {
        positions,
        bounds,
        heightAboveGround,
        classification: classification ?? new Uint8Array(positions.length / 3),
        numberOfReturns,
      },
      objectOptions,
      progress(start, 1),
    );
    scope.postMessage(
      {
        kind: "done",
        classification: result.classification,
        heightAboveGround,
        objectId: result.objectId,
        objects: result.objects,
        stats: result.stats,
        groundSource,
        ...(groundStats === undefined ? {} : { groundStats }),
      },
      [result.classification.buffer as ArrayBuffer, heightAboveGround.buffer as ArrayBuffer, result.objectId.buffer as ArrayBuffer],
    );
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "Counting buildings and trees failed" });
  }
};
