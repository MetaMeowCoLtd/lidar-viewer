import type { PointCloudAttributes, PointCloudBounds, PointCloudOrigin } from "../core/point-cloud.js";
import type { SpatialReference } from "../core/spatial-reference.js";

export interface ScanImportRequest {
  /** Posting a `File` to a worker shares a handle to it; no bytes are copied. */
  readonly file: File;
  readonly name: string;
}

export type ScanImportMessage =
  | { readonly kind: "progress"; readonly fraction: number }
  | ({
      readonly kind: "done";
      readonly name: string;
      readonly positions: Float32Array;
      readonly bounds: PointCloudBounds;
      readonly origin: PointCloudOrigin;
      readonly spatialReference?: SpatialReference;
    } & PointCloudAttributes)
  | { readonly kind: "failed"; readonly message: string };
