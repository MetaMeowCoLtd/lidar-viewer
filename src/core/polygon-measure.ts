import { fillEmptyCells } from "./elevation-grid.js";
import type { SurfaceGrid } from "./surface-area.js";

/**
 * Areas and volumes inside a polygon drawn on the scan.
 *
 * The polygon's corners are scan points, clicked in turn. What it encloses is
 * measured the way survey software measures a stockpile or an excavation
 * (Pix4D, Cyclone 3DR, CloudCompare's 2.5D volume): against a base surface
 * the corners define, over the scan's top surface as a height grid.
 *
 * - The base is either the surface through the corners themselves,
 *   triangulated, which follows sloping ground around a pile; a plane fitted
 *   to them; a level plane at their lowest, mean or highest corner; or a
 *   level the user sets - a design level, for cut and fill.
 * - Material above the base is cut, space below it is fill. A pile on the
 *   ground is cut; a pit is fill.
 * - Extruded, the polygon becomes a prism standing on its base. Its own volume
 *   is its area times its height, and the scan fills some share of it.
 *
 * The grid should hold the mean height of the points in each cell (a "mean"
 * surface grid), which is unbiased on slopes and splits a cell on a wall or a
 * pit's lip in proportion to what it covers.
 *
 * Everything works in the viewer's local frame, y up; the plan is x and z.
 */
export type Vec3 = readonly [number, number, number];

export type VolumeBase = "triangulated" | "fit" | "lowest" | "mean" | "highest" | "custom";

export interface PolygonShape {
  /** Corners in drawing order, local coordinates. */
  readonly vertices: readonly Vec3[];
  readonly base: VolumeBase;
  /** Local height of a custom base. */
  readonly customBase?: number | undefined;
  /** How far the polygon is extruded above its base; zero for none. */
  readonly height: number;
}

export interface PolygonMeasurement {
  /** False when there are fewer than three corners, no area, or edges that cross; nothing else is then meaningful. */
  readonly valid: boolean;
  /** Area on a plan, in square units. */
  readonly planArea: number;
  /** Length of the outline on a plan. */
  readonly perimeter: number;
  /** Length of the outline along its edges, rising and falling with the corners. */
  readonly edgeLength: number;
  /** Area of the scan's surface inside the polygon, following its slopes. */
  readonly surfaceArea: number;
  /** Volume of scan above the base: material to cut, or a pile's volume. */
  readonly cut: number;
  /** Volume between the base and a scan lying below it: space to fill. */
  readonly fill: number;
  /** Volume of the extruded prism, area times height. */
  readonly prism: number;
  /** How much of the prism the scan fills. */
  readonly filled: number;
  /** Share of the plan area no scan point fell in; filled in from around it. */
  readonly unmeasured: number;
  /** Size of the grid cells the volume was summed over. */
  readonly cellSize: number;
  /** Mean height of the base over the polygon. */
  readonly baseMean: number;
}

/** y = a x + b z + c */
interface Plane {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

const level = (height: number): Plane => ({ a: 0, b: 0, c: height });

/** Area on a plan, whichever way round the corners run. */
export function planArea(vertices: readonly Vec3[]): number {
  return Math.abs(signedArea(vertices));
}

/** Twice the signed plan area; positive when the corners run anticlockwise seen from above (x east, z south). */
function signedArea(vertices: readonly Vec3[]): number {
  let sum = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const p = vertices[i]!;
    const q = vertices[(i + 1) % vertices.length]!;
    sum += p[0] * q[2] - q[0] * p[2];
  }
  return sum / 2;
}

