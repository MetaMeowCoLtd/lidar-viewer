import type { PointCloudBounds } from "./point-cloud.js";
import type { GroundDetectionOptions, GroundDetectionStats } from "./ground-detection.js";

export interface GroundDetectionRequest {
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly classification?: Uint8Array;
  readonly options: GroundDetectionOptions;
}

export type GroundDetectionMessage =
  | { readonly kind: "progress"; readonly stage: string; readonly fraction: number }
  | {
      readonly kind: "done";
      readonly classification: Uint8Array;
      readonly heightAboveGround: Float32Array;
      readonly stats: GroundDetectionStats;
    }
  | { readonly kind: "failed"; readonly message: string };
