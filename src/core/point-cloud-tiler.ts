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
 * source had. Points are counted into a flat grid first so each tile's
 * buffers can be allocated at their exact size and filled in one scatter
 * pass, without a growable array per tile.
 */
export class PointCloudTiler {
  public tile(source: PointCloud, options: TilingOptions): PointCloudTile[] {
    const { tileSize } = options;
    if (!Number.isFinite(tileSize) || tileSize <= 0) {
      throw new Error("tileSize must be a finite number greater than zero");
    }

    const { positions, colors, intensity, pointCount } = source;
    const originX = source.bounds.min[0];
    const originZ = source.bounds.min[2];
    const columns = Math.max(1, Math.ceil(source.bounds.size[0] / tileSize));
    const rows = Math.max(1, Math.ceil(source.bounds.size[2] / tileSize));

    const cellOf = (offset: number): number =>
      Math.min(rows - 1, Math.floor((positions[offset + 2]! - originZ) / tileSize)) * columns +
      Math.min(columns - 1, Math.floor((positions[offset]! - originX) / tileSize));

    const cellCounts = new Int32Array(columns * rows);
    for (let offset = 0; offset < positions.length; offset += 3) {
      const cell = cellOf(offset);
      cellCounts[cell] = cellCounts[cell]! + 1;
    }

    const tileOfCell = new Int32Array(cellCounts.length).fill(-1);
    const cellOfTile: number[] = [];
    for (let cell = 0; cell < cellCounts.length; cell += 1) {
      if (cellCounts[cell] === 0) continue;
      tileOfCell[cell] = cellOfTile.length;
      cellOfTile.push(cell);
    }

    const tilePositions = cellOfTile.map((cell) => new Float32Array(cellCounts[cell]! * 3));
    const tileColors = colors === undefined ? undefined : cellOfTile.map((cell) => new Uint8Array(cellCounts[cell]! * 3));
    const tileIntensity = intensity === undefined ? undefined : cellOfTile.map((cell) => new Float32Array(cellCounts[cell]!));
    const cursors = new Int32Array(cellOfTile.length);

    for (let point = 0, offset = 0; point < pointCount; point += 1, offset += 3) {
      const tile = tileOfCell[cellOf(offset)]!;
      const target = cursors[tile]!;
      cursors[tile] = target + 1;

      const targetOffset = target * 3;
      const destination = tilePositions[tile]!;
      destination[targetOffset] = positions[offset]!;
      destination[targetOffset + 1] = positions[offset + 1]!;
      destination[targetOffset + 2] = positions[offset + 2]!;
      if (tileColors !== undefined) {
        const destinationColors = tileColors[tile]!;
        destinationColors[targetOffset] = colors![offset]!;
        destinationColors[targetOffset + 1] = colors![offset + 1]!;
        destinationColors[targetOffset + 2] = colors![offset + 2]!;
      }
      if (tileIntensity !== undefined) tileIntensity[tile]![target] = intensity![point]!;
    }

    return cellOfTile.map((cell, tile) => {
      const gridX = cell % columns;
      const gridZ = (cell - gridX) / columns;
      return {
        id: `tile-${gridX}-${gridZ}`,
        gridX,
        gridZ,
        cloud: new PointCloud({
          positions: tilePositions[tile]!,
          ...(tileColors === undefined ? {} : { colors: tileColors[tile]! }),
          ...(tileIntensity === undefined ? {} : { intensity: tileIntensity[tile]! }),
          name: `${source.name}-tile-${gridX}-${gridZ}`,
        }),
      };
    });
  }
}