/** Whether any two edges that do not share a corner cross on a plan. */
export function edgesCross(vertices: readonly Vec3[]): boolean {
  const n = vertices.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    for (let j = i + 2; j < n; j += 1) {
      // The last edge shares a corner with the first.
      if (i === 0 && j === n - 1) continue;
      const c = vertices[j]!;
      const d = vertices[(j + 1) % n]!;
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function segmentsCross(a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean {
  const orient = (p: Vec3, q: Vec3, r: Vec3) => (q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0]);
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Splits a simple polygon into triangles on a plan, by clipping ears: each
 * step cuts off a convex corner whose triangle holds no other corner. Works
 * for concave outlines - an L-shaped yard, a pile against a wall. Returns
 * corner indices, three per triangle; empty when the outline cannot be split.
 */
export function triangulate(vertices: readonly Vec3[]): number[] {
  const n = vertices.length;
  if (n < 3) return [];
  const turn = signedArea(vertices) >= 0 ? 1 : -1;
  const remaining = Array.from({ length: n }, (_, index) => index);
  const triangles: number[] = [];
  const cross = (i: number, j: number, k: number) => {
    const p = vertices[i]!;
    const q = vertices[j]!;
    const r = vertices[k]!;
    return ((q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0])) * turn;
  };
  const scale = Math.max(1e-12, Math.abs(signedArea(vertices)));
  let guard = n * n + 8;
  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let at = 0; at < remaining.length; at += 1) {
      const i = remaining[(at + remaining.length - 1) % remaining.length]!;
      const j = remaining[at]!;
      const k = remaining[(at + 1) % remaining.length]!;
      const corner = cross(i, j, k);
      // A corner in a straight line with its neighbours encloses nothing: drop it without a triangle.
      if (Math.abs(corner) <= scale * 1e-9) {
        remaining.splice(at, 1);
        clipped = true;
        break;
      }
      if (corner < 0) continue;
      let blocked = false;
      for (const other of remaining) {
        if (other === i || other === j || other === k) continue;
        if (cross(i, j, other) >= 0 && cross(j, k, other) >= 0 && cross(k, i, other) >= 0) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      triangles.push(i, j, k);
      remaining.splice(at, 1);
      clipped = true;
      break;
    }
    if (!clipped) return [];
  }
  if (remaining.length === 3 && Math.abs(cross(remaining[0]!, remaining[1]!, remaining[2]!)) > scale * 1e-9) triangles.push(...remaining);
  return triangles;
}

/** The plane through three corners; undefined when they stand in a vertical line on the plan. */
function planeThrough(p: Vec3, q: Vec3, r: Vec3): Plane | undefined {
  const ux = q[0] - p[0];
  const uy = q[1] - p[1];
  const uz = q[2] - p[2];
  const vx = r[0] - p[0];
  const vy = r[1] - p[1];
  const vz = r[2] - p[2];
  // Normal = u × v; y = p.y - (nx (x - p.x) + nz (z - p.z)) / ny.
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  if (Math.abs(ny) < 1e-12) return undefined;
  const a = -nx / ny;
  const b = -nz / ny;
  return { a, b, c: p[1] - a * p[0] - b * p[2] };
}

/** The plane that best fits the corners, by least squares; level at their mean when they fit no plane. */
function fittedPlane(vertices: readonly Vec3[]): Plane {
  const n = vertices.length;
  // Relative to the first corner, so the sums stay well conditioned.
  const [x0, , z0] = vertices[0]!;
  let sx = 0;
  let sz = 0;
  let sy = 0;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  let sxy = 0;
  let szy = 0;
  for (const [vx, vy, vz] of vertices) {
    const x = vx - x0;
    const z = vz - z0;
    sx += x;
    sz += z;
    sy += vy;
    sxx += x * x;
    sxz += x * z;
    szz += z * z;
    sxy += x * vy;
    szy += z * vy;
  }
  const m = [
    [sxx, sxz, sx],
    [sxz, szz, sz],
    [sx, sz, n],
  ];
  const r = [sxy, szy, sy];
  const det3 = (q: number[][]) =>
    q[0]![0]! * (q[1]![1]! * q[2]![2]! - q[1]![2]! * q[2]![1]!) - q[0]![1]! * (q[1]![0]! * q[2]![2]! - q[1]![2]! * q[2]![0]!) + q[0]![2]! * (q[1]![0]! * q[2]![1]! - q[1]![1]! * q[2]![0]!);
  const d = det3(m);
  if (n < 3 || Math.abs(d) < 1e-9 * Math.max(1, sxx * szz)) return level(sy / n);
  const solve = (column: number) => det3(m.map((row, index) => row.map((value, c) => (c === column ? r[index]! : value)))) / d;
  const a = solve(0);
  const b = solve(1);
  return { a, b, c: solve(2) - a * x0 - b * z0 };
}

/**
 * The base under each triangle. Every base but the triangulated one is a
 * single plane; the triangulated base is the plane of each triangle's own
 * three corners.
 */
function basePlanes(shape: PolygonShape, triangles: readonly number[]): Plane[] {
  const { vertices } = shape;
  const count = triangles.length / 3;
  const heights = vertices.map((vertex) => vertex[1]);
  const mean = heights.reduce((sum, height) => sum + height, 0) / Math.max(1, heights.length);
  let shared: Plane | undefined;
  switch (shape.base) {
    case "lowest":
      shared = level(Math.min(...heights));
      break;
    case "highest":
      shared = level(Math.max(...heights));
      break;
    case "mean":
      shared = level(mean);
      break;
    case "custom":
      shared = level(shape.customBase ?? mean);
      break;
    case "fit":
      shared = fittedPlane(vertices);
      break;
    default:
      shared = undefined;
  }
  const planes: Plane[] = [];
  for (let t = 0; t < count; t += 1) {
    planes.push(shared ?? planeThrough(vertices[triangles[t * 3]!]!, vertices[triangles[t * 3 + 1]!]!, vertices[triangles[t * 3 + 2]!]!) ?? level(mean));
  }
  return planes;
}

/** Height of the base under each corner: its own height on a triangulated base, the plane's elsewhere. */
export function baseHeights(shape: PolygonShape): number[] {
  if (shape.base === "triangulated" || shape.vertices.length < 3) return shape.vertices.map((vertex) => vertex[1]);
  const [plane] = basePlanes(shape, [0, 1, 2]);
  return shape.vertices.map(([x, , z]) => plane!.a * x + plane!.b * z + plane!.c);
}

/**
 * A spot inside the polygon for its label and handles, on its base: the
 * centroid, or for an outline whose centroid falls outside it - an L or a U -
 * the middle of its largest triangle.
 */
export function polygonAnchor(shape: PolygonShape): Vec3 | undefined {
  const { vertices } = shape;
  const triangles = triangulate(vertices);
  if (triangles.length === 0) return undefined;
  const planes = basePlanes(shape, triangles);
  let cx = 0;
  let cz = 0;
  let total = 0;
  let largest = 0;
  let largestArea = -1;
  for (let t = 0; t < triangles.length / 3; t += 1) {
    const [p, q, r] = [vertices[triangles[t * 3]!]!, vertices[triangles[t * 3 + 1]!]!, vertices[triangles[t * 3 + 2]!]!];
    const area = Math.abs((q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0])) / 2;
    cx += ((p[0] + q[0] + r[0]) / 3) * area;
    cz += ((p[2] + q[2] + r[2]) / 3) * area;
    total += area;
    if (area > largestArea) {
      largestArea = area;
      largest = t;
    }
  }
  if (total <= 0) return undefined;
  cx /= total;
  cz /= total;
  let inside = -1;
  for (let t = 0; t < triangles.length / 3 && inside < 0; t += 1) {
    if (inTriangle(cx, cz, vertices[triangles[t * 3]!]!, vertices[triangles[t * 3 + 1]!]!, vertices[triangles[t * 3 + 2]!]!)) inside = t;
  }
  if (inside < 0) {
    const [p, q, r] = [vertices[triangles[largest * 3]!]!, vertices[triangles[largest * 3 + 1]!]!, vertices[triangles[largest * 3 + 2]!]!];
    cx = (p[0] + q[0] + r[0]) / 3;
    cz = (p[2] + q[2] + r[2]) / 3;
    inside = largest;
  }
  const plane = planes[inside]!;
  return [cx, plane.a * cx + plane.b * cz + plane.c, cz];
}

