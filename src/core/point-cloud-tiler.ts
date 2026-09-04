import { PointCloud } from "./point-cloud.js";

export interface TilingOptions {
  /** World-space edge length of one square XZ tile column. */
  readonly tileSize: number;
}

export interface PointCloudTile {
  readonly id: string;
  readonly gridX: number;
  readonly gridZ: number;
  readonly cloud: PointCloud;
}

/**
 * Splits a point cloud into a grid of XZ columns (height is left unbounded
 * per tile) so LOD can be selected per region instead of for the whole
 * cloud at once. This is a partition, not a resampling: every source point
 * ends up in exactly one tile, and tile clouds keep whatever attributes the
 * source had.
 */
export class PointCloudTiler {
  public tile(source: PointCloud, options: TilingOptions): PointCloudTile[] {
    const { tileSize } = options;
    if (!Number.isFinite(tileSize) || tileSize <= 0) {
      throw new Error("tileSize must be a finite number greater than zero");
    }

    const { positions, colors, intensity } = source;
    const originX = source.bounds.min[0];
    const originZ = source.bounds.min[2];

    const buckets = new Map<string, number[]>();
    for (let point = 0, offset = 0; point < source.pointCount; point += 1, offset += 3) {
      const gridX = Math.floor((positions[offset]! - originX) / tileSize);
      const gridZ = Math.floor((positions[offset + 2]! - originZ) / tileSize);
      const key = `${gridX},${gridZ}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(point);
    }

    const tiles: PointCloudTile[] = [];
    for (const [key, indices] of buckets) {
      const separator = key.indexOf(",");
      const gridX = Number(key.slice(0, separator));
      const gridZ = Number(key.slice(separator + 1));

      const tilePositions = new Float32Array(indices.length * 3);
      const tileColors = colors === undefined ? undefined : new Uint8Array(indices.length * 3);
      const tileIntensity = intensity === undefined ? undefined : new Float32Array(indices.length);
      for (let i = 0; i < indices.length; i += 1) {
        const point = indices[i]!;
        const srcOffset = point * 3;
        const dstOffset = i * 3;
        tilePositions[dstOffset] = positions[srcOffset]!;
        tilePositions[dstOffset + 1] = positions[srcOffset + 1]!;
        tilePositions[dstOffset + 2] = positions[srcOffset + 2]!;
        if (tileColors !== undefined) {
          tileColors[dstOffset] = colors![srcOffset]!;
          tileColors[dstOffset + 1] = colors![srcOffset + 1]!;
          tileColors[dstOffset + 2] = colors![srcOffset + 2]!;
        }
        if (tileIntensity !== undefined) tileIntensity[i] = intensity![point]!;
      }

      tiles.push({
        id: `tile-${gridX}-${gridZ}`,
        gridX,
        gridZ,
        cloud: new PointCloud({
          positions: tilePositions,
          ...(tileColors === undefined ? {} : { colors: tileColors }),
          ...(tileIntensity === undefined ? {} : { intensity: tileIntensity }),
          name: `${source.name}-tile-${gridX}-${gridZ}`,
        }),
      });
    }
    return tiles;
  }
}
