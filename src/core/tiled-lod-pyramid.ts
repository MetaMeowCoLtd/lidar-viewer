import { PointCloud, definedChannels, type PointCloudBounds } from "./point-cloud.js";
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

/** What screen-space selection needs to know about the view. */
export interface ScreenSpaceLodView {
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  /** CSS pixels one world unit spans at a distance of one unit: the view's height over twice the tangent of half its field of view. */
  readonly pixelsPerUnit: number;
  /** The widest gap, in CSS pixels, allowed between neighbouring points on screen before a finer tier is drawn. */
  readonly maxGapPixels: number;
  /** Whether a tile's bounds can be seen at all; a tile out of view draws its leanest tier. */
  readonly inView?: ((bounds: PointCloudBounds) => boolean) | undefined;
}

/**
 * Typical distance between a cloud's points: the side of the square each
 * point would have if they were spread evenly over the tile's plan. Walls
 * make an aerial tile's surface larger than its plan, so this errs a little
 * wide, which suits both a dot meant to close the gaps and a detail choice
 * that should not come out coarser than it looks.
 */
export function pointSpacing(bounds: PointCloudBounds, pointCount: number): number {
  const area = Math.max(bounds.size[0] * bounds.size[2], 1e-6);
  return Math.max(Math.sqrt(area / Math.max(1, pointCount)), 0.005);
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
   *
   * `onProgress` hears the fraction done: partitioning into tiles first, then
   * each tile as its worker finishes.
   */
  public static async buildWithPool(
    source: PointCloud,
    specs: readonly LodTierSpec[],
    tiling: TilingConfig,
    pool: LodBuildPool,
    onProgress?: (fraction: number) => void,
  ): Promise<TiledPointCloudLodPyramid> {
    const rawTiles = await partitionInSlices(source, tiling, (fraction) => onProgress?.(partitionShare * fraction));
    if (rawTiles.length === 1) {
      const whole = TiledPointCloudLodPyramid.build(source, specs, tiling);
      onProgress?.(1);
      return whole;
    }

    let built = 0;
    onProgress?.(partitionShare);
    const tiles = await Promise.all(
      rawTiles.map(async (tile) => {
        const bounds = tile.cloud.bounds;
        const response = await pool.run({
          tileId: tile.id,
          name: tile.cloud.name,
          positions: tile.cloud.positions,
          ...definedChannels(tile.cloud),
          origin: tile.cloud.origin,
          specs,
        });
        built += 1;
        onProgress?.(partitionShare + (1 - partitionShare) * (built / rawTiles.length));
        return { id: tile.id, bounds, pyramid: new PointCloudLodPyramid(response.tiers.map(toTier)) };
      }),
    );
    return new TiledPointCloudLodPyramid(tiles);
  }

  /**
   * Picks for every tile the leanest tier whose points still sit no further
   * apart on screen than `maxGapPixels` - the screen-space error rule Potree
   * and 3D Tiles use. A tier's spacing is measured, not assumed, so the choice
   * follows the scan's real density, the field of view and the size of the
   * view, where fixed distances would not: the same threshold holds on a
   * phone and a 4K screen, for a dense drone scan and a sparse national one.
   * Distance is to the nearest point of the tile's bounds, so a tile the
   * camera stands in draws full detail.
   */
  public selectForScreenSpace(view: ScreenSpaceLodView): readonly TiledLodSelection[] {
    if (!(view.maxGapPixels > 0) || !(view.pixelsPerUnit > 0)) throw new Error("maxGapPixels and pixelsPerUnit must be positive");
    return this.tiles.map((tile) => {
      const tiers = tile.pyramid.tiers;
      if (view.inView !== undefined && !view.inView(tile.bounds)) return { tile, tier: tiers.at(-1)! };
      const distance = Math.max(distanceToBounds(view.cameraX, view.cameraY, view.cameraZ, tile.bounds), 1e-3);
      // Tiers run from full detail to the leanest; the first is kept when even it is too sparse.
      let chosen = tiers[0]!;
      for (const tier of tiers) {
        const gap = (pointSpacing(tile.bounds, tier.cloud.pointCount) * view.pixelsPerUnit) / distance;
        if (gap > view.maxGapPixels) break;
        chosen = tier;
      }
      return { tile, tier: chosen };
    });
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

/**
 * The share of a pooled build's progress given to partitioning, which runs on
 * the page's thread one point at a time. The per-tile builds that follow run
 * in parallel on workers and are much quicker: on the 60-million-point
 * Shinjuku scan, about five seconds of partitioning against under one of
 * building.
 */
const partitionShare = 0.85;

function partition(source: PointCloud, tiling: TilingConfig): readonly PointCloudTile[] {
  const tileSize = tileSizeFor(source, tiling);
  return tileSize === undefined ? singleTile(source) : new PointCloudTiler().tile(source, { tileSize });
}

/** {@link partition} without holding the thread; see {@link PointCloudTiler.tileInSlices}. */
async function partitionInSlices(
  source: PointCloud,
  tiling: TilingConfig,
  onProgress?: (fraction: number) => void,
): Promise<readonly PointCloudTile[]> {
  const tileSize = tileSizeFor(source, tiling);
  return tileSize === undefined ? singleTile(source) : new PointCloudTiler().tileInSlices(source, { tileSize }, undefined, onProgress);
}

/** The tile edge for a cloud, or undefined when it should stay in one tile. */
function tileSizeFor(source: PointCloud, tiling: TilingConfig): number | undefined {
  if (!tiling.enabled) return undefined;
  const span = Math.max(source.bounds.size[0], source.bounds.size[2]);
  const tilesPerAxis = Math.ceil(Math.sqrt(source.pointCount / Math.max(1, tiling.targetPointsPerTile)));
  return span <= 0 || tilesPerAxis < 2 ? undefined : span / tilesPerAxis;
}

function singleTile(source: PointCloud): readonly PointCloudTile[] {
  return [{ id: "tile-0-0", gridX: 0, gridZ: 0, cloud: source }];
}

function toTier(tier: SerializedTier): PointCloudLodTier {
  return {
    id: tier.id,
    voxelSize: tier.voxelSize,
    cloud: new PointCloud({
      positions: tier.positions,
      ...definedChannels(tier),
      bounds: tier.bounds,
      origin: tier.origin,
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