function inTriangle(x: number, z: number, p: Vec3, q: Vec3, r: Vec3): boolean {
  const side = (a: Vec3, b: Vec3) => (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);
  const s1 = side(p, q);
  const s2 = side(q, r);
  const s3 = side(r, p);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

/** Sub-rows per grid row when finding how much of a cell a triangle covers; across a row the cover is exact. */
const subRows = 4;

/**
 * Measures a closed polygon against the scan's top surface.
 *
 * The polygon is split into triangles, and each triangle into the parts of
 * grid cells it covers: every row of cells is crossed by a few horizontal
 * lines, and along each the triangle's span is cut exactly at cell edges, so
 * a cell on the outline counts for the share of it that lies inside. Each
 * part adds its area times the height between the base and the scan.
 *
 * Cells no point fell in - a shadow, a puddle that swallowed the laser - are
 * filled from the cells around them, as survey software interpolates its
 * surface model, and the share of the area that needed it is reported.
 */
export function measurePolygon(grid: SurfaceGrid, shape: PolygonShape): PolygonMeasurement {
  const { vertices } = shape;
  const height = Math.max(0, shape.height);
  const perimeter = outlineLength(vertices, false);
  const edgeLength = outlineLength(vertices, true);
  const area = planArea(vertices);
  const triangles = vertices.length >= 3 && !edgesCross(vertices) ? triangulate(vertices) : [];
  const invalid: PolygonMeasurement = {
    valid: false,
    planArea: area,
    perimeter,
    edgeLength,
    surfaceArea: 0,
    cut: 0,
    fill: 0,
    prism: 0,
    filled: 0,
    unmeasured: 0,
    cellSize: grid.cellSize,
    baseMean: 0,
  };
  if (triangles.length === 0 || area <= 0) return invalid;
  const planes = basePlanes(shape, triangles);

  // The part of the grid under the polygon, a cell wider all round, copied so
  // its gaps can be filled without touching the shared grid. It may reach past
  // the grid's own edge; cells out there are gaps like any other.
  const { cellSize, originX, originZ } = grid;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, , z] of vertices) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const col0 = Math.floor((minX - originX) / cellSize) - 1;
  const row0 = Math.floor((minZ - originZ) / cellSize) - 1;
  const cols = Math.floor((maxX - originX) / cellSize) + 2 - col0;
  const rows = Math.floor((maxZ - originZ) / cellSize) + 2 - row0;
  const top = new Float32Array(cols * rows);
  const gap = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    const gridRow = row0 + r;
    for (let c = 0; c < cols; c += 1) {
      const gridCol = col0 + c;
      const inside = gridRow >= 0 && gridRow < grid.rows && gridCol >= 0 && gridCol < grid.cols;
      const value = inside ? grid.top[gridRow * grid.cols + gridCol]! : Number.NaN;
      top[r * cols + c] = value;
      if (!Number.isFinite(value)) gap[r * cols + c] = 1;
    }
  }
  if (!fillEmptyCells(top, cols, rows)) return { ...invalid, valid: true, unmeasured: 1 };
  const cropX = originX + col0 * cellSize;
  const cropZ = originZ + row0 * cellSize;

  // Each cell's slope, from its neighbours, for the area along the surface.
  const slopeFactor = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const left = top[r * cols + Math.max(0, c - 1)]!;
      const right = top[r * cols + Math.min(cols - 1, c + 1)]!;
      const up = top[Math.max(0, r - 1) * cols + c]!;
      const down = top[Math.min(rows - 1, r + 1) * cols + c]!;
      const gx = (right - left) / ((Math.min(cols - 1, c + 1) - Math.max(0, c - 1)) * cellSize);
      const gz = (down - up) / ((Math.min(rows - 1, r + 1) - Math.max(0, r - 1)) * cellSize);
      slopeFactor[r * cols + c] = Math.sqrt(1 + gx * gx + gz * gz);
    }
  }

  let cut = 0;
  let fill = 0;
  let filled = 0;
  let surfaceArea = 0;
  let unmeasured = 0;
  let covered = 0;
  let baseSum = 0;
  const cellArea = cellSize * cellSize;
  for (let t = 0; t < triangles.length / 3; t += 1) {
    const plane = planes[t]!;
    const p = vertices[triangles[t * 3]!]!;
    const q = vertices[triangles[t * 3 + 1]!]!;
    const s = vertices[triangles[t * 3 + 2]!]!;
    const tMinZ = Math.min(p[2], q[2], s[2]);
    const tMaxZ = Math.max(p[2], q[2], s[2]);
    const firstRow = Math.max(0, Math.floor((tMinZ - cropZ) / cellSize));
    const lastRow = Math.min(rows - 1, Math.floor((tMaxZ - cropZ) / cellSize));
    for (let r = firstRow; r <= lastRow; r += 1) {
      for (let sub = 0; sub < subRows; sub += 1) {
        const z = cropZ + (r + (sub + 0.5) / subRows) * cellSize;
        const span = spanAt(p, q, s, z);
        if (span === undefined) continue;
        const [left, right] = span;
        const firstCol = Math.max(0, Math.floor((left - cropX) / cellSize));
        const lastCol = Math.min(cols - 1, Math.floor((right - cropX) / cellSize));
        for (let c = firstCol; c <= lastCol; c += 1) {
          const x0 = cropX + c * cellSize;
          const from = Math.max(left, x0);
          const to = Math.min(right, x0 + cellSize);
          if (to <= from) continue;
          const part = ((to - from) / cellSize / subRows) * cellArea;
          const cell = r * cols + c;
          const x = (from + to) / 2;
          const base = plane.a * x + plane.b * z + plane.c;
          const rise = top[cell]! - base;
          if (rise > 0) cut += part * rise;
          else fill -= part * rise;
          if (height > 0) filled += part * Math.min(height, Math.max(0, rise));
          surfaceArea += part * slopeFactor[cell]!;
          if (gap[cell] === 1) unmeasured += part;
          covered += part;
          baseSum += part * base;
        }
      }
    }
  }

  return {
    valid: true,
    planArea: area,
    perimeter,
    edgeLength,
    // Never below the plan area: rounding over a flat surface must not shrink it.
    surfaceArea: Math.max(area, surfaceArea * (covered > 0 ? area / covered : 1)),
    cut,
    fill,
    prism: area * height,
    filled,
    unmeasured: covered > 0 ? Math.min(1, unmeasured / covered) : 0,
    cellSize,
    baseMean: covered > 0 ? baseSum / covered : 0,
  };
}

