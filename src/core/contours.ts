import type { TerrainModel } from "./terrain.js";

/**
 * Contour lines: the paths along which the ground sits at a round elevation,
 * traced across a terrain model by marching squares.
 *
 * Levels are round numbers in the scan's own elevation - 35 m, 36 m - not in
 * the viewer's local frame, so the lines match the ones on a survey map of the
 * same place. The terrain is smoothed lightly first: a one-metre grid carries
 * every kerb and bump, and contoured raw it breaks into a litter of tiny rings
 * that hide the shape of the land.
 */
export interface ContourLine {
  /** Local height of the line, in the viewer's frame. */
  readonly level: number;
  /** Index contours - every fourth or fifth - are drawn heavier, as on a printed map. */
  readonly major: boolean;
  /** Vertices as `[x, y, z, ...]` in viewer axes. A closed line does not repeat its first vertex. */
  readonly points: Float32Array;
  readonly closed: boolean;
}

export interface ContourSet {
  readonly interval: number;
  readonly majorInterval: number;
  readonly lines: readonly ContourLine[];
}

export interface ContourOptions {
  /** Elevation between lines; chosen from the terrain's relief when omitted. */
  readonly interval?: number;
  /** Passes of a 3 by 3 mean over the terrain before tracing. */
  readonly smoothingPasses?: number;
  /** Closed rings with fewer vertices than this are bumps, not landforms, and are dropped. */
  readonly minRingVertices?: number;
}

/** Candidate intervals, each paired with how many intervals make an index contour. */
const niceIntervals: readonly (readonly [number, number])[] = [
  [0.1, 5], [0.2, 5], [0.25, 4], [0.5, 5], [1, 5], [2, 5], [2.5, 4], [5, 5], [10, 5], [20, 5], [25, 4], [50, 5], [100, 5], [200, 5], [250, 4], [500, 5],
];

/**
 * A round contour interval giving about `targetLines` lines across `relief`,
 * with index contours at a round multiple of it.
 */
export function contourInterval(relief: number, targetLines = 25): { interval: number; majorEvery: number } {
  const wanted = Math.max(relief, 0) / targetLines;
  for (const [interval, majorEvery] of niceIntervals) {
    if (interval >= wanted) return { interval, majorEvery };
  }
  const [interval, majorEvery] = niceIntervals[niceIntervals.length - 1]!;
  return { interval: interval * Math.ceil(wanted / interval), majorEvery };
}

/**
 * Traces contour lines over a terrain model. `originY` is the local frame's
 * elevation, which is what turns local heights into the scan's elevations.
 */
