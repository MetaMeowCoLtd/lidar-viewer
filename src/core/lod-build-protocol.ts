import type { LodTierSpec } from "./lod-pyramid.js";
import type { PointCloudBounds } from "./point-cloud.js";

export interface LodBuildRequest {
  readonly tileId: string;
  readonly name: string;
  readonly positions: Float32Array;
  readonly colors?: Uint8Array;
  readonly intensity?: Float32Array;
  readonly specs: readonly LodTierSpec[];
}

export interface SerializedTier {
  readonly id: string;
  readonly voxelSize: number;
  readonly name: string;
  readonly positions: Float32Array;
  readonly colors?: Uint8Array;
  readonly intensity?: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly minCameraDistance?: number;
}

export interface LodBuildResponse {
  readonly tileId: string;
  readonly tiers: readonly SerializedTier[];
}