/** Where a horizontal line at `z` crosses a triangle on the plan, as the x of its two ends. */
function spanAt(p: Vec3, q: Vec3, r: Vec3, z: number): [number, number] | undefined {
  let left = Infinity;
  let right = -Infinity;
  for (const [a, b] of [
    [p, q],
    [q, r],
    [r, p],
  ] as const) {
    if ((a[2] <= z && b[2] > z) || (b[2] <= z && a[2] > z)) {
      const x = a[0] + ((z - a[2]) / (b[2] - a[2])) * (b[0] - a[0]);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  return right > left ? [left, right] : undefined;
}

function outlineLength(vertices: readonly Vec3[], alongEdges: boolean): number {
  if (vertices.length < 2) return 0;
  let length = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const p = vertices[i]!;
    const q = vertices[(i + 1) % vertices.length]!;
    length += alongEdges ? Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) : Math.hypot(q[0] - p[0], q[2] - p[2]);
  }
  return length;
}

/** What to draw for a polygon: its outline on the scan, its base, and the prism when it is extruded. */
export interface PolygonDrawing {
  /** Line segments through the corners, x y z of both ends. */
  readonly outline: Float32Array;
  /** Triangles on the base. */
  readonly base: Float32Array;
  /** Line segments from each corner down or up to the base, where the two part. */
  readonly drops: Float32Array;
  /** The prism's top outline and its upright edges; empty when it is not extruded. */
  readonly prismEdges: Float32Array;
  /** The prism's walls and top, as triangles. */
  readonly prismFaces: Float32Array;
}

