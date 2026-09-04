import { PointCloud, type PointCloudBounds } from "./point-cloud.js";
import { PointCloudLodPyramid, type LodTierSpec, type PointCloudLodTier } from "./lod-pyramid.js";
import { PointCloudTiler, type PointCloudTile } from "./point-cloud-tiler.js";
import type { LodBuildPool } from "./lod-build-pool.js";
import type { SerializedTier } from "./lod-build-protocol.js";

export interface TiledPointCloudTile {
  readonly id: string;
  readonly bounds: PointCloudBounds;
  readonly pyramid: PointCloudLodPyramid;
}

export interface TilingConfig {
  readonly enabled: boolean;
  /** Tile edges are sized so a tile holds roughly this many points. */
  readonly targetPointsPerTile: number;
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
    const tiles = partition(source, tiling).map((tile) => ({
      id: tile.id,
      bounds: tile.cloud.bounds,
      pyramid: PointCloudLodPyramid.build(tile.cloud, specs),
    }));
    return new TiledPointCloudLodPyramid(tiles);
  }

  /**
   * Builds every tile's pyramid on a worker pool. A cloud small enough to stay
   * in one tile is built on the calling thread instead, because that tile's
   * buffers are the caller's own and must not be transferred away.
   */
  public static async buildWithPool(
    source: PointCloud,
    specs: readonly LodTierSpec[],
    tiling: TilingConfig,
    pool: LodBuildPool,
  ): Promise<TiledPointCloudLodPyramid> {
    const rawTiles = partition(source, tiling);
    if (rawTiles.length === 1) return TiledPointCloudLodPyramid.build(source, specs, tiling);

    const tiles = await Promise.all(
      rawTiles.map(async (tile) => {
        const bounds = tile.cloud.bounds;
        const response = await pool.run({
          tileId: tile.id,
          name: tile.cloud.name,
          positions: tile.cloud.positions,
          ...(tile.cloud.colors === undefined ? {} : { colors: tile.cloud.colors }),
          ...(tile.cloud.intensity === undefined ? {} : { intensity: tile.cloud.intensity }),
          specs,
        });
        return { id: tile.id, bounds, pyramid: new PointCloudLodPyramid(response.tiers.map(toTier)) };
      }),
    );
    return new TiledPointCloudLodPyramid(tiles);
  }

  /** Picks a tier for every tile from its distance to the camera. */
  public selectForCameraPosition(cameraX: number, cameraY: number, cameraZ: number): readonly TiledLodSelection[] {
    return this.tiles.map((tile) => ({
      tile,
      tier: tile.pyramid.selectForCameraDistance(distanceToBounds(cameraX, cameraY, cameraZ, tile.bounds)),
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

function partition(source: PointCloud, tiling: TilingConfig): readonly PointCloudTile[] {
  const single: readonly PointCloudTile[] = [{ id: "tile-0-0", gridX: 0, gridZ: 0, cloud: source }];
  if (!tiling.enabled) return single;
  const span = Math.max(source.bounds.size[0], source.bounds.size[2]);
  const tilesPerAxis = Math.ceil(Math.sqrt(source.pointCount / Math.max(1, tiling.targetPointsPerTile)));
  if (span <= 0 || tilesPerAxis < 2) return single;
  return new PointCloudTiler().tile(source, { tileSize: span / tilesPerAxis });
}

function toTier(tier: SerializedTier): PointCloudLodTier {
  return {
    id: tier.id,
    voxelSize: tier.voxelSize,
    cloud: new PointCloud({
      positions: tier.positions,
      ...(tier.colors === undefined ? {} : { colors: tier.colors }),
      ...(tier.intensity === undefined ? {} : { intensity: tier.intensity }),
      bounds: tier.bounds,
      name: tier.name,
    }),
    ...(tier.minCameraDistance === undefined ? {} : { minCameraDistance: tier.minCameraDistance }),
  };
}

/** Distance from a point to the nearest point on an axis-aligned box; zero when inside it. */
export function distanceToBounds(x: number, y: number, z: number, bounds: PointCloudBounds): number {
  return Math.hypot(
    x - Math.min(Math.max(x, bounds.min[0]), bounds.max[0]),
    y - Math.min(Math.max(y, bounds.min[1]), bounds.max[1]),
    z - Math.min(Math.max(z, bounds.min[2]), bounds.max[2]),
  );
}
