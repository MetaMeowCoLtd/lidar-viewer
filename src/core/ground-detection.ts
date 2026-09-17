import type { PointCloudBounds } from "./point-cloud.js";
import {
  cellIndex,
  fillEmptyCells,
  gridForExtent,
  minimumSurface,
  openSurface,
  raiseIsolatedPits,
  sampleSurface,
  slopeMagnitudes,
  type GridGeometry,
} from "./elevation-grid.js";

/**
 * Tuning for ground detection. Distances are in the scan's own units, which
 * for survey data is metres; the defaults assume metres and match PDAL's
 * `filters.smrf`, so a result here can be compared directly with one from the
 * standard desktop tooling.
 */
export interface GroundDetectionOptions {
  /** Edge length of one surface cell. */
  readonly cellSize: number;
  /** Steepest terrain still treated as ground, as rise over run. */
  readonly slope: number;
  /** Radius of the widest object the filter removes; anything larger reads as terrain. */
  readonly maxWindow: number;
  /** How far a point may sit from the surface and still count as ground, on flat terrain. */
  readonly elevationThreshold: number;
  /** How much that tolerance grows with local slope, so steep ground is not rejected for being steep. */
  readonly elevationScaler: number;
  /** Points this far below the ground surface are labelled low noise rather than left unclassified. */
  readonly lowNoiseDepth: number;
  /** Largest surface grid to build; bigger areas get proportionally larger cells. */
  readonly maxGridCells: number;
}

export const defaultGroundDetectionOptions: GroundDetectionOptions = {
  cellSize: 1,
  slope: 0.15,
  maxWindow: 18,
  elevationThreshold: 0.5,
  elevationScaler: 1.25,
  lowNoiseDepth: 2,
  maxGridCells: 4_000_000,
};

export interface GroundDetectionInput {
  /** Viewer axes: y is up. */
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  /** Existing ASPRS classes, when the scan has them. */
  readonly classification?: Uint8Array | undefined;
}

export interface GroundDetectionStats {
  readonly pointCount: number;
  readonly groundPoints: number;
  readonly lowNoisePoints: number;
  /** Points that already carried a class other than unclassified or ground, and were left alone. */
  readonly preservedPoints: number;
  /** The cell size actually used, which exceeds the request when the area needed a coarser grid. */
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** Surface cells lifted out of pits caused by low outliers. */
  readonly pitsRaised: number;
}

export interface GroundDetectionResult {
  readonly classification: Uint8Array;
  readonly heightAboveGround: Float32Array;
  readonly stats: GroundDetectionStats;
}

/** Called as detection moves through its stages, with overall progress from 0 to 1. */
export type GroundDetectionProgress = (stage: string, fraction: number) => void;

const neverClassified = 0;
const unclassified = 1;
const groundClass = 2;
const lowNoise = 7;
const highNoise = 18;

/**
 * Separates ground from everything standing on it, and measures every
 * point's height above that ground.
 *
 * This is the Simple Morphological Filter (Pingel, Clarke and McBride, 2013).
 *
 * 1. Build a surface from the lowest point in each cell.
 * 2. Open that surface - erode then dilate - with a window that grows one
 *    cell at a time. An opening shaves off anything narrower than its window,
 *    so buildings and trees disappear once the window outgrows them, while
 *    terrain, being wide and smooth, survives. A cell whose height drops by
 *    more than the window can explain as slope is marked as an object.
 * 3. Rebuild the surface from the cells never marked, filling the gaps left
 *    under buildings from the ground around them.
 * 4. A point is ground when it lies within a tolerance of that surface, and
 *    the tolerance widens where the surface is steep.
 *
 * Three departures from the paper, all for real scan data. The window is
 * square rather than round, which lets every opening run in time independent
 * of its size. Openings extend the terrain past the edge of the scan rather
 * than clipping at it, so ground on the uphill side of a sloping tile is not
 * mistaken for an object. And small low pits are lifted out of the first
 * surface before filtering, because a single below-ground outlier otherwise
 * becomes a crater that the opening cannot remove.
 *
 * Existing classifications are respected. Only points that were never
 * classified, unclassified, or already ground are reassigned; a point someone
 * labelled as building keeps that label. Points already labelled as noise are
 * also kept out of the surface, since they are exactly what would distort it.
 */
