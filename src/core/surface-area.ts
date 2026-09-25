import type { PointCloud } from "./point-cloud.js";

/**
 * The scan's top surface as a height grid: for each cell of the horizontal
 * plane, the highest point in it, which is what a roof or a road looks like
 * from above. Empty cells hold NaN.
 */
export interface SurfaceGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** Local x and z of the grid's corner. */
  readonly originX: number;
  readonly originZ: number;
  readonly top: Float32Array;
}

/** A surface found from a click: its cells, its area and slope, and the outline to draw around it. */
export interface SurfaceSelection {
  /** Area on the map, as a plan measures it, in square metres. */
  readonly planArea: number;
  /** Area along the surface itself: larger than the plan area on a sloped roof. */
  readonly surfaceArea: number;
  /** Tilt of the surface from level, in degrees. */
  readonly slopeDegrees: number;
  /** Mean height of the surface, in the scan's local frame. */
  readonly meanHeight: number;
  /** Where to put its label: the middle of the surface, on it. */
  readonly centre: readonly [number, number, number];
  /** Its boundary, as line segments laid on the surface: x, y, z of each end. */
  readonly outline: Float32Array;
  readonly cellCount: number;
}

export interface SurfaceOptions {
  /**
   * How far, in metres, a cell may step off the surface from the cell next to
   * it, once the surface's own slope is allowed for. A continuous surface
   * moves on smoothly; a wall, a parapet, a kerb or a ridge is a step.
   */
  readonly tolerance: number;
  /**
   * How far a cell may drift from the plane that best fits the whole surface.
   * Loose, so a surface that sags, drains or curves gently - a big flat roof,
   * a vaulted hall - is still one surface.
   */
  readonly drift: number;
  /** A ceiling on the cells one surface may take, so a click on open ground cannot run away. */
  readonly maxCells: number;
}

export const defaultSurfaceOptions: SurfaceOptions = { tolerance: 0.12, drift: 0.6, maxCells: 4_000_000 };

/**
 * A cell edge a little over twice the typical spacing between points, so
 * nearly every cell of a surface holds a point: finer grids leave holes in
 * a sparse scan, coarser ones round off the edges of a roof.
 */
export function surfaceCellSize(cloud: PointCloud): number {
  const area = Math.max(1, cloud.bounds.size[0] * cloud.bounds.size[2]);
  const spacing = Math.sqrt(area / Math.max(1, cloud.pointCount));
  return Math.min(1, Math.max(0.25, spacing * 2.5));
}

export function buildSurfaceGrid(cloud: PointCloud, cellSize = surfaceCellSize(cloud)): SurfaceGrid {
  const { positions, pointCount, bounds } = cloud;
  const originX = bounds.min[0];
  const originZ = bounds.min[2];
  const cols = Math.max(1, Math.ceil(bounds.size[0] / cellSize) + 1);
  const rows = Math.max(1, Math.ceil(bounds.size[2] / cellSize) + 1);
  const top = new Float32Array(cols * rows).fill(Number.NaN);
  const noise = cloud.classification;
  for (let point = 0; point < pointCount; point += 1) {
    // Noise would stand up out of a roof as a spike; it is left out.
    if (noise !== undefined && (noise[point] === 7 || noise[point] === 18)) continue;
    const col = Math.floor((positions[point * 3]! - originX) / cellSize);
    const row = Math.floor((positions[point * 3 + 2]! - originZ) / cellSize);
    if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
    const cell = row * cols + col;
    const y = positions[point * 3 + 1]!;
    if (!(top[cell]! >= y)) top[cell] = y;
  }
  fillSpeckles(top, cols, rows);
  return { cellSize, cols, rows, originX, originZ, top };
}

/**
 * Fills the scattered empty cells a thinned or sparse scan leaves across a
 * surface: an empty cell with at least half its eight neighbours filled takes
 * their mean height. Twice, so pairs of empty cells close too. Wider gaps -
 * water, a courtyard's shadow, the edge of the scan - stay empty.
 */
