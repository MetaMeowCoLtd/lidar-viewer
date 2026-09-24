import type { PointCloudBounds, PointCloudOrigin } from "./point-cloud.js";
import { isNoiseClass } from "./noise-detection.js";

/** A surveyed checkpoint in the scan's own map coordinates: easting, northing, elevation. */
export interface Checkpoint {
  readonly name: string;
  readonly east: number;
  readonly north: number;
  readonly elevation: number;
}

export interface QualityReportInput {
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly origin: PointCloudOrigin;
  readonly classification?: Uint8Array | undefined;
  readonly returnNumber?: Uint8Array | undefined;
  readonly numberOfReturns?: Uint8Array | undefined;
  readonly pointSourceId?: Uint16Array | undefined;
  readonly checkpoints?: readonly Checkpoint[] | undefined;
}

export interface QualityReportOptions {
  /** Edge of a density cell in metres. One metre is the usual reporting grid. */
  readonly cellSize: number;
  /** How far from a checkpoint ground points are used to interpolate the surface, in metres. */
  readonly checkpointRadius: number;
  /** Largest spread of heights inside a cell for it to count as a flat surface when comparing strips. */
  readonly flatness: number;
}

export const defaultQualityReportOptions: QualityReportOptions = { cellSize: 1, checkpointRadius: 1, flatness: 0.05 };

/** USGS 3DEP quality levels (Lidar Base Specification): least density and largest non-vegetated RMSEz. */
export const qualityLevels = [
  { name: "QL0", density: 8, rmsez: 0.05 },
  { name: "QL1", density: 8, rmsez: 0.1 },
  { name: "QL2", density: 2, rmsez: 0.1 },
  { name: "QL3", density: 0.5, rmsez: 0.2 },
] as const;

export interface DensityResult {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** First (or only) returns per square metre, cell by cell; NaN outside the scan's footprint. */
  readonly grid: Float32Array;
  /** Whether the densities count first returns - the pulse density the USGS specifies - or every point. */
  readonly firstReturnsOnly: boolean;
  readonly mean: number;
  readonly median: number;
  /** The density that 95% of the footprint reaches or beats. */
  readonly p5: number;
  /** Share of the footprint below 2 and below 8 points per square metre. */
  readonly belowTwo: number;
  readonly belowEight: number;
}

export interface CoverageResult {
  /** Area the scan spans, in square metres, excluding empty ground outside its outline. */
  readonly footprintArea: number;
  readonly gapArea: number;
  readonly gapShare: number;
  /** Separate patches of the footprint with no returns at all. */
  readonly gapRegions: number;
  readonly largestGapArea: number;
}

export interface StripPair {
  readonly a: number;
  readonly b: number;
  /** Flat cells both strips measured. */
  readonly cells: number;
  /** Median of strip b minus strip a, in metres. */
  readonly medianOffset: number;
  readonly rmsOffset: number;
}

export interface StripResult {
  readonly strips: readonly number[];
  readonly pairs: readonly StripPair[];
  /** Root mean square of every flat-cell difference between overlapping strips. */
  readonly rmsOffset: number;
  /** Share of the footprint seen by more than one strip. */
  readonly overlapShare: number;
}

export interface CheckpointResidual {
  readonly name: string;
  readonly east: number;
  readonly north: number;
  readonly elevation: number;
  /** Scan surface minus checkpoint, in metres; undefined when no ground was close enough to measure. */
  readonly residual: number | undefined;
}

export interface AccuracyResult {
  readonly checkpoints: readonly CheckpointResidual[];
  readonly measured: number;
  readonly meanError: number;
  readonly rmsez: number;
  /** ASPRS 2014 non-vegetated vertical accuracy at 95% confidence: 1.96 × RMSEz. */
  readonly nva95: number;
  readonly largestError: number;
  /** Whether the surface came from ground-classified points or had to fall back to the lowest points. */
  readonly fromGround: boolean;
}

export interface QualityReport {
  readonly pointCount: number;
  readonly density: DensityResult;
  readonly coverage: CoverageResult;
  readonly strips: StripResult | undefined;
  readonly noise: { readonly points: number; readonly share: number; readonly labelled: boolean };
  readonly accuracy: AccuracyResult | undefined;
  /** The best USGS quality level the density - and the accuracy, when checkpoints were given - satisfy. */
  readonly qualityLevel: string | undefined;
}

export type QualityReportProgress = (stage: string, fraction: number) => void;