export function detectGround(
  input: GroundDetectionInput,
  options: GroundDetectionOptions = defaultGroundDetectionOptions,
  onProgress?: GroundDetectionProgress,
): GroundDetectionResult {
  validateOptions(options);
  const { positions, bounds, classification: existing } = input;
  const pointCount = positions.length / 3;
  if (!Number.isInteger(pointCount) || pointCount < 1) throw new Error("positions must contain at least one point");
  if (existing !== undefined && existing.length !== pointCount) {
    throw new Error("classification must contain one value per point");
  }

  const grid = gridForExtent(bounds.min[0], bounds.min[2], bounds.size[0], bounds.size[2], options.cellSize, options.maxGridCells);
  const { cols, rows, cellSize } = grid;
  const cells = cols * rows;

  onProgress?.("Building the lowest surface", 0);
  let skip: Uint8Array | undefined;
  if (existing !== undefined) {
    skip = new Uint8Array(pointCount);
    for (let point = 0; point < pointCount; point += 1) {
      const code = existing[point]!;
      if (code === lowNoise || code === highNoise) skip[point] = 1;
    }
  }
  const lowest = minimumSurface(positions, grid, skip);
  if (!fillEmptyCells(lowest, cols, rows)) throw new Error("Every point in the scan is already marked as noise");
  const pitsRaised = raiseIsolatedPits(lowest, cols, rows, Math.max(2 * options.elevationThreshold, 2 * options.slope * cellSize));

  const maxRadius = Math.max(1, Math.ceil(options.maxWindow / cellSize));
  const isObject = new Uint8Array(cells);
  let previous = Float32Array.from(lowest);
  let opened = new Float32Array(cells);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    onProgress?.("Filtering out buildings and vegetation", 0.1 + 0.6 * ((radius - 1) / maxRadius));
    openSurface(previous, opened, cols, rows, radius);
    const threshold = options.slope * radius * cellSize;
    for (let cell = 0; cell < cells; cell += 1) {
      if (previous[cell]! - opened[cell]! > threshold) isObject[cell] = 1;
    }
    const retired = previous;
    previous = opened;
    opened = retired;
  }
  opened = new Float32Array(0);
  previous = new Float32Array(0);

  onProgress?.("Rebuilding the ground surface", 0.7);
  const surface = new Float32Array(cells);
  for (let cell = 0; cell < cells; cell += 1) surface[cell] = isObject[cell] === 1 ? Number.NaN : lowest[cell]!;
  // A scan with no terrain visible at all - a single rooftop, say - leaves
  // nothing to rebuild from; the lowest surface is the only honest answer.
  if (!fillEmptyCells(surface, cols, rows)) surface.set(lowest);
  const slopes = slopeMagnitudes(surface, grid);

  onProgress?.("Classifying points", 0.78);
  const classification = new Uint8Array(pointCount);
  let groundPoints = 0;
  let lowNoisePoints = 0;
  let preservedPoints = 0;
  for (let point = 0, offset = 0; point < pointCount; point += 1, offset += 3) {
    const previousCode = existing === undefined ? neverClassified : existing[point]!;
    if (previousCode !== neverClassified && previousCode !== unclassified && previousCode !== groundClass) {
      classification[point] = previousCode;
      preservedPoints += 1;
      if (previousCode === lowNoise) lowNoisePoints += 1;
      continue;
    }
    const x = positions[offset]!;
    const z = positions[offset + 2]!;
    const distance = positions[offset + 1]! - sampleSurface(surface, grid, x, z);
    const tolerance = options.elevationThreshold + options.elevationScaler * slopes[cellIndex(grid, x, z)]!;
    if (Math.abs(distance) <= tolerance) {
      classification[point] = groundClass;
      groundPoints += 1;
    } else if (distance < -options.lowNoiseDepth) {
      classification[point] = lowNoise;
      lowNoisePoints += 1;
    } else {
      classification[point] = unclassified;
    }
  }

  onProgress?.("Measuring height above ground", 0.9);
  const heightAboveGround = measureHeightAboveGround(positions, classification, grid, surface)!;

  onProgress?.("Done", 1);
  return {
    classification,
    heightAboveGround,
    stats: { pointCount, groundPoints, lowNoisePoints, preservedPoints, cellSize, cols, rows, pitsRaised },
  };
}