function fillSpeckles(top: Float32Array, cols: number, rows: number): void {
  for (let pass = 0; pass < 2; pass += 1) {
    const source = top.slice();
    for (let row = 1; row < rows - 1; row += 1) {
      for (let col = 1; col < cols - 1; col += 1) {
        const cell = row * cols + col;
        if (Number.isFinite(source[cell]!)) continue;
        let sum = 0;
        let count = 0;
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            const value = source[cell + dr * cols + dc]!;
            if (Number.isFinite(value)) {
              sum += value;
              count += 1;
            }
          }
        }
        if (count >= 4) top[cell] = sum / count;
      }
    }
  }
}

/**
 * Grows the continuous surface under a point out from it, cell by cell. A
 * neighbour joins when it carries on from the cell beside it: its height is
 * where the surface's slope says it should be, within the tolerance. A wall, a
 * parapet, a kerb or a ridge is a step and ends the surface; a gentle sag or
 * curve does not. The slope comes from a plane fitted to the surface, fitted
 * again as it grows. Holes inside the surface where no
 * point fell - under a skylight, or between sparse points - count towards its
 * area, as they would on a plan.
 */
export function selectSurface(grid: SurfaceGrid, x: number, z: number, options: SurfaceOptions = defaultSurfaceOptions): SurfaceSelection | undefined {
  const { cellSize, cols, rows, originX, originZ, top } = grid;
  const seedCol = Math.floor((x - originX) / cellSize);
  const seedRow = Math.floor((z - originZ) / cellSize);
  const seed = nearestFilled(grid, seedCol, seedRow);
  if (seed === undefined) return undefined;

  const cx = (cell: number) => originX + ((cell % cols) + 0.5) * cellSize;
  const cz = (cell: number) => originZ + (Math.floor(cell / cols) + 0.5) * cellSize;

  // Running sums for a least-squares plane y = a x + b z + c, in coordinates
  // relative to the seed so the sums stay well conditioned.
  const x0 = cx(seed);
  const z0 = cz(seed);
  const sums = { n: 0, x: 0, z: 0, y: 0, xx: 0, xz: 0, zz: 0, xy: 0, zy: 0 };
  const add = (cell: number) => {
    const dx = cx(cell) - x0;
    const dz = cz(cell) - z0;
    const y = top[cell]!;
    sums.n += 1;
    sums.x += dx;
    sums.z += dz;
    sums.y += y;
    sums.xx += dx * dx;
    sums.xz += dx * dz;
    sums.zz += dz * dz;
    sums.xy += dx * y;
    sums.zy += dz * y;
  };
  let plane = { a: 0, b: 0, c: top[seed]! };
  const fit = () => {
    const next = solvePlane(sums);
    if (next !== undefined) plane = next;
  };
  const offPlane = (cell: number) => Math.abs(top[cell]! - (plane.a * (cx(cell) - x0) + plane.b * (cz(cell) - z0) + plane.c));
  const reset = () => {
    sums.n = 0;
    sums.x = sums.z = sums.y = sums.xx = sums.xz = sums.zz = sums.xy = sums.zy = 0;
  };

  // The first plane comes from every filled cell around the seed, fitted and
  // then fitted again without the cells that lie off it - an edge, a chimney -
  // so a steep surface starts off at its own tilt rather than level.
  const around: number[] = [];
  for (let dr = -3; dr <= 3; dr += 1) {
    for (let dc = -3; dc <= 3; dc += 1) {
      const col = (seed % cols) + dc;
      const row = Math.floor(seed / cols) + dr;
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      const cell = row * cols + col;
      if (Number.isFinite(top[cell]!)) around.push(cell);
    }
  }
  let kept = around;
  for (let round = 0; round < 3; round += 1) {
    reset();
    for (const cell of kept) add(cell);
    fit();
    const next = kept.filter((cell) => offPlane(cell) <= options.tolerance * 1.5);
    // Keep the seed's side of an edge: when the fit straddles two surfaces, the cells nearest the seed's height win.
    if (next.length < 6 || next.length === kept.length) break;
    kept = next;
  }
  if (offPlane(seed) > options.tolerance * 1.5) {
    // The seed is not on the fitted plane - it sits on a small step of its own: start level at its height.
    plane = { a: 0, b: 0, c: top[seed]! };
  }
  reset();

  // The height a neighbour should have if it carries on from a cell along the surface's slope.
  const expected = (from: number, dc: number, dr: number) => top[from]! + (plane.a * dc + plane.b * dr) * cellSize;

  const inRegion = new Uint8Array(cols * rows);
  const queue = new Int32Array(Math.min(cols * rows, options.maxCells) + 1);
  let head = 0;
  let tail = 0;
  inRegion[seed] = 1;
  queue[tail++] = seed;
  add(seed);
  let nextFit = 16;
  while (head < tail) {
    const cell = queue[head++]!;
    const col = cell % cols;
    const row = (cell - col) / cols;
    for (const [dc, dr] of neighbours) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const next = nr * cols + nc;
      if (inRegion[next] !== 0 || !Number.isFinite(top[next]!)) continue;
      if (Math.abs(top[next]! - expected(cell, dc, dr)) > options.tolerance || offPlane(next) > options.drift) continue;
      if (tail >= queue.length) break;
      inRegion[next] = 1;
      queue[tail++] = next;
      add(next);
      if (sums.n >= nextFit) {
        fit();
        nextFit *= 2;
      }
    }
  }
  fit();

  const filled = fillHoles(grid, inRegion);
  const cellCount = tail + filled;
  const planArea = cellCount * cellSize * cellSize;
  const slopeCos = 1 / Math.sqrt(1 + plane.a * plane.a + plane.b * plane.b);
  const surfaceY = (px: number, pz: number) => plane.a * (px - x0) + plane.b * (pz - z0) + plane.c;
  const meanX = x0 + sums.x / sums.n;
  const meanZ = z0 + sums.z / sums.n;
  // The label goes on a cell of the surface nearest its middle, as an L-shaped roof's middle may lie off it.
  let centreCell = seed;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < tail; index += 1) {
    const cell = queue[index]!;
    const distance = (cx(cell) - meanX) ** 2 + (cz(cell) - meanZ) ** 2;
    if (distance < best) {
      best = distance;
      centreCell = cell;
    }
  }
  return {
    planArea,
    surfaceArea: planArea / slopeCos,
    slopeDegrees: (Math.acos(slopeCos) * 180) / Math.PI,
    meanHeight: sums.y / sums.n,
    centre: [cx(centreCell), surfaceY(cx(centreCell), cz(centreCell)), cz(centreCell)],
    outline: outlineOf(grid, inRegion, surfaceY),
    cellCount,
  };
}

