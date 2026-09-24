import type { PointCloudBounds } from "./point-cloud.js";
import { cellIndex, fillEmptyCells, gridForExtent, type GridGeometry } from "./elevation-grid.js";
import { meanGroundSurface } from "./ground-detection.js";

/**
 * A digital terrain model: the bare ground under a scan as a regular grid of
 * heights, with buildings and vegetation taken away.
 *
 * Each cell holds the mean height of the ground points that fell in it - the
 * same surface height above ground is measured from - and cells with no ground
 * points of their own, under a building or a dense canopy, are filled from the
 * ground around them. Filling stops at the edge of the scan: a cell no point
 * of any kind fell near has no data, so the model never invents ground beyond
 * what was surveyed, across a river the laser could not return from, say.
 */
export interface TerrainOptions {
  /** Edge of a grid cell, in the scan's units. */
  readonly cellSize: number;
  /** The grid coarsens past this many cells rather than exhausting memory. */
  readonly maxGridCells: number;
}

export const defaultTerrainOptions: TerrainOptions = { cellSize: 1, maxGridCells: 4_000_000 };

export interface TerrainInput {
  /** Viewer axes: y is up. */
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly classification: Uint8Array;
}

export interface TerrainModel {
  readonly grid: GridGeometry;
  /** Local ground height at each cell centre, row by row; NaN where the scan has no data. */
  readonly elevations: Float32Array;
  /** 1 where the height was measured from ground points in the cell, 0 where it was filled in or is missing. */
  readonly measured: Uint8Array;
  readonly minElevation: number;
  readonly maxElevation: number;
  readonly measuredCells: number;
  /** Cells with a height, measured or filled. */
  readonly coveredCells: number;
}

const groundClass = 2;
/** Ground cells needed before a surface is worth building: fewer than this is a scan with no real ground in it. */
const minimumGroundCells = 16;

export function buildTerrainModel(input: TerrainInput, options: TerrainOptions = defaultTerrainOptions): TerrainModel {
  const { positions, bounds, classification } = input;
  const pointCount = positions.length / 3;
  if (classification.length !== pointCount) throw new Error("classification must contain one value per point");

  const grid = gridForExtent(bounds.min[0], bounds.min[2], bounds.size[0], bounds.size[2], options.cellSize, options.maxGridCells);
  const { cols, rows } = grid;
  const cells = cols * rows;

  const elevations = meanGroundSurface(positions, classification, grid);
  const measured = new Uint8Array(cells);
  let measuredCells = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    if (elevations[cell] === elevations[cell]) {
      measured[cell] = 1;
      measuredCells += 1;
    }
  }
  if (measuredCells < minimumGroundCells) {
    throw new Error("This scan has too little ground marked to build terrain from. Detect ground first.");
  }

  const covered = footprint(positions, grid);
  fillEmptyCells(elevations, cols, rows);

  let minElevation = Infinity;
  let maxElevation = -Infinity;
  let coveredCells = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    if (covered[cell] === 0) {
      elevations[cell] = Number.NaN;
      continue;
    }
    coveredCells += 1;
    const height = elevations[cell]!;
    if (height < minElevation) minElevation = height;
    if (height > maxElevation) maxElevation = height;
  }

  return { grid, elevations, measured, minElevation, maxElevation, measuredCells, coveredCells };
}

/**
 * The cells a scan actually covers: every cell any point fell in, grown by one
 * cell so a sparse scan's gaps between neighbouring returns do not read as
 * holes in its footprint.
 */
function footprint(positions: Float32Array, grid: GridGeometry): Uint8Array {
  const { cols, rows } = grid;
  const occupied = new Uint8Array(cols * rows);
  for (let offset = 0; offset < positions.length; offset += 3) {
    occupied[cellIndex(grid, positions[offset]!, positions[offset + 2]!)] = 1;
  }
  const covered = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      if (occupied[row * cols + column] === 0) continue;
      for (let dz = -1; dz <= 1; dz += 1) {
        const neighbourRow = row + dz;
        if (neighbourRow < 0 || neighbourRow >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const neighbourColumn = column + dx;
          if (neighbourColumn < 0 || neighbourColumn >= cols) continue;
          covered[neighbourRow * cols + neighbourColumn] = 1;
        }
      }
    }
  }
  return covered;
}

