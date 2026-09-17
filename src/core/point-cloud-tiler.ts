import { PointCloud } from "./point-cloud.js";
import { yieldToEventLoop } from "./yield.js";

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
 * source had along with its local frame, so every tile stays directly
 * comparable to every other. Points are counted into a flat grid first so each tile's
 * buffers can be allocated at their exact size and filled in one scatter
 * pass, without a growable array per tile.
 */
export class PointCloudTiler {
  public tile(source: PointCloud, options: TilingOptions): PointCloudTile[] {
    const steps = this.partition(source, options);
    for (;;) {
      const step = steps.next();
      if (step.done === true) return step.value;
    }
  }

  /**
   * The same partition, handing the thread back to the browser whenever a
   * slice of work has run for `budgetMs`. Copying tens of millions of points
   * into tiles takes seconds; done in one go on the page's thread, those
   * seconds are a frozen tab. In slices the page keeps drawing and responding
   * while it runs, for the cost of the few yields.
   */
  public async tileInSlices(source: PointCloud, options: TilingOptions, budgetMs = 30): Promise<PointCloudTile[]> {
    const steps = this.partition(source, options);
    let sliceStart = performance.now();
    for (;;) {
      const step = steps.next();
      if (step.done === true) return step.value;
      if (performance.now() - sliceStart < budgetMs) continue;
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }

  /**
   * The partition as a sequence of steps, pausing after every block of points.
   * The per-point loops live in plain functions called from here, because hot
   * loops written directly inside a generator run markedly slower.
   */
  private *partition(source: PointCloud, options: TilingOptions): Generator<void, PointCloudTile[]> {
    const { tileSize } = options;
    if (!Number.isFinite(tileSize) || tileSize <= 0) {
      throw new Error("tileSize must be a finite number greater than zero");
    }

    const { positions, colors, intensity, classification, returnNumber, numberOfReturns, heightAboveGround, objectId, pointCount } = source;
    const originX = source.bounds.min[0];
    const originZ = source.bounds.min[2];
    const columns = Math.max(1, Math.ceil(source.bounds.size[0] / tileSize));
    const rows = Math.max(1, Math.ceil(source.bounds.size[2] / tileSize));

    // Clamped at both ends. A point fractionally outside the declared bounds
    // would otherwise produce a negative index, which a typed array accepts
    // silently on write and reports as undefined on read - a partition that
    // loses points rather than one that fails.
    const clamp = (value: number, limit: number): number => (value < 0 ? 0 : value > limit ? limit : value);
    const cellOf = (offset: number): number =>
      clamp(Math.floor((positions[offset + 2]! - originZ) / tileSize), rows - 1) * columns +
      clamp(Math.floor((positions[offset]! - originX) / tileSize), columns - 1);

    const cellCounts = new Int32Array(columns * rows);
    const count = (first: number, last: number): void => {
      for (let offset = first * 3; offset < last * 3; offset += 3) {
        const cell = cellOf(offset);
        cellCounts[cell] = cellCounts[cell]! + 1;
      }
    };
    for (let first = 0; first < pointCount; first += stepPoints) {
      count(first, Math.min(pointCount, first + stepPoints));
      yield;
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
    // Remaining single-value channels are partitioned exactly like the rest;
    // nothing about them is combined or reinterpreted by tiling.
    const perPoint = ([
      ["classification", classification],
      ["returnNumber", returnNumber],
      ["numberOfReturns", numberOfReturns],
      ["heightAboveGround", heightAboveGround],
      ["objectId", objectId],
    ] as const).flatMap(([key, channel]) =>
      channel === undefined
        ? []
        : [{ key, channel, tiles: cellOfTile.map((cell) => allocateLike(channel, cellCounts[cell]!)) }],
    );
    const cursors = new Int32Array(cellOfTile.length);

    const scatter = (first: number, last: number): void => {
      for (let point = first, offset = first * 3; point < last; point += 1, offset += 3) {
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
        for (const entry of perPoint) entry.tiles[tile]![target] = entry.channel[point]!;
      }
    };
    for (let first = 0; first < pointCount; first += stepPoints) {
      scatter(first, Math.min(pointCount, first + stepPoints));
      yield;
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
          ...Object.fromEntries(perPoint.map((entry) => [entry.key, entry.tiles[tile]!])),
          origin: source.origin,
          name: `${source.name}-tile-${gridX}-${gridZ}`,
        }),
      };
    });
  }
}

/** Points handled between pauses; small enough that a pause is never far away. */
const stepPoints = 1 << 16;

/** A new, empty typed array of the same kind as `source`. */
function allocateLike<T extends Uint8Array | Uint32Array | Float32Array>(source: T, length: number): T {
  return new (source.constructor as new (length: number) => T)(length);
}
