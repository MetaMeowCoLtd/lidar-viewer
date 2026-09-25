import type { Checkpoint, QualityReport } from "../../core/quality-report.js";
import type { NoiseDetectionStats } from "../../core/noise-detection.js";
import type { GroundDetectionStats } from "../../core/ground-detection.js";
import type { DetectedObject, ObjectDetectionStats } from "../../core/object-detection.js";
import type { PointDetails } from "../../core/point-inspection.js";
import type { TerrainResult } from "../../core/terrain-job.js";

export type ViewerStatus = "initializing" | "processing" | "ready" | "error";

export type ExportKind = "inventory" | "geojson" | "las" | "cleaned" | "classes" | "elevation" | "contours";

export type ClickTool = "inspect" | "measure";

export type LodMode = "manual" | "distance";

/** How far an import has got: downloading the sample, reading the file on a worker, then building its detail levels. */
export interface ImportProgress {
  readonly stage: "downloading" | "reading" | "building";
  readonly fraction: number;
}

/** Set when a scan had more points than this build loads and was thinned evenly to fit. */
export interface Sampling {
  readonly loaded: number;
  readonly total: number;
}

export interface Picks {
  readonly inspected?: PointDetails | undefined;
  readonly from?: PointDetails | undefined;
  readonly to?: PointDetails | undefined;
}

/** Where a run of several analyses has got: which step of how many, and what it is doing. */
export interface PipelineState {
  readonly step: number;
  readonly total: number;
  readonly label: string;
}

export type QualityState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly stage: string; readonly fraction: number }
  | { readonly status: "done"; readonly report: QualityReport; readonly seconds: number }
  | { readonly status: "failed"; readonly message: string };

/** Surveyed checkpoints to measure the scan against, and where they came from. */
export interface CheckpointSet {
  readonly checkpoints: readonly Checkpoint[];
  readonly source: string;
}

export type NoiseState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly stage: string; readonly fraction: number }
  | { readonly status: "done"; readonly stats: NoiseDetectionStats; readonly seconds: number; readonly onGpu: boolean }
  | { readonly status: "failed"; readonly message: string };

export type GroundState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly stage: string; readonly fraction: number }
  | { readonly status: "done"; readonly stats: GroundDetectionStats; readonly seconds: number; readonly onGpu?: boolean }
  | { readonly status: "failed"; readonly message: string };

export type TerrainState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly stage: string; readonly fraction: number }
  | { readonly status: "done"; readonly result: TerrainResult; readonly seconds: number }
  | { readonly status: "failed"; readonly message: string };

export type CountState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly stage: string; readonly fraction: number }
  | {
      readonly status: "done";
      readonly stats: ObjectDetectionStats;
      readonly objects: readonly DetectedObject[];
      readonly tallestBuilding: number;
      readonly treeHeights: readonly [number, number];
      readonly seconds: number;
    }
  | { readonly status: "failed"; readonly message: string };
