import type { LodTierSpec } from "./lod-pyramid.js";
import type { PointCloudBounds, PointCloudOrigin } from "./point-cloud.js";

export interface LodBuildRequest {
  readonly tileId: string;
  readonly name: string;
  /** Local coordinates; see `origin`. */
  readonly positions: Float32Array;
  readonly colors?: Uint8Array;
  readonly intensity?: Float32Array;
  readonly classification?: Uint8Array;
  readonly returnNumber?: Uint8Array;
  readonly numberOfReturns?: Uint8Array;
  readonly heightAboveGround?: Float32Array;
  readonly objectId?: Uint32Array;
  /** The tile's local frame, carried across so decimated tiers stay aligned with it. */
  readonly origin: PointCloudOrigin;
  readonly specs: readonly LodTierSpec[];
}

export interface SerializedTier {
  readonly id: string;
  readonly voxelSize: number;
  readonly name: string;
  readonly positions: Float32Array;
  readonly colors?: Uint8Array;
  readonly intensity?: Float32Array;
  readonly classification?: Uint8Array;
  readonly returnNumber?: Uint8Array;
  readonly numberOfReturns?: Uint8Array;
  readonly heightAboveGround?: Float32Array;
  readonly objectId?: Uint32Array;
  readonly bounds: PointCloudBounds;
  readonly origin: PointCloudOrigin;
  readonly minCameraDistance?: number;
}

export interface LodBuildResponse {
  readonly tileId: string;
  readonly tiers: readonly SerializedTier[];
}
