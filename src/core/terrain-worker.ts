import { buildTerrainModel } from "./terrain.js";
import { traceContours } from "./contours.js";
import type { TerrainMessage, TerrainRequest } from "./terrain-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<TerrainRequest>) => void) | null;
  postMessage: (message: TerrainMessage, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = (event: MessageEvent<TerrainRequest>) => {
  const { positions, bounds, classification, originY, options } = event.data;
  try {
    scope.postMessage({ kind: "progress", stage: "Averaging the ground", fraction: 0.05 });
    const model = buildTerrainModel({ positions, bounds, classification }, options);
    scope.postMessage({ kind: "progress", stage: "Tracing contour lines", fraction: 0.6 });
    const contours = traceContours(model, originY);
    scope.postMessage({ kind: "done", model, contours }, [
      model.elevations.buffer as ArrayBuffer,
      model.measured.buffer as ArrayBuffer,
      ...contours.lines.map((line) => line.points.buffer as ArrayBuffer),
    ]);
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "Building the terrain failed" });
  }
};
