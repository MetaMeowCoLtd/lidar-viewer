import { PointCloud } from "./point-cloud.js";
import { VoxelGridDownsampler } from "./voxel-grid-downsampler.js";

export interface LodTierSpec {
  readonly id: string;
  /** World-space voxel size. A value of zero retains the original cloud. */
  readonly voxelSize: number;
  /**
   * Minimum camera distance (world units) at which this tier becomes the
   * preferred choice for distance-based selection. Tiers that omit this are
   * never picked by {@link PointCloudLodPyramid.selectForCameraDistance}.
   */
  readonly minCameraDistance?: number;
}

export interface PointCloudLodTier {
  readonly id: string;
  readonly voxelSize: number;
  readonly cloud: PointCloud;
  readonly minCameraDistance?: number;
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

  /**
   * Chooses a tier from how far the camera currently sits from the cloud,
   * favoring detail up close and coarser tiers as the camera recedes. Tiers
   * without a `minCameraDistance` are ignored; if none declare one, the
   * highest-detail tier is returned so distance-based selection degrades
   * gracefully to "always full detail" rather than throwing.
   */
  public selectForCameraDistance(distance: number): PointCloudLodTier {
    if (!Number.isFinite(distance) || distance < 0) {
      throw new Error("distance must be a non-negative finite number");
    }
    const eligible = this.tiers.filter(
      (tier): tier is PointCloudLodTier & { minCameraDistance: number } => tier.minCameraDistance !== undefined,
    );
    if (eligible.length === 0) return this.tiers[0]!;

    // Fall back to the tier with the smallest threshold (closest to the camera)
    // when the camera is nearer than every declared threshold.
    let selected = eligible.reduce((closest, tier) =>
      tier.minCameraDistance < closest.minCameraDistance ? tier : closest,
    );
    for (const tier of eligible) {
      if (tier.minCameraDistance <= distance && tier.minCameraDistance >= selected.minCameraDistance) {
        selected = tier;
      }
    }
    return selected;
  }

  public static build(source: PointCloud, specs: readonly LodTierSpec[]): PointCloudLodPyramid {
    if (specs.length === 0) throw new Error("At least one LOD tier must be requested");
    const downsampler = new VoxelGridDownsampler();
    const tiers = specs.map((spec) => ({
      id: spec.id,
      voxelSize: spec.voxelSize,
      cloud: spec.voxelSize === 0 ? source : downsampler.downsample(source, { voxelSize: spec.voxelSize }),
      ...(spec.minCameraDistance === undefined ? {} : { minCameraDistance: spec.minCameraDistance }),
    }));
    return new PointCloudLodPyramid(tiers);
  }
}