export function polygonDrawing(shape: PolygonShape, closed: boolean): PolygonDrawing {
  const { vertices } = shape;
  const n = vertices.length;
  const outline: number[] = [];
  const edges = closed && n > 2 ? n : n - 1;
  for (let i = 0; i < edges; i += 1) outline.push(...vertices[i]!, ...vertices[(i + 1) % n]!);
  const empty = new Float32Array(0);
  const triangles = closed && n >= 3 && !edgesCross(vertices) ? triangulate(vertices) : [];
  if (triangles.length === 0) return { outline: Float32Array.from(outline), base: empty, drops: empty, prismEdges: empty, prismFaces: empty };

  const bases = baseHeights(shape);
  const onBase = (i: number): Vec3 => [vertices[i]![0], bases[i]!, vertices[i]![2]];
  const base: number[] = [];
  for (const index of triangles) base.push(...onBase(index));
  const drops: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(vertices[i]![1] - bases[i]!) > 0.01) drops.push(...vertices[i]!, ...onBase(i));
  }

  const height = Math.max(0, shape.height);
  const prismEdges: number[] = [];
  const prismFaces: number[] = [];
  if (height > 0) {
    const onTop = (i: number): Vec3 => [vertices[i]![0], bases[i]! + height, vertices[i]![2]];
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      prismEdges.push(...onTop(i), ...onTop(j), ...onBase(i), ...onTop(i), ...onBase(i), ...onBase(j));
      prismFaces.push(...onBase(i), ...onBase(j), ...onTop(j), ...onBase(i), ...onTop(j), ...onTop(i));
    }
    for (const index of triangles) prismFaces.push(...onTop(index));
  }
  return {
    outline: Float32Array.from(outline),
    base: Float32Array.from(base),
    drops: Float32Array.from(drops),
    prismEdges: Float32Array.from(prismEdges),
    prismFaces: Float32Array.from(prismFaces),
  };
}
