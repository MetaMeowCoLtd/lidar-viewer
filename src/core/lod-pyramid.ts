import { PointCloud } from "./point-cloud.js";
import { VoxelGridDownsampler } from "./voxel-grid-downsampler.js";

export interface LodTierSpec {
  readonly id: string;
  /** World-space voxel size. A value of zero retains the original cloud. */
  readonly voxelSize: number;
}

export interface PointCloudLodTier {
  readonly id: string;
  readonly voxelSize: number;
  readonly cloud: PointCloud;
}

/** Precomputed GPU-ready tiers; no decimation work occurs inside the render loop. */
export class PointCloudLodPyramid {
  public readonly tiers: readonly PointCloudLodTier[];

  public constructor(tiers: readonly PointCloudLodTier[]) {
    if (tiers.length === 0) throw new Error("A LOD pyramid needs at least one tier");
    if (new Set(tiers.map((tier) => tier.id)).size !== tiers.length) {
      throw new Error("LOD tier ids must be unique");
    }
    this.tiers = [...tiers].sort((a, b) => b.cloud.pointCount - a.cloud.pointCount);
  }

  public selectForPointBudget(pointBudget: number): PointCloudLodTier {
    if (!Number.isFinite(pointBudget) || pointBudget < 1) {
      throw new Error("pointBudget must be at least one");
    }
    return this.tiers.find((tier) => tier.cloud.pointCount <= pointBudget) ?? this.tiers.at(-1)!;
  }

  public static build(source: PointCloud, specs: readonly LodTierSpec[]): PointCloudLodPyramid {
    if (specs.length === 0) throw new Error("At least one LOD tier must be requested");
    const downsampler = new VoxelGridDownsampler();
    const tiers = specs.map((spec) => ({
      id: spec.id,
      voxelSize: spec.voxelSize,
      cloud: spec.voxelSize === 0 ? source : downsampler.downsample(source, { voxelSize: spec.voxelSize }),
    }));
    return new PointCloudLodPyramid(tiers);
  }
}
