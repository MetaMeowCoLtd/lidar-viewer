import type { PointCloudBounds } from "./point-cloud.js";
import type { GroundDetectionOptions, GroundDetectionStats } from "./ground-detection.js";
import type { DetectedObject, ObjectDetectionOptions, ObjectDetectionStats } from "./object-detection.js";

export interface ObjectDetectionRequest {
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly classification?: Uint8Array;
  readonly heightAboveGround?: Float32Array;
  readonly numberOfReturns?: Uint8Array;
  readonly groundOptions: GroundDetectionOptions;
  readonly objectOptions: ObjectDetectionOptions;
}

/**
 * Where the heights objects were measured against came from: heights the
 * cloud already carried, a ground class the file already had, or ground
 * detection run as part of this job.
 */
export type GroundSource = "existing-heights" | "existing-classes" | "detected";

export type ObjectDetectionMessage =
  | { readonly kind: "progress"; readonly stage: string; readonly fraction: number }
  | {
      readonly kind: "done";
      readonly classification: Uint8Array;
      readonly heightAboveGround: Float32Array;
      readonly objectId: Uint32Array;
      readonly objects: readonly DetectedObject[];
      readonly stats: ObjectDetectionStats;
      readonly groundSource: GroundSource;
      readonly groundStats?: GroundDetectionStats;
    }
  | { readonly kind: "failed"; readonly message: string };
