import type { PointCloudBounds } from "./point-cloud.js";
import type { NoiseDetectionOptions, NoiseDetectionStats } from "./noise-detection.js";

export interface NoiseDetectionRequest {
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly classification?: Uint8Array;
  readonly options: NoiseDetectionOptions;
}

export type NoiseDetectionMessage =
  | { readonly kind: "progress"; readonly stage: string; readonly fraction: number }
  | { readonly kind: "done"; readonly classification: Uint8Array; readonly stats: NoiseDetectionStats }
  | { readonly kind: "failed"; readonly message: string };