const neighbours = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function solvePlane(s: { n: number; x: number; z: number; y: number; xx: number; xz: number; zz: number; xy: number; zy: number }): { a: number; b: number; c: number } | undefined {
  if (s.n < 3) return undefined;
  // Normal equations for y = a x + b z + c, solved by Cramer's rule.
  const m = [
    [s.xx, s.xz, s.x],
    [s.xz, s.zz, s.z],
    [s.x, s.z, s.n],
  ] as const;
  const r = [s.xy, s.zy, s.y] as const;
  const det = (q: readonly (readonly number[])[]) =>
    q[0]![0]! * (q[1]![1]! * q[2]![2]! - q[1]![2]! * q[2]![1]!) - q[0]![1]! * (q[1]![0]! * q[2]![2]! - q[1]![2]! * q[2]![0]!) + q[0]![2]! * (q[1]![0]! * q[2]![1]! - q[1]![1]! * q[2]![0]!);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return undefined;
  const replace = (column: number) => m.map((row, index) => row.map((value, c) => (c === column ? r[index]! : value)));
  return { a: det(replace(0)) / d, b: det(replace(1)) / d, c: det(replace(2)) / d };
}

/** The filled cell nearest a cell, looking a few cells around it, for a click that lands in a gap. */
function nearestFilled(grid: SurfaceGrid, col: number, row: number): number | undefined {
  for (let radius = 0; radius <= 3; radius += 1) {
    for (let dr = -radius; dr <= radius; dr += 1) {
      for (let dc = -radius; dc <= radius; dc += 1) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue;
        if (Number.isFinite(grid.top[r * grid.cols + c]!)) return r * grid.cols + c;
      }
    }
  }
  return undefined;
}

/**
 * Adds the empty cells the surface encloses: any cell within its bounding box
 * that cannot reach the box's edge without crossing the surface. Returns how
 * many were added.
 */
