import { PointCloud, definedChannels, type PointCloudBounds } from "./point-cloud.js";
import { PointCloudLodPyramid, pointSpacing, type LodTierSpec, type PointCloudLodTier } from "./lod-pyramid.js";

export { pointSpacing } from "./lod-pyramid.js";
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
  /** The most points to draw in all; refinement stops when the next step would pass it. */
  readonly pointBudget?: number | undefined;
  /** Whether a tile's bounds can be seen at all; a tile out of view draws its leanest tier. */
  readonly inView?: ((bounds: PointCloudBounds) => boolean) | undefined;
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
   * Chooses every tile's tier the way Potree refines its octree: by what the
   * viewer would see, most-needed first, within a point budget.
   *
   * Every tile in view starts at its leanest tier. The tile whose points sit
   * furthest apart on screen - spacing times pixels per unit over distance,
   * the screen-space error 3D Tiles refines by - steps one tier finer, and is
   * weighed again; this repeats until every tile's gaps are within
   * `maxGapPixels`, or the next step would pass the budget. Near tiles have
   * the widest gaps, so they refine first and furthest: full detail in front,
   * a little lighter behind, lightest at the back, and a budget spent where
   * it shows. Tiles out of view keep their leanest tier.
   *
   * Spacing is measured from each tier's own points, so the rule follows the
   * scan's real density, the field of view and the size of the view. Distance
   * is to the nearest point of the tile's bounds, so the tile the camera
   * stands in counts as nearest of all.
   */
  public selectForScreenSpace(view: ScreenSpaceLodView): readonly TiledLodSelection[] {
    if (!(view.maxGapPixels > 0) || !(view.pixelsPerUnit > 0)) throw new Error("maxGapPixels and pixelsPerUnit must be positive");
    const budget = view.pointBudget ?? Number.POSITIVE_INFINITY;
    // Tiers run from full detail (index 0) to the leanest; every tile starts at the leanest.
    const level = this.tiles.map((tile) => tile.pyramid.tiers.length - 1);
    let drawn = this.tiles.reduce((sum, tile, index) => sum + tile.pyramid.tiers[level[index]!]!.cloud.pointCount, 0);
    const gap = (index: number): number => {
      const tile = this.tiles[index]!;
      const tier = tile.pyramid.tiers[level[index]!]!;
      const distance = Math.max(distanceToBounds(view.cameraX, view.cameraY, view.cameraZ, tile.bounds), 1e-3);
      return (pointSpacing(tile.bounds, tier.cloud.pointCount) * view.pixelsPerUnit) / distance;
    };
    const queue = new MaxHeap();
    this.tiles.forEach((tile, index) => {
      if (level[index]! > 0 && (view.inView === undefined || view.inView(tile.bounds))) queue.push(index, gap(index));
    });
    for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
      if (entry.priority <= view.maxGapPixels) break;
      const tiers = this.tiles[entry.index]!.pyramid.tiers;
      const current = tiers[level[entry.index]!]!;
      const finer = tiers[level[entry.index]! - 1]!;
      const cost = finer.cloud.pointCount - current.cloud.pointCount;
      // Out of budget: every tile still waiting needs this less, so the refinement ends here, as Potree's does.
      if (drawn + cost > budget) break;
      drawn += cost;
      level[entry.index]! -= 1;
      if (level[entry.index]! > 0) queue.push(entry.index, gap(entry.index));
    }
    return this.tiles.map((tile, index) => ({ tile, tier: tile.pyramid.tiers[level[index]!]! }));
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

/** A binary heap of tile indices, largest priority first. */
class MaxHeap {
  private readonly items: Array<{ index: number; priority: number }> = [];

  public push(index: number, priority: number): void {
    const items = this.items;
    items.push({ index, priority });
    let at = items.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (items[parent]!.priority >= items[at]!.priority) break;
      [items[parent], items[at]] = [items[at]!, items[parent]!];
      at = parent;
    }
  }

  public pop(): { index: number; priority: number } | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    items[0] = last;
    let at = 0;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let largest = at;
      if (left < items.length && items[left]!.priority > items[largest]!.priority) largest = left;
      if (right < items.length && items[right]!.priority > items[largest]!.priority) largest = right;
      if (largest === at) return top;
      [items[largest], items[at]] = [items[at]!, items[largest]!];
      at = largest;
    }
  }
}