/**
 * The checks a survey is signed off on, in one pass over the scan:
 *
 * - **Density**: first returns per square metre on a one-metre grid, against
 *   the USGS quality levels (at least 8 per m² for QL1, 2 for QL2).
 * - **Coverage**: cells inside the scan's outline that no pulse reached - a
 *   missed strip, a shadow, or water.
 * - **Strip alignment**: where two flight lines overlap on flat, hard ground,
 *   the difference between their mean heights. Anything more than a few
 *   centimetres is a boresight or trajectory error that shows up as doubled
 *   surfaces.
 * - **Noise**: the share labelled as noise, when noise has been found.
 * - **Vertical accuracy**: the ground surface interpolated at each surveyed
 *   checkpoint, reported as RMSEz and the 95% figure ASPRS asks for.
 */
export function buildQualityReport(
  input: QualityReportInput,
  options: QualityReportOptions = defaultQualityReportOptions,
  onProgress?: QualityReportProgress,
): QualityReport {
  const { positions, bounds, classification } = input;
  const pointCount = positions.length / 3;
  if (!Number.isInteger(pointCount) || pointCount < 1) throw new Error("positions must contain at least one point");
  if (!(options.cellSize > 0) || !(options.checkpointRadius > 0) || !(options.flatness > 0)) throw new Error("Quality report options must be positive");

  onProgress?.("Measuring density", 0);
  let cellSize = options.cellSize;
  while ((bounds.size[0] / cellSize + 1) * (bounds.size[2] / cellSize + 1) > 16_000_000) cellSize *= 2;
  const cols = Math.max(1, Math.floor(bounds.size[0] / cellSize) + 1);
  const rows = Math.max(1, Math.floor(bounds.size[2] / cellSize) + 1);
  const cells = cols * rows;
  const cellOf = (x: number, z: number) =>
    Math.min(rows - 1, Math.max(0, Math.floor((z - bounds.min[2]) / cellSize))) * cols + Math.min(cols - 1, Math.max(0, Math.floor((x - bounds.min[0]) / cellSize)));

  const firstReturnsOnly = input.returnNumber !== undefined;
  const counts = new Uint32Array(cells);
  const any = new Uint8Array(cells);
  let noisePoints = 0;
  for (let point = 0; point < pointCount; point += 1) {
    const code = classification?.[point];
    if (code !== undefined && isNoiseClass(code)) {
      noisePoints += 1;
      continue;
    }
    const cell = cellOf(positions[point * 3]!, positions[point * 3 + 2]!);
    any[cell] = 1;
    if (!firstReturnsOnly || input.returnNumber![point]! <= 1) counts[cell] = counts[cell]! + 1;
  }

  // The footprint: every cell between the first and last occupied cell of its
  // row and of its column, so the empty corners of a rotated or irregular
  // survey are not counted as missing data.
  const inside = footprint(any, cols, rows);
  const area = cellSize * cellSize;
  const grid = new Float32Array(cells).fill(Number.NaN);
  const densities: number[] = [];
  for (let cell = 0; cell < cells; cell += 1) {
    if (inside[cell] === 0) continue;
    grid[cell] = counts[cell]! / area;
    densities.push(grid[cell]!);
  }
  densities.sort((a, b) => a - b);
  const quantile = (fraction: number) => (densities.length === 0 ? 0 : densities[Math.min(densities.length - 1, Math.floor(fraction * densities.length))]!);
  const density: DensityResult = {
    cellSize,
    cols,
    rows,
    grid,
    firstReturnsOnly,
    mean: densities.reduce((sum, value) => sum + value, 0) / Math.max(1, densities.length),
    median: quantile(0.5),
    p5: quantile(0.05),
    belowTwo: densities.filter((value) => value < 2).length / Math.max(1, densities.length),
    belowEight: densities.filter((value) => value < 8).length / Math.max(1, densities.length),
  };

  onProgress?.("Finding coverage gaps", 0.25);
  const coverage = gaps(any, inside, cols, rows, area);

  onProgress?.("Comparing overlapping strips", 0.4);
  const strips = input.pointSourceId === undefined ? undefined : compareStrips(input, cellOf, cells, inside, options.flatness);

  onProgress?.("Checking against checkpoints", 0.8);
  const accuracy = input.checkpoints === undefined || input.checkpoints.length === 0 ? undefined : checkAccuracy(input, options.checkpointRadius);

  let qualityLevel: string | undefined;
  for (const level of qualityLevels) {
    const dense = density.median >= level.density;
    const accurate = accuracy === undefined || accuracy.measured === 0 || accuracy.rmsez <= level.rmsez;
    if (dense && accurate) {
      qualityLevel = level.name;
      break;
    }
  }
  // Without checkpoints, QL0 and QL1 differ only in accuracy; claim no more than the density shows.
  if (accuracy === undefined && qualityLevel === "QL0") qualityLevel = "QL1";

  onProgress?.("Done", 1);
  return {
    pointCount,
    density,
    coverage,
    strips,
    noise: { points: noisePoints, share: noisePoints / pointCount, labelled: classification !== undefined },
    accuracy,
    qualityLevel,
  };
}