function fillHoles(grid: SurfaceGrid, inRegion: Uint8Array): number {
  const { cols, rows } = grid;
  let minC = cols;
  let maxC = -1;
  let minR = rows;
  let maxR = -1;
  for (let cell = 0; cell < inRegion.length; cell += 1) {
    if (inRegion[cell] === 0) continue;
    const c = cell % cols;
    const r = (cell - c) / cols;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  if (maxC < 0) return 0;
  const width = maxC - minC + 1;
  const height = maxR - minR + 1;
  const outside = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (c: number, r: number) => {
    const local = (r - minR) * width + (c - minC);
    if (outside[local] !== 0 || inRegion[r * cols + c] !== 0) return;
    outside[local] = 1;
    stack.push(local);
  };
  for (let c = minC; c <= maxC; c += 1) {
    push(c, minR);
    push(c, maxR);
  }
  for (let r = minR; r <= maxR; r += 1) {
    push(minC, r);
    push(maxC, r);
  }
  while (stack.length > 0) {
    const local = stack.pop()!;
    const c = (local % width) + minC;
    const r = Math.floor(local / width) + minR;
    if (c > minC) push(c - 1, r);
    if (c < maxC) push(c + 1, r);
    if (r > minR) push(c, r - 1);
    if (r < maxR) push(c, r + 1);
  }
  // Each enclosed patch is judged on its own. One with no points in it is a
  // gap in the scan and belongs to the surface; so is a small thing standing
  // on it, a chimney or a skylight frame, which is part of a roof's footprint.
  // A large one - a building standing in the ground around it - is not.
  const largestKept = Math.max(16, Math.round(regionCells(inRegion) * 0.02));
  let added = 0;
  const seen = new Uint8Array(outside.length);
  const patch: number[] = [];
  for (let start = 0; start < outside.length; start += 1) {
    if (outside[start] !== 0 || seen[start] !== 0) continue;
    const startCell = (Math.floor(start / width) + minR) * cols + (start % width) + minC;
    if (inRegion[startCell] !== 0) continue;
    patch.length = 0;
    let hasPoints = false;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const local = stack.pop()!;
      const c = (local % width) + minC;
      const r = Math.floor(local / width) + minR;
      const cell = r * cols + c;
      patch.push(cell);
      if (Number.isFinite(grid.top[cell]!)) hasPoints = true;
      for (const [dc, dr] of neighbours) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < minC || nc > maxC || nr < minR || nr > maxR) continue;
        const next = (nr - minR) * width + (nc - minC);
        if (seen[next] !== 0 || outside[next] !== 0 || inRegion[nr * cols + nc] !== 0) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    if (hasPoints && patch.length > largestKept) continue;
    for (const cell of patch) inRegion[cell] = 1;
    added += patch.length;
  }
  return added;
}

function regionCells(inRegion: Uint8Array): number {
  let count = 0;
  for (const value of inRegion) count += value;
  return count;
}

/** The surface's boundary: every cell edge between a cell in it and one outside, laid on its plane. */
function outlineOf(grid: SurfaceGrid, inRegion: Uint8Array, surfaceY: (x: number, z: number) => number): Float32Array {
  const { cols, rows, cellSize, originX, originZ } = grid;
  const segments: number[] = [];
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && inRegion[r * cols + c] !== 0;
  const edge = (x1: number, z1: number, x2: number, z2: number) => {
    // Lifted a touch above the surface so the line is not lost among its points.
    segments.push(x1, surfaceY(x1, z1) + 0.05, z1, x2, surfaceY(x2, z2) + 0.05, z2);
  };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (!inside(c, r)) continue;
      const x = originX + c * cellSize;
      const z = originZ + r * cellSize;
      if (!inside(c - 1, r)) edge(x, z, x, z + cellSize);
      if (!inside(c + 1, r)) edge(x + cellSize, z, x + cellSize, z + cellSize);
      if (!inside(c, r - 1)) edge(x, z, x + cellSize, z);
      if (!inside(c, r + 1)) edge(x, z + cellSize, x + cellSize, z + cellSize);
    }
  }
  return Float32Array.from(segments);
}