export function traceContours(model: TerrainModel, originY: number, options: ContourOptions = {}): ContourSet {
  const { smoothingPasses = 2, minRingVertices = 8 } = options;
  const chosen = options.interval === undefined ? contourInterval(model.maxElevation - model.minElevation) : { interval: options.interval, majorEvery: 5 };
  const { interval, majorEvery } = chosen;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error("interval must be a finite number greater than zero");

  const { cols, rows, originX, originZ, cellSize } = model.grid;
  const heights = smooth(model.elevations, cols, rows, smoothingPasses);

  // Crossings are gathered per level as pairs of edge ids. An edge id names a
  // grid edge between two cell centres - even for the edge to the right of a
  // centre, odd for the edge below it - so a crossing shared by two squares
  // carries the same id from both, which is what lets segments be chained.
  const segmentsByLevel = new Map<number, number[]>();
  const push = (level: number, from: number, to: number) => {
    const list = segmentsByLevel.get(level);
    if (list === undefined) segmentsByLevel.set(level, [from, to]);
    else list.push(from, to);
  };
  const rightEdge = (row: number, column: number) => 2 * (row * cols + column);
  const downEdge = (row: number, column: number) => 2 * (row * cols + column) + 1;

  for (let row = 0; row + 1 < rows; row += 1) {
    for (let column = 0; column + 1 < cols; column += 1) {
      const v0 = heights[row * cols + column]!;
      const v1 = heights[row * cols + column + 1]!;
      const v2 = heights[(row + 1) * cols + column + 1]!;
      const v3 = heights[(row + 1) * cols + column]!;
      // Any NaN corner makes this false: squares at the edge of the scan are left open.
      if (!(v0 === v0 && v1 === v1 && v2 === v2 && v3 === v3)) continue;
      const low = Math.min(v0, v1, v2, v3);
      const high = Math.max(v0, v1, v2, v3);
      const top = rightEdge(row, column);
      const right = downEdge(row, column + 1);
      const bottom = rightEdge(row + 1, column);
      const left = downEdge(row, column);
      // Levels strictly above the lowest corner and at or below the highest; a
      // corner exactly on a level counts as above it, so no level is traced twice.
      for (let k = Math.floor((low + originY) / interval) + 1; k * interval - originY <= high; k += 1) {
        const level = k * interval - originY;
        const index = (v0 >= level ? 1 : 0) | (v1 >= level ? 2 : 0) | (v2 >= level ? 4 : 0) | (v3 >= level ? 8 : 0);
        switch (index) {
          case 1: case 14: push(k, left, top); break;
          case 2: case 13: push(k, top, right); break;
          case 3: case 12: push(k, left, right); break;
          case 4: case 11: push(k, right, bottom); break;
          case 6: case 9: push(k, top, bottom); break;
          case 7: case 8: push(k, left, bottom); break;
          case 5: case 10: {
            // A saddle: two opposite corners above the level, two below. The
            // mean of all four decides which pair the land connects through.
            const centreAbove = (v0 + v1 + v2 + v3) / 4 >= level;
            if ((index === 5) === centreAbove) {
              push(k, top, right);
              push(k, bottom, left);
            } else {
              push(k, left, top);
              push(k, right, bottom);
            }
            break;
          }
          default:
            break;
        }
      }
    }
  }

  const crossing = (edge: number, level: number, out: number[]) => {
    const node = edge >> 1;
    const row = Math.floor(node / cols);
    const column = node - row * cols;
    const [toRow, toColumn] = (edge & 1) === 0 ? [row, column + 1] : [row + 1, column];
    const from = heights[node]!;
    const to = heights[toRow * cols + toColumn]!;
    const t = to === from ? 0.5 : (level - from) / (to - from);
    out.push(
      originX + (column + 0.5 + t * (toColumn - column)) * cellSize,
      level,
      originZ + (row + 0.5 + t * (toRow - row)) * cellSize,
    );
  };

  const lines: ContourLine[] = [];
  for (const [k, pairs] of [...segmentsByLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const level = k * interval - originY;
    const major = k % majorEvery === 0;
    for (const chain of chainSegments(pairs)) {
      if (chain.closed ? chain.edges.length < minRingVertices : chain.edges.length < 2) continue;
      const points: number[] = [];
      for (const edge of chain.edges) crossing(edge, level, points);
      lines.push({ level, major, points: Float32Array.from(points), closed: chain.closed });
    }
  }
  return { interval, majorInterval: interval * majorEvery, lines };
}

/**
 * Joins segments that share an edge into polylines. Every edge is crossed by
 * at most two segments - one from each square on either side of it - so each
 * polyline is a simple walk: open lines start from an edge only one segment
 * touches, and whatever remains afterwards are closed rings.
 */
function chainSegments(pairs: readonly number[]): { edges: number[]; closed: boolean }[] {
  const segmentCount = pairs.length / 2;
  const touching = new Map<number, number[]>();
  for (let segment = 0; segment < segmentCount; segment += 1) {
    for (const edge of [pairs[segment * 2]!, pairs[segment * 2 + 1]!]) {
      const list = touching.get(edge);
      if (list === undefined) touching.set(edge, [segment]);
      else list.push(segment);
    }
  }

  const used = new Uint8Array(segmentCount);
  const walk = (startEdge: number): { edges: number[]; closed: boolean } => {
    const edges = [startEdge];
    let edge = startEdge;
    for (;;) {
      const next = touching.get(edge)!.find((segment) => used[segment] === 0);
      if (next === undefined) return { edges, closed: false };
      used[next] = 1;
      edge = pairs[next * 2] === edge ? pairs[next * 2 + 1]! : pairs[next * 2]!;
      if (edge === startEdge) return { edges, closed: true };
      edges.push(edge);
    }
  };

  const chains: { edges: number[]; closed: boolean }[] = [];
  for (const [edge, segments] of touching) {
    if (segments.length === 1 && used[segments[0]!] === 0) chains.push(walk(edge));
  }
  for (let segment = 0; segment < segmentCount; segment += 1) {
    if (used[segment] === 0) chains.push(walk(pairs[segment * 2]!));
  }
  return chains;
}

/** Repeated 3 by 3 means over the cells that have data; cells without data stay without it. */
function smooth(values: Float32Array, cols: number, rows: number, passes: number): Float32Array {
  let current = Float32Array.from(values);
  let next = new Float32Array(values.length);
  for (let pass = 0; pass < passes; pass += 1) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < cols; column += 1) {
        const cell = row * cols + column;
        const centre = current[cell]!;
        if (centre !== centre) {
          next[cell] = Number.NaN;
          continue;
        }
        let sum = 0;
        let count = 0;
        for (let dz = row > 0 ? -1 : 0; dz <= (row + 1 < rows ? 1 : 0); dz += 1) {
          for (let dx = column > 0 ? -1 : 0; dx <= (column + 1 < cols ? 1 : 0); dx += 1) {
            const value = current[cell + dz * cols + dx]!;
            if (value === value) {
              sum += value;
              count += 1;
            }
          }
        }
        next[cell] = sum / count;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }
  return current;
}
