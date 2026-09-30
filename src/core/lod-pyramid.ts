import { PointCloud, type PointCloudBounds } from "./point-cloud.js";
import { VoxelGridDownsampler } from "./voxel-grid-downsampler.js";

export interface LodTierSpec {
  readonly id: string;
  /** World-space voxel size. A value of zero retains the original cloud, unless `pointFraction` is set. */
  readonly voxelSize: number;
  /**
   * Instead of a fixed voxel, keep about this share of the previous tier's
   * points: the voxel grows from a first guess until the tier is that much
   * lighter. Each tier is then measured against the scan's real density -
   * a forest's points fill a volume, a city's lie on surfaces, and one
   * voxel size means very different things to the two.
   */
  readonly pointFraction?: number;
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
    const tiers: PointCloudLodTier[] = [];
    for (const spec of specs) {
      const extra = spec.minCameraDistance === undefined ? {} : { minCameraDistance: spec.minCameraDistance };
      const previous = tiers.at(-1);
      if (spec.pointFraction !== undefined && previous !== undefined) {
        const { cloud, voxelSize } = thinByFraction(downsampler, previous, spec.pointFraction, spec.voxelSize);
        tiers.push({ id: spec.id, voxelSize, cloud, ...extra });
      } else {
        tiers.push({
          id: spec.id,
          voxelSize: spec.voxelSize,
          cloud: spec.voxelSize === 0 ? source : downsampler.downsample(source, { voxelSize: spec.voxelSize }),
          ...extra,
        });
      }
    }
    return new PointCloudLodPyramid(tiers);
  }
}

/** How much a voxel grows between attempts to reach a tier's share of points, and how many attempts it gets. */
const voxelGrowth = 1.35;
const maxThinningAttempts = 24;

/**
 * The next tier down from `previous`, with about `fraction` of its points.
 * It is thinned from the tier above rather than from the full cloud, which is
 * several times quicker for the lightest tiers; an average of averages leans
 * a little towards where the tier above was dense, which a coarse tier seen
 * from afar does not show.
 */
function thinByFraction(
  downsampler: VoxelGridDownsampler,
  previous: PointCloudLodTier,
  fraction: number,
  firstGuess: number,
): { cloud: PointCloud; voxelSize: number } {
  const target = Math.max(1, Math.floor(previous.cloud.pointCount * fraction));
  // A voxel as wide as the tier above's plan spacing merges almost nothing, so the guess starts one step past it.
  let voxelSize = firstGuess > 0 ? firstGuess : Math.max(previous.voxelSize, pointSpacing(previous.cloud.bounds, previous.cloud.pointCount)) * voxelGrowth;
  let cloud = downsampler.downsample(previous.cloud, { voxelSize });
  for (let attempt = 0; attempt < maxThinningAttempts && cloud.pointCount > target && cloud.pointCount > 1; attempt += 1) {
    voxelSize *= voxelGrowth;
    cloud = downsampler.downsample(previous.cloud, { voxelSize });
  }
  return { cloud, voxelSize };
}

/**
 * Typical distance between a cloud's points: the side of the square each
 * point would have if they were spread evenly over its plan. Walls and
 * canopies make the surface larger than the plan, so this errs a little
 * wide, which suits both a dot meant to close the gaps and a detail choice
 * that should not come out coarser than it looks.
 */
export function pointSpacing(bounds: PointCloudBounds, pointCount: number): number {
  const area = Math.max(bounds.size[0] * bounds.size[2], 1e-6);
  return Math.max(Math.sqrt(area / Math.max(1, pointCount)), 0.005);
}
