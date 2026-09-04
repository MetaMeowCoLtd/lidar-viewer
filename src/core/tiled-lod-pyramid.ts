import type { PointCloud, PointCloudBounds } from "./point-cloud.js";
import { PointCloudLodPyramid, type LodTierSpec, type PointCloudLodTier } from "./lod-pyramid.js";
import { PointCloudTiler, type PointCloudTile } from "./point-cloud-tiler.js";

export interface TiledPointCloudTile {
  readonly id: string;
  readonly bounds: PointCloudBounds;
  readonly pyramid: PointCloudLodPyramid;
}

export interface TilingConfig {
  readonly enabled: boolean;
  readonly tileSize: number;
}

export interface TiledLodSelection {
  readonly tile: TiledPointCloudTile;
  readonly tier: PointCloudLodTier;
}

/**
 * A grid of independent LOD pyramids, one per spatial tile, so distance-based
 * selection can give nearby tiles full detail while distant tiles fall back
 * to a coarser tier instead of the whole cloud switching tiers together.
 * Every tile shares the same tier specs (voxel sizes and distance
 * thresholds), so detail is comparable across the scene; only the point
 * counts differ per tile.
 */
export class TiledPointCloudLodPyramid {
  public readonly tiles: readonly TiledPointCloudTile[];
  public readonly totalPointCount: number;

  private constructor(tiles: readonly TiledPointCloudTile[]) {
    if (tiles.length === 0) throw new Error("A tiled pyramid needs at least one tile");
    this.tiles = tiles;
    this.totalPointCount = tiles.reduce((sum, tile) => sum + tile.pyramid.tiers[0]!.cloud.pointCount, 0);
  }

  public static build(source: PointCloud, specs: readonly LodTierSpec[], tiling: TilingConfig): TiledPointCloudLodPyramid {
    const rawTiles: readonly PointCloudTile[] = tiling.enabled
      ? new PointCloudTiler().tile(source, { tileSize: tiling.tileSize })
      : [{ id: "tile-0-0", gridX: 0, gridZ: 0, cloud: source }];

    const tiles = rawTiles.map((tile) => ({
      id: tile.id,
      bounds: tile.cloud.bounds,
      pyramid: PointCloudLodPyramid.build(tile.cloud, specs),
    }));
    return new TiledPointCloudLodPyramid(tiles);
  }

  /** Picks a tier for every tile from its 2D (XZ) distance to the camera. */
  public selectForCameraPosition(cameraX: number, cameraZ: number): readonly TiledLodSelection[] {
    return this.tiles.map((tile) => ({
      tile,
      tier: tile.pyramid.selectForCameraDistance(distanceToBounds2D(cameraX, cameraZ, tile.bounds)),
    }));
  }

  /**
   * Distributes a global point budget across tiles proportional to each
   * tile's share of the total point count, then picks the richest tier that
   * fits inside that share for every tile.
   */
  public selectForPointBudget(pointBudget: number): readonly TiledLodSelection[] {
    if (!Number.isFinite(pointBudget) || pointBudget < 1) {
      throw new Error("pointBudget must be at least one");
    }
    return this.tiles.map((tile) => {
      const fullCount = tile.pyramid.tiers[0]!.cloud.pointCount;
      const share = this.totalPointCount === 0 ? 0 : fullCount / this.totalPointCount;
      const tileBudget = Math.max(1, Math.round(pointBudget * share));
      return { tile, tier: tile.pyramid.selectForPointBudget(tileBudget) };
    });
  }
}

/** Distance from a point to the nearest point on an axis-aligned XZ rectangle; zero when inside it. */
export function distanceToBounds2D(x: number, z: number, bounds: PointCloudBounds): number {
  const clampedX = Math.min(Math.max(x, bounds.min[0]), bounds.max[0]);
  const clampedZ = Math.min(Math.max(z, bounds.min[2]), bounds.max[2]);
  return Math.hypot(x - clampedX, z - clampedZ);
}
