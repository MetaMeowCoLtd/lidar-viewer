import type { PointCloudBounds, PointCloudOrigin } from "./point-cloud.js";
import type { Checkpoint, QualityReport, QualityReportOptions } from "./quality-report.js";

export interface QualityReportRequest {
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly origin: PointCloudOrigin;
  readonly classification?: Uint8Array;
  readonly returnNumber?: Uint8Array;
  readonly numberOfReturns?: Uint8Array;
  readonly pointSourceId?: Uint16Array;
  readonly checkpoints?: readonly Checkpoint[];
  readonly options: QualityReportOptions;
}

export type QualityReportMessage =
  | { readonly kind: "progress"; readonly stage: string; readonly fraction: number }
  | { readonly kind: "done"; readonly report: QualityReport }
  | { readonly kind: "failed"; readonly message: string };