function footprint(any: Uint8Array, cols: number, rows: number): Uint8Array {
  const rowFirst = new Int32Array(rows).fill(cols);
  const rowLast = new Int32Array(rows).fill(-1);
  const colFirst = new Int32Array(cols).fill(rows);
  const colLast = new Int32Array(cols).fill(-1);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (any[row * cols + col] === 0) continue;
      if (col < rowFirst[row]!) rowFirst[row] = col;
      if (col > rowLast[row]!) rowLast[row] = col;
      if (row < colFirst[col]!) colFirst[col] = row;
      if (row > colLast[col]!) colLast[col] = row;
    }
  }
  const inside = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (col >= rowFirst[row]! && col <= rowLast[row]! && row >= colFirst[col]! && row <= colLast[col]!) inside[row * cols + col] = 1;
    }
  }
  return inside;
}

function gaps(any: Uint8Array, inside: Uint8Array, cols: number, rows: number, area: number): CoverageResult {
  let footprintCells = 0;
  let gapCells = 0;
  let regions = 0;
  let largest = 0;
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  for (let cell = 0; cell < cols * rows; cell += 1) {
    if (inside[cell] === 0) continue;
    footprintCells += 1;
    if (any[cell] === 1) continue;
    gapCells += 1;
    if (seen[cell] === 1) continue;
    // Flood-fill one gap to size it.
    regions += 1;
    let size = 0;
    stack.push(cell);
    seen[cell] = 1;
    while (stack.length > 0) {
      const current = stack.pop()!;
      size += 1;
      const col = current % cols;
      const row = (current - col) / cols;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const next = r * cols + c;
        if (seen[next] === 1 || inside[next] === 0 || any[next] === 1) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    largest = Math.max(largest, size);
  }
  return {
    footprintArea: footprintCells * area,
    gapArea: gapCells * area,
    gapShare: gapCells / Math.max(1, footprintCells),
    gapRegions: regions,
    largestGapArea: largest * area,
  };
}

function compareStrips(
  input: QualityReportInput,
  cellOf: (x: number, z: number) => number,
  cells: number,
  inside: Uint8Array,
  flatness: number,
): StripResult | undefined {
  const { positions, classification, numberOfReturns } = input;
  const sources = input.pointSourceId!;
  const pointCount = positions.length / 3;
  const hasGround = classification !== undefined && classification.some((code) => code === 2);

  // Per cell and strip: count, sum and sum of squares of heights, of hard surfaces only -
  // ground when it is known, otherwise single returns, which leaves canopy out.
  const stats = new Map<number, [number, number, number]>();
  const stripSet = new Set<number>();
  for (let point = 0; point < pointCount; point += 1) {
    const code = classification?.[point];
    if (code !== undefined && isNoiseClass(code)) continue;
    if (hasGround ? code !== 2 : numberOfReturns !== undefined && numberOfReturns[point]! > 1) continue;
    const strip = sources[point]!;
    stripSet.add(strip);
    const key = cellOf(positions[point * 3]!, positions[point * 3 + 2]!) * 65_536 + strip;
    const y = positions[point * 3 + 1]!;
    const entry = stats.get(key);
    if (entry === undefined) stats.set(key, [1, y, y * y]);
    else {
      entry[0] += 1;
      entry[1] += y;
      entry[2] += y * y;
    }
  }
  const strips = [...stripSet].sort((a, b) => a - b);
  if (strips.length < 2) return { strips, pairs: [], rmsOffset: 0, overlapShare: 0 };

  // Group the per-strip means by cell.
  const byCell = new Map<number, Array<[number, number]>>();
  const seenBy = new Map<number, number>();
  for (const [key, [count, sum, sumSq]] of stats) {
    const cell = Math.floor(key / 65_536);
    const strip = key - cell * 65_536;
    seenBy.set(cell, (seenBy.get(cell) ?? 0) + 1);
    if (count < 3) continue;
    const mean = sum / count;
    const spread = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    if (spread > flatness) continue;
    const list = byCell.get(cell);
    if (list === undefined) byCell.set(cell, [[strip, mean]]);
    else list.push([strip, mean]);
  }

  const offsets = new Map<number, number[]>();
  const all: number[] = [];
  for (const list of byCell.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const key = list[i]![0] * 65_536 + list[j]![0];
        const dz = list[j]![1] - list[i]![1];
        const entry = offsets.get(key);
        if (entry === undefined) offsets.set(key, [dz]);
        else entry.push(dz);
        all.push(dz);
      }
    }
  }
  const pairs: StripPair[] = [...offsets.entries()]
    .map(([key, values]) => {
      values.sort((a, b) => a - b);
      return {
        a: Math.floor(key / 65_536),
        b: key % 65_536,
        cells: values.length,
        medianOffset: values[Math.floor(values.length / 2)]!,
        rmsOffset: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length),
      };
    })
    .filter((pair) => pair.cells >= 20)
    .sort((a, b) => a.a - b.a || a.b - b.b);

  let footprintCells = 0;
  for (let cell = 0; cell < cells; cell += 1) if (inside[cell] === 1) footprintCells += 1;
  let overlapCells = 0;
  for (const count of seenBy.values()) if (count > 1) overlapCells += 1;

  return {
    strips,
    pairs,
    rmsOffset: all.length === 0 ? 0 : Math.sqrt(all.reduce((sum, value) => sum + value * value, 0) / all.length),
    overlapShare: overlapCells / Math.max(1, footprintCells),
  };
}

