import type { PointCloudBounds } from "./point-cloud.js";
import type { TerrainModel, TerrainOptions } from "./terrain.js";
import type { ContourSet } from "./contours.js";

export interface TerrainRequest {
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly classification: Uint8Array;
  /** The local frame's elevation, so contour levels land on round elevations of the scan. */
  readonly originY: number;
  readonly options: TerrainOptions;
}

export type TerrainMessage =
  | { readonly kind: "progress"; readonly stage: string; readonly fraction: number }
  | { readonly kind: "done"; readonly model: TerrainModel; readonly contours: ContourSet }
  | { readonly kind: "failed"; readonly message: string };