/**
 * Height of every point above the ground beneath it.
 *
 * The filter's own surface is built from minimums, so it sits a little below
 * the real ground wherever there is noise. Once ground points are known, their
 * mean height per cell is the better estimate, and it is that surface -
 * filled in under buildings from the ground around them - that heights are
 * measured against. A scan where nothing qualified as ground falls back to the
 * filter's surface.
 */
function measureHeightAboveGround(
  positions: Float32Array,
  classification: Uint8Array,
  grid: GridGeometry,
  fallback: Float32Array | undefined,
): Float32Array | undefined {
  const ground = meanGroundSurface(positions, classification, grid);
  const surface = fillEmptyCells(ground, grid.cols, grid.rows) ? ground : fallback;
  if (surface === undefined) return undefined;

  const heights = new Float32Array(positions.length / 3);
  for (let point = 0, offset = 0; offset < positions.length; point += 1, offset += 3) {
    heights[point] = positions[offset + 1]! - sampleSurface(surface, grid, positions[offset]!, positions[offset + 2]!);
  }
  return heights;
}

/**
 * The mean height of the ground points in each cell, NaN where a cell has
 * none. Terrain models and height above ground are both measured from it, so
 * the two always agree about where the ground is.
 */
export function meanGroundSurface(positions: Float32Array, classification: Uint8Array, grid: GridGeometry): Float32Array {
  const cells = grid.cols * grid.rows;
  const ground = new Float32Array(cells).fill(Number.NaN);
  const counts = new Uint32Array(cells);
  for (let point = 0, offset = 0; offset < positions.length; point += 1, offset += 3) {
    if (classification[point] !== groundClass) continue;
    const cell = cellIndex(grid, positions[offset]!, positions[offset + 2]!);
    const height = positions[offset + 1]!;
    const count = counts[cell]! + 1;
    counts[cell] = count;
    // A running mean stays accurate in single precision; a running sum of
    // hundreds of heights would not.
    ground[cell] = count === 1 ? height : ground[cell]! + (height - ground[cell]!) / count;
  }
  return ground;
}

/**
 * Height above ground for a scan whose ground is already classified - by a
 * survey contractor, say - without running the filter again. Re-deriving it
 * would quietly overrule their judgement on every point they marked.
 *
 * Returns undefined when too few points are marked as ground to build a
 * surface from: fewer than a hundred, or under half a percent of the scan.
 */
export function heightAboveClassifiedGround(
  input: GroundDetectionInput & { readonly classification: Uint8Array },
  options: GroundDetectionOptions = defaultGroundDetectionOptions,
): Float32Array | undefined {
  const { positions, bounds, classification } = input;
  const pointCount = positions.length / 3;
  let groundPoints = 0;
  for (let point = 0; point < pointCount; point += 1) if (classification[point] === groundClass) groundPoints += 1;
  if (groundPoints < Math.max(100, 0.005 * pointCount)) return undefined;
  const grid = gridForExtent(bounds.min[0], bounds.min[2], bounds.size[0], bounds.size[2], options.cellSize, options.maxGridCells);
  return measureHeightAboveGround(positions, classification, grid, undefined);
}

function validateOptions(options: GroundDetectionOptions): void {
  const positive: (keyof GroundDetectionOptions)[] = ["cellSize", "maxWindow", "elevationThreshold", "maxGridCells"];
  for (const key of positive) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be a finite number greater than zero`);
  }
  const nonNegative: (keyof GroundDetectionOptions)[] = ["slope", "elevationScaler", "lowNoiseDepth"];
  for (const key of nonNegative) {
    if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`${key} must be a finite number of zero or more`);
  }
}