function checkAccuracy(input: QualityReportInput, radius: number): AccuracyResult {
  const { positions, classification, origin } = input;
  const pointCount = positions.length / 3;
  const fromGround = classification !== undefined && classification.some((code) => code === 2);
  const checkpoints = input.checkpoints!;

  // Local frame positions of every checkpoint: x east, z south.
  const targets = checkpoints.map((checkpoint) => ({
    x: checkpoint.east - origin[0],
    z: -checkpoint.north - origin[2],
    y: checkpoint.elevation - origin[1],
  }));
  const near: Array<Array<[number, number]>> = targets.map(() => []);
  const radiusSq = radius * radius;
  for (let point = 0; point < pointCount; point += 1) {
    const code = classification?.[point];
    if (code !== undefined && isNoiseClass(code)) continue;
    if (fromGround && code !== 2) continue;
    const x = positions[point * 3]!;
    const z = positions[point * 3 + 2]!;
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      const dx = x - target.x;
      const dz = z - target.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq <= radiusSq) near[index]!.push([distanceSq, positions[point * 3 + 1]!]);
    }
  }

  const residuals: CheckpointResidual[] = checkpoints.map((checkpoint, index) => {
    let found = near[index]!;
    if (found.length < 3) return { ...checkpoint, residual: undefined };
    // Without a ground class, the lowest third stands in for the ground under whatever is on it.
    if (!fromGround) {
      found = [...found].sort((a, b) => a[1] - b[1]).slice(0, Math.max(3, Math.ceil(found.length / 3)));
    }
    // Inverse-distance weighting of the surrounding ground heights.
    let weights = 0;
    let sum = 0;
    for (const [distanceSq, y] of found) {
      const weight = 1 / Math.max(distanceSq, 1e-4);
      weights += weight;
      sum += weight * y;
    }
    return { ...checkpoint, residual: sum / weights - targets[index]!.y };
  });

  const measured = residuals.filter((entry) => entry.residual !== undefined).map((entry) => entry.residual!);
  const rmsez = measured.length === 0 ? 0 : Math.sqrt(measured.reduce((total, value) => total + value * value, 0) / measured.length);
  return {
    checkpoints: residuals,
    measured: measured.length,
    meanError: measured.length === 0 ? 0 : measured.reduce((total, value) => total + value, 0) / measured.length,
    rmsez,
    nva95: 1.96 * rmsez,
    largestError: measured.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0),
    fromGround,
  };
}

/**
 * Reads checkpoints from CSV text: one per line as name, easting, northing,
 * elevation, or just easting, northing, elevation. A header line, blank lines
 * and lines that are not numbers are skipped.
 */
export function parseCheckpoints(text: string): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split(/[,;\t]/).map((field) => field.trim()).filter((field) => field.length > 0);
    if (fields.length < 3) continue;
    const numbers = fields.slice(-3).map(Number);
    if (!numbers.every((value) => Number.isFinite(value))) continue;
    const name = fields.length >= 4 ? fields[0]! : `CP${checkpoints.length + 1}`;
    checkpoints.push({ name, east: numbers[0]!, north: numbers[1]!, elevation: numbers[2]! });
  }
  return checkpoints;
}
