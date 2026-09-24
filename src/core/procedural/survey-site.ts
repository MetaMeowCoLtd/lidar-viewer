import { clamp, fbm, hash, jitter, mix, rgb, smoothstep, valueNoise, type Random, type Rgb } from "./sampling.js";

/**
 * The ground truth of the sample survey: an aggregate quarry cut into a
 * hillside, its processing pad with stockpiles, crusher and conveyors, a
 * high-voltage line crossing a forest on a cleared right-of-way, a conifer
 * plantation, a creek with a farm and its fields in the valley, and a rural
 * road with wooden distribution poles. It is the kind of site drone LiDAR is
 * flown over for real - stockpile volumes, quarry progress, vegetation
 * clearance under power lines, forest inventory and terrain under canopy -
 * rather than a showcase of landmarks.
 *
 * Coordinates are metres in the viewer's frame: x east, y up, z south.
 */

export const halfWidth = 230;
export const halfDepth = 180;

// -------------------------------------------------------------- terrain

export function creekZ(x: number): number {
  return 112 + 20 * Math.sin(x / 80 + 0.6) + 6 * Math.sin(x / 31);
}

const creekWaterHalfWidth = 2.4;

export function naturalHeight(x: number, z: number): number {
  const trend = 38 - 0.07 * z + 0.02 * x;
  const hills = 11 * fbm(x / 170 + 11.3, z / 170 - 4.1, 4, 1);
  const detail = 0.9 * fbm(x / 26, z / 26, 3, 2);
  const across = z - creekZ(x);
  const valley = -6 * Math.exp(-(across * across) / 1600);
  const channel = Math.abs(across) < 5 ? -1.5 * (1 - (across / 5) ** 2) : 0;
  return trend + hills + detail + valley + channel;
}

// ------------------------------------------------------------------ quarry

const quarry = { x: 125, z: -95, ax: 88, az: 62 };
const benchHeight = 8;
const benchPeriod = 10;
const faceWidth = 3;
const benchCount = 5;
const rimLevel = naturalHeight(quarry.x, quarry.z + quarry.az);
const floorLevel = rimLevel - benchHeight * benchCount;

interface QuarryPoint {
  /** Inward distance from the pit's outline, in metres; negative outside it. */
  d: number;
  theta: number;
  /** Distance from the centre, as a fraction of the outline's radius there. */
  rho: number;
}

const quarryPoint: QuarryPoint = { d: 0, theta: 0, rho: 0 };

function quarryAt(x: number, z: number): QuarryPoint {
  const u = (x - quarry.x) / quarry.ax;
  const v = (z - quarry.z) / quarry.az;
  const theta = Math.atan2(v, u);
  const outline = 1 + 0.13 * valueNoise(Math.cos(theta) * 1.6 + 7, Math.sin(theta) * 1.6 + 7, 5);
  const rho = Math.hypot(u, v);
  quarryPoint.d = (outline - rho) * 72;
  quarryPoint.theta = theta;
  quarryPoint.rho = rho / outline;
  return quarryPoint;
}

/** Benches stepping down into the pit: a steep face, then a level berm, five times over. */
function benchSurface(d: number): number {
  if (d >= benchCount * benchPeriod) return floorLevel;
  const k = Math.floor(d / benchPeriod);
  const s = d - k * benchPeriod;
  return s < faceWidth ? rimLevel - benchHeight * k - benchHeight * (s / faceWidth) : rimLevel - benchHeight * (k + 1);
}

// The haul ramp spirals down the pit wall from its south-west side, towards the pad.
const pad = { x: 62, z: 12, halfX: 50, halfZ: 34 };
const rampStart = Math.atan2((pad.z - quarry.z) / quarry.az, (pad.x - quarry.x) / quarry.ax);
const rampSweep = 3.4;

function rampLevel(theta: number, d: number): number | undefined {
  let delta = rampStart - theta;
  delta = ((delta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (delta > rampSweep) return undefined;
  const s = delta / rampSweep;
  if (Math.abs(d - (-6 + 58 * s)) > 5.5) return undefined;
  return rimLevel - benchHeight * benchCount * s;
}

export const rampTop = ((): readonly [number, number] => {
  const rho = 1 + 0.13 * valueNoise(Math.cos(rampStart) * 1.6 + 7, Math.sin(rampStart) * 1.6 + 7, 5) + 6 / 72;
  return [quarry.x + Math.cos(rampStart) * rho * quarry.ax, quarry.z + Math.sin(rampStart) * rho * quarry.az];
})();

function inPond(x: number, z: number, d: number): boolean {
  return d > benchCount * benchPeriod + 6 + 5 * valueNoise(x / 9, z / 9, 21);
}

// ----------------------------------------------------------- pads and paths

const padLevel = Math.round(naturalHeight(pad.x, pad.z) * 2) / 2;
const yard = { x: -148, z: 20, halfX: 36, halfZ: 24 };
const yardLevel = Math.round(naturalHeight(yard.x, yard.z) * 2) / 2;

function boxFalloff(box: { x: number; z: number; halfX: number; halfZ: number }, x: number, z: number, edge: number): number {
  const dx = Math.max(0, Math.abs(x - box.x) - box.halfX);
  const dz = Math.max(0, Math.abs(z - box.z) - box.halfZ);
  return 1 - smoothstep(0, edge, Math.hypot(dx, dz));
}

export type PathKind = "paved" | "gravel" | "lane";

export interface Path {
  readonly kind: PathKind;
  readonly halfWidth: number;
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  /** Distance along the path to each vertex. */
  readonly along: Float64Array;
}

/** Rounds a polyline's corners with a Catmull-Rom spline, so roads curve instead of kinking. */
function smoothPath(control: ReadonlyArray<readonly [number, number]>, step = 4): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let index = 0; index < control.length - 1; index += 1) {
    const p0 = control[Math.max(0, index - 1)]!;
    const p1 = control[index]!;
    const p2 = control[index + 1]!;
    const p3 = control[Math.min(control.length - 1, index + 2)]!;
    const pieces = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let piece = 0; piece < pieces; piece += 1) {
      const t = piece / pieces;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      points.push([at(p0[0], p1[0], p2[0], p3[0]), at(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  points.push([control[control.length - 1]![0], control[control.length - 1]![1]]);
  return points;
}

function makePath(kind: PathKind, halfWidth: number, control: ReadonlyArray<readonly [number, number]>): Path {
  const points = smoothPath(control);
  const xs = new Float64Array(points.length);
  const zs = new Float64Array(points.length);
  const along = new Float64Array(points.length);
  points.forEach(([x, z], index) => {
    xs[index] = x;
    zs[index] = z;
    if (index > 0) along[index] = along[index - 1]! + Math.hypot(x - xs[index - 1]!, z - zs[index - 1]!);
  });
  return { kind, halfWidth, xs, zs, along };
}

export const roadControl: ReadonlyArray<readonly [number, number]> = [
  [-240, 66], [-170, 72], [-110, 60], [-50, 70], [10, 80], [70, 76], [130, 64], [190, 70], [240, 58],
];

export const paths: ReadonlyArray<Path> = [
  makePath("paved", 3.4, roadControl),
  // The site entrance, and the haul road from the pad to the top of the ramp.
  makePath("gravel", 5, [[40, 77], [44, 60], [46, 44]]),
  makePath("gravel", 6, [[98, -20], [104, -30], rampTop]),
  // The farm lane.
  makePath("lane", 2.2, [[-150, 67], [-151, 55], [-148, 44]]),
];

export interface PathHit {
  path: Path;
  distance: number;
  across: number;
  along: number;
}

/** A coarse grid of path segments, so asking which road a point is on does not test all of them. */
const pathCell = 12;
const pathCols = Math.ceil((halfWidth * 2 + 40) / pathCell);
const pathRows = Math.ceil((halfDepth * 2 + 40) / pathCell);
const pathBuckets: Array<Array<readonly [Path, number]>> = Array.from({ length: pathCols * pathRows }, () => []);
for (const path of paths) {
  for (let index = 0; index < path.xs.length - 1; index += 1) {
    const reach = path.halfWidth + 8;
    const minX = Math.min(path.xs[index]!, path.xs[index + 1]!) - reach;
    const maxX = Math.max(path.xs[index]!, path.xs[index + 1]!) + reach;
    const minZ = Math.min(path.zs[index]!, path.zs[index + 1]!) - reach;
    const maxZ = Math.max(path.zs[index]!, path.zs[index + 1]!) + reach;
    for (let col = pathColumn(minX); col <= pathColumn(maxX); col += 1) {
      for (let row = pathRow(minZ); row <= pathRow(maxZ); row += 1) pathBuckets[row * pathCols + col]!.push([path, index]);
    }
  }
}

function pathColumn(x: number): number {
  return clamp(Math.floor((x + halfWidth + 20) / pathCell), 0, pathCols - 1);
}

function pathRow(z: number): number {
  return clamp(Math.floor((z + halfDepth + 20) / pathCell), 0, pathRows - 1);
}

const pathHit: PathHit = { path: paths[0]!, distance: 0, across: 0, along: 0 };

/** The path whose edge is nearest a point, within eight metres of it. */
export function nearestPath(x: number, z: number): PathHit | undefined {
  let best = Number.POSITIVE_INFINITY;
  for (const [path, index] of pathBuckets[pathRow(z) * pathCols + pathColumn(x)]!) {
    const ax = path.xs[index]!;
    const az = path.zs[index]!;
    const dx = path.xs[index + 1]! - ax;
    const dz = path.zs[index + 1]! - az;
    const lengthSq = dx * dx + dz * dz;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / lengthSq, 0, 1);
    const px = x - (ax + t * dx);
    const pz = z - (az + t * dz);
    const distance = Math.hypot(px, pz);
    if (distance - path.halfWidth >= best) continue;
    best = distance - path.halfWidth;
    const length = Math.sqrt(lengthSq);
    pathHit.path = path;
    pathHit.distance = distance;
    pathHit.across = (dx * pz - dz * px) / length;
    pathHit.along = path.along[index]! + t * length;
  }
  return best < 8 ? pathHit : undefined;
}

// ------------------------------------------------------------------ fields

interface Field {
  readonly x: number;
  readonly z: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly angle: number;
  readonly cover: Cover;
}

/** What the ground is covered with, as a small code so a whole raster of it stays compact. */
export const Cover = {
  Meadow: 0,
  Water: 1,
  Paved: 2,
  Gravel: 3,
  Lane: 4,
  Quarry: 5,
  Pad: 6,
  Yard: 7,
  Ploughed: 8,
  Wheat: 9,
  Pasture: 10,
  Hay: 11,
  ForestFloor: 12,
  RightOfWay: 13,
  Bank: 14,
} as const;
export type Cover = (typeof Cover)[keyof typeof Cover];

export const fields: ReadonlyArray<Field> = [
  { x: -192, z: 128, halfX: 36, halfZ: 44, angle: 0.08, cover: Cover.Ploughed },
  { x: -112, z: 132, halfX: 38, halfZ: 40, angle: 0.05, cover: Cover.Wheat },
  { x: -38, z: 142, halfX: 32, halfZ: 34, angle: -0.04, cover: Cover.Pasture },
  { x: -204, z: -8, halfX: 20, halfZ: 34, angle: 0.02, cover: Cover.Hay },
];

function fieldAt(x: number, z: number): Field | undefined {
  for (const field of fields) {
    const cos = Math.cos(field.angle);
    const sin = Math.sin(field.angle);
    const u = (x - field.x) * cos + (z - field.z) * sin;
    const v = -(x - field.x) * sin + (z - field.z) * cos;
    if (Math.abs(u) < field.halfX && Math.abs(v) < field.halfZ) return field;
  }
  return undefined;
}

// ------------------------------------------------------------- the power line

export const lineStart: readonly [number, number] = [-240, -90];
export const lineEnd: readonly [number, number] = [240, 165];
export const towerFractions: ReadonlyArray<number> = [0.1, 0.3, 0.5, 0.7, 0.9];

/** Horizontal distance from the centre line of the transmission line's right-of-way. */
export function distanceFromLine(x: number, z: number): number {
  const dx = lineEnd[0] - lineStart[0];
  const dz = lineEnd[1] - lineStart[1];
  return Math.abs(dx * (z - lineStart[1]) - dz * (x - lineStart[0])) / Math.hypot(dx, dz);
}

export const rightOfWay = 24;

// ---------------------------------------------------------------- the forest

/** How strongly a spot wants to be forest: the western hills and the high ground to the north. */
export function forestScore(x: number, z: number): number {
  return 0.55 * fbm(x / 120 + 40, z / 120 + 9, 3, 7) + 0.9 * smoothstep(-10, -120, x) + 0.9 * smoothstep(-30, -130, z) + 0.6 * smoothstep(195, 225, x) + 0.35 * smoothstep(110, 40, z) * smoothstep(-40, 60, x) - 0.42;
}

export const plantation = { minX: -230, maxX: -122, minZ: -180, maxZ: -112 };

/** Whether trees may grow here at all: not in the pit, on pads, roads, fields or water. */
export function openForTrees(x: number, z: number, margin = 0): boolean {
  if (quarryAt(x, z).rho < 1.22 + margin / 70) return false;
  if (boxFalloff(pad, x, z, 16 + margin) > 0 || boxFalloff(yard, x, z, 6 + margin) > 0) return false;
  if (fieldAt(x, z) !== undefined) return false;
  if (Math.abs(z - creekZ(x)) < 4.5) return false;
  const path = nearestPath(x, z);
  return path === undefined || path.distance - path.path.halfWidth > 3 + margin;
}

// ------------------------------------------------------------------ ground

export interface GroundCell {
  height: number;
  cover: Cover;
}

const cell: GroundCell = { height: 0, cover: Cover.Meadow };

/** The finished ground at a point - natural terrain, cut, filled and graded - and what covers it. */
export function groundAt(x: number, z: number): GroundCell {
  const natural = naturalHeight(x, z);
  let height = natural;
  let cover: Cover = Cover.Meadow;

  const q = quarryAt(x, z);
  if (q.rho < 1.7) {
    let cut = benchSurface(q.d) + 0.25 * valueNoise(x / 6, z / 6, 3);
    const ramp = rampLevel(q.theta, q.d);
    if (ramp !== undefined) cut = ramp;
    if (cut < natural - 0.3) {
      height = cut;
      cover = inPond(x, z, q.d) ? Cover.Water : Cover.Quarry;
    }
  }

  const onPad = boxFalloff(pad, x, z, 14);
  if (onPad > 0) {
    height = height + (padLevel - height) * onPad;
    if (onPad > 0.6) cover = Cover.Pad;
  }
  const onYard = boxFalloff(yard, x, z, 10);
  if (onYard > 0) {
    height = height + (yardLevel - height) * onYard;
    if (onYard > 0.7) cover = Cover.Yard;
  }

  // Roads are graded level across, with a ditch either side of the paved one.
  const path = nearestPath(x, z);
  if (path !== undefined) {
    const edge = path.distance - path.path.halfWidth;
    const level = naturalHeight(x, z) + (onPad > 0 ? height - natural : 0);
    if (edge < 4) {
      const grade = 1 - smoothstep(0, 4, edge);
      height = height + (level - height) * grade * 0.6;
    }
    if (path.path.kind === "paved" && edge > 0.8 && edge < 3) height -= 0.55 * Math.sin(((edge - 0.8) / 2.2) * Math.PI);
    if (edge < 0) cover = path.path.kind === "paved" ? Cover.Paved : path.path.kind === "gravel" ? Cover.Gravel : Cover.Lane;
  }

  if (cover === Cover.Meadow) {
    const creek = Math.abs(z - creekZ(x));
    const field = fieldAt(x, z);
    if (creek < creekWaterHalfWidth) cover = Cover.Water;
    else if (creek < 5.5) cover = Cover.Bank;
    else if (field !== undefined && creek > 8) cover = field.cover;
    else if (distanceFromLine(x, z) < rightOfWay && forestScore(x, z) > 0) cover = Cover.RightOfWay;
    else if (forestScore(x, z) > 0 || (x < plantation.maxX && z < plantation.maxZ)) cover = Cover.ForestFloor;
  }

  cell.height = height;
  cell.cover = cover;
  return cell;
}

// ------------------------------------------------------------ what covers it

export interface Surface {
  colour: Rgb;
  /** Share of the laser's energy the surface sends back, 0 to 1. */
  reflectance: number;
  /** Height of low vegetation - grass, crops - standing on the ground here. */
  lowVegetation: number;
}

const surface: Surface = { colour: rgb(0, 0, 0), reflectance: 0, lowVegetation: 0 };

function paint(colour: Rgb, reflectance: number, lowVegetation = 0): Surface {
  surface.colour = colour;
  surface.reflectance = reflectance;
  surface.lowVegetation = lowVegetation;
  return surface;
}

const tones = {
  asphalt: rgb(74, 74, 76),
  roadPaint: rgb(206, 206, 198),
  gravel: rgb(152, 144, 126),
  rut: rgb(118, 108, 92),
  limestone: rgb(184, 178, 164),
  benchFloor: rgb(156, 148, 132),
  padGravel: rgb(146, 140, 128),
  wet: rgb(104, 100, 92),
  yard: rgb(138, 126, 104),
  soilLight: rgb(128, 104, 80),
  soilDark: rgb(98, 78, 60),
  wheat: rgb(178, 166, 112),
  wheatShade: rgb(150, 140, 94),
  pasture: rgb(104, 122, 70),
  hay: rgb(150, 146, 98),
  hayRow: rgb(122, 118, 76),
  litter: rgb(84, 80, 58),
  scrub: rgb(96, 108, 66),
  bank: rgb(118, 110, 86),
  grassGreen: rgb(100, 118, 70),
  grassDry: rgb(146, 142, 98),
} as const;

/** What a laser pulse, and a camera, would see on the ground at a point. */
export function surfaceAt(cover: Cover, x: number, z: number, slope: number): Surface {
  const grain = valueNoise(x * 0.9, z * 0.9, 11);
  switch (cover) {
    case Cover.Paved: {
      const path = nearestPath(x, z);
      if (path !== undefined) {
        const offset = Math.abs(path.across);
        const dashed = offset < 0.1 && path.along % 12 < 6;
        const edge = Math.abs(offset - (path.path.halfWidth - 0.25)) < 0.08;
        if (dashed || edge) return paint(tones.roadPaint, 0.62);
      }
      return paint(mix(tones.asphalt, tones.wet, 0.2 + 0.2 * grain), 0.13);
    }
    case Cover.Gravel:
    case Cover.Lane: {
      const path = nearestPath(x, z);
      const rut = path !== undefined && Math.abs(Math.abs(path.across) - 1.1) < 0.35;
      return paint(rut ? tones.rut : mix(tones.gravel, tones.yard, 0.5 + 0.4 * grain), 0.36);
    }
    case Cover.Quarry: {
      if (slope > 1.2) {
        // Bedding planes band the rock faces.
        const bed = valueNoise(0, (x + z) * 0.05 + slope * 0.1, 13) * 0.15 + Math.sin((x * 0.3 + z * 0.2)) * 0.05;
        return paint(mix(tones.limestone, tones.benchFloor, 0.3 + bed), 0.56);
      }
      return paint(mix(tones.benchFloor, tones.wet, 0.25 + 0.25 * valueNoise(x / 5, z / 5, 14)), 0.46);
    }
    case Cover.Pad:
      return paint(mix(tones.padGravel, tones.wet, 0.3 + 0.35 * valueNoise(x / 7, z / 7, 15)), 0.4);
    case Cover.Yard:
      return paint(mix(tones.yard, tones.wet, 0.3 + 0.3 * grain), 0.32);
    case Cover.Ploughed: {
      const furrow = Math.sin(z * 7.8) > 0;
      return paint(furrow ? tones.soilLight : tones.soilDark, 0.26);
    }
    case Cover.Wheat: {
      // Tramlines: the tyre tracks the sprayer leaves every eighteen metres.
      const tram = Math.abs(((x + 400) % 18) - 9) < 0.35 || Math.abs(((x + 400) % 18) - 7.2) < 0.35;
      if (tram) return paint(tones.soilLight, 0.26);
      return paint(mix(tones.wheat, tones.wheatShade, 0.5 + 0.5 * grain), 0.5, 0.85);
    }
    case Cover.Pasture:
      return paint(mix(tones.pasture, tones.grassDry, 0.25 + 0.3 * valueNoise(x / 12, z / 12, 16)), 0.44, 0.12);
    case Cover.Hay: {
      const windrow = Math.abs(((x + 400) % 6) - 3) < 0.6;
      return paint(windrow ? tones.hayRow : tones.hay, 0.42, windrow ? 0.35 : 0.08);
    }
    case Cover.ForestFloor:
      return paint(mix(tones.litter, tones.scrub, 0.4 + 0.4 * grain), 0.32, 0.25);
    case Cover.RightOfWay:
      return paint(mix(tones.scrub, tones.grassDry, 0.3 + 0.4 * valueNoise(x / 8, z / 8, 17)), 0.42, 0.45);
    case Cover.Bank:
      return paint(mix(tones.bank, tones.scrub, 0.5 + 0.5 * grain), 0.34, 0.3);
    case Cover.Water:
      return paint(rgb(60, 66, 62), 0.04);
    case Cover.Meadow:
    default:
      return paint(mix(tones.grassGreen, tones.grassDry, clamp(0.45 + 0.5 * fbm(x / 40, z / 40, 3, 18), 0, 1)), 0.44, 0.18);
  }
}

// ----------------------------------------------------------------- objects

export type Roof = "flat" | "gable" | "shed" | "cone";

/** A solid standing on the ground, drawn into the surface model: a building, a vehicle, a tank. */
export interface Block {
  readonly x: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly round: boolean;
  readonly base: number;
  readonly height: number;
  readonly roof: Roof;
  readonly ridge: number;
  readonly roofColour: Rgb;
  readonly wallColour: Rgb;
  readonly roofReflectance: number;
  readonly wallReflectance: number;
}

/** A heap of loose material at its angle of repose, round or drawn out along a line. */
export interface Pile {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly radius: number;
  readonly height: number;
  readonly base: number;
  readonly colour: Rgb;
  readonly reflectance: number;
}

export interface Tree {
  readonly x: number;
  readonly z: number;
  readonly base: number;
  readonly top: number;
  readonly crownBase: number;
  readonly radius: number;
  readonly conifer: boolean;
  readonly colour: Rgb;
  /** How much foliage slows a pulse, per metre travelled through the crown. */
  readonly density: number;
  readonly seed: number;
  /** The phase of the crown's lobes, as a unit vector, so shaping it needs no trigonometry per test. */
  readonly lobeCos: number;
  readonly lobeSin: number;
}

/** Something thin: a conductor, a steel member, a pole, a conveyor. */
export interface Thin {
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly radius: number;
  readonly colour: Rgb;
  readonly reflectance: number;
}

export interface Site {
  readonly blocks: Block[];
  readonly piles: Pile[];
  readonly trees: Tree[];
  readonly thins: Thin[];
}

function block(spec: {
  x: number;
  z: number;
  angle?: number;
  halfX: number;
  halfZ?: number;
  round?: boolean;
  base?: number;
  height: number;
  roof?: Roof;
  ridge?: number;
  roofColour: Rgb;
  wallColour: Rgb;
  roofReflectance?: number;
  wallReflectance?: number;
}): Block {
  const halfZ = spec.halfZ ?? spec.halfX;
  let base = spec.base;
  if (base === undefined) {
    base = Number.POSITIVE_INFINITY;
    for (const [dx, dz] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]] as const) base = Math.min(base, groundAt(spec.x + dx * spec.halfX, spec.z + dz * halfZ).height);
    base -= 0.1;
  }
  return {
    x: spec.x,
    z: spec.z,
    cos: Math.cos(spec.angle ?? 0),
    sin: Math.sin(spec.angle ?? 0),
    halfX: spec.halfX,
    halfZ,
    round: spec.round ?? false,
    base,
    height: spec.height,
    roof: spec.roof ?? "flat",
    ridge: spec.ridge ?? 0,
    roofColour: spec.roofColour,
    wallColour: spec.wallColour,
    roofReflectance: spec.roofReflectance ?? 0.35,
    wallReflectance: spec.wallReflectance ?? 0.3,
  };
}

/** Height of a block's top at a point in its own frame, or -Infinity outside it. */
export function blockTop(b: Block, u: number, v: number): number {
  if (b.round) {
    const r = Math.hypot(u, v);
    if (r > b.halfX) return Number.NEGATIVE_INFINITY;
    return b.base + b.height + (b.roof === "cone" ? b.ridge * (1 - r / b.halfX) : 0);
  }
  if (Math.abs(u) > b.halfX || Math.abs(v) > b.halfZ) return Number.NEGATIVE_INFINITY;
  const eaves = b.base + b.height;
  switch (b.roof) {
    case "gable":
      return eaves + b.ridge * (1 - Math.abs(v) / b.halfZ);
    case "shed":
      return eaves + (b.ridge * (v + b.halfZ)) / (2 * b.halfZ);
    default:
      return eaves;
  }
}

export function pileTop(p: Pile, x: number, z: number): number {
  const dx = p.bx - p.ax;
  const dz = p.bz - p.az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : clamp(((x - p.ax) * dx + (z - p.az) * dz) / lengthSq, 0, 1);
  const distance = Math.hypot(x - (p.ax + t * dx), z - (p.az + t * dz));
  if (distance >= p.radius) return Number.NEGATIVE_INFINITY;
  // Loose aggregate settles at about 34 degrees; the loader flattens the crest.
  const rise = Math.min(p.height, (p.radius - distance) * 0.67);
  return p.base + rise + 0.12 * valueNoise(x * 0.8, z * 0.8, 31);
}

const colours = {
  metalRoof: rgb(150, 154, 158),
  rustRoof: rgb(132, 84, 62),
  tile: rgb(122, 78, 62),
  render: rgb(206, 198, 180),
  concrete: rgb(170, 168, 160),
  steel: rgb(120, 126, 132),
  cabin: rgb(196, 198, 194),
  yellow: rgb(206, 164, 44),
  wood: rgb(104, 82, 60),
  galvanised: rgb(128, 131, 130),
  conductor: rgb(140, 142, 146),
};

const leafColours = [rgb(70, 90, 52), rgb(82, 100, 58), rgb(62, 82, 50), rgb(92, 104, 62), rgb(76, 96, 60)];
const needleColours = [rgb(50, 66, 48), rgb(56, 72, 50), rgb(46, 60, 46)];

function tree(random: Random, x: number, z: number, height: number, conifer: boolean, radius?: number): Tree {
  const base = groundAt(x, z).height - 0.05;
  const crownRadius = radius ?? (conifer ? height * (0.15 + random() * 0.05) : height * (0.2 + random() * 0.1));
  return {
    x,
    z,
    base,
    top: base + height,
    crownBase: base + height * (conifer ? 0.2 + random() * 0.15 : 0.35 + random() * 0.2),
    radius: crownRadius,
    conifer,
    colour: conifer ? needleColours[Math.floor(random() * needleColours.length)]! : leafColours[Math.floor(random() * leafColours.length)]!,
    density: conifer ? 0.5 : 0.36,
    ...lobes(random),
  };
}

function shrub(random: Random, x: number, z: number, height: number): Tree {
  const base = groundAt(x, z).height - 0.05;
  return { x, z, base, top: base + height, crownBase: base + 0.2, radius: height * (0.45 + random() * 0.25), conifer: false, colour: leafColours[Math.floor(random() * leafColours.length)]!, density: 0.9, ...lobes(random) };
}

function lobes(random: Random): { seed: number; lobeCos: number; lobeSin: number } {
  const phase = random() * Math.PI * 2;
  return { seed: Math.floor(random() * 1_000_000), lobeCos: Math.cos(phase), lobeSin: Math.sin(phase) };
}

function segment(thins: Thin[], a: readonly [number, number, number], b: readonly [number, number, number], radius: number, colour: Rgb, reflectance: number): void {
  thins.push({ ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], radius, colour, reflectance });
}

/** A conductor hanging between two attachment points, as a chain of short straight pieces. */
function conductor(thins: Thin[], a: readonly [number, number, number], b: readonly [number, number, number], sag: number, radius: number, colour: Rgb): void {
  const pieces = Math.max(4, Math.round(Math.hypot(b[0] - a[0], b[2] - a[2]) / 5));
  let previous = a;
  for (let piece = 1; piece <= pieces; piece += 1) {
    const t = piece / pieces;
    const point: [number, number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
    segment(thins, previous, point, radius, colour, 0.3);
    previous = point;
  }
}

// ---------------------------------------------------------------- the site

export function buildSite(random: Random): Site {
  const blocks: Block[] = [];
  const piles: Pile[] = [];
  const trees: Tree[] = [];
  const thins: Thin[] = [];

  // The processing pad: stockpiles, the crusher and screen house, a surge bin, conveyors and the site cabins.
  const pile = (ax: number, az: number, bx: number, bz: number, radius: number, height: number, colour: Rgb, reflectance: number) =>
    piles.push({ ax, az, bx, bz, radius, height, base: padLevel - 0.05, colour, reflectance });
  pile(36, 24, 36, 24, 14, 8.5, rgb(186, 160, 120), 0.46);
  pile(62, 31, 62, 31, 12, 7.5, rgb(160, 156, 148), 0.5);
  pile(80, 25, 104, 32, 10, 6.5, rgb(138, 136, 130), 0.44);
  pile(104, 2, 104, 2, 8, 4.5, rgb(112, 92, 70), 0.3);
  pile(22, -2, 30, 6, 7, 3.5, rgb(170, 166, 156), 0.52);

  const plant = { roofColour: colours.metalRoof, wallColour: colours.steel, roofReflectance: 0.4, wallReflectance: 0.35 };
  const crusher = block({ ...plant, x: 78, z: -8, halfX: 8, halfZ: 6, base: padLevel, height: 14 });
  const screens = block({ ...plant, x: 98, z: -14, halfX: 5, halfZ: 4, base: padLevel, height: 18 });
  blocks.push(crusher, screens, block({ ...plant, x: 88, z: 6, halfX: 5, round: true, base: padLevel, height: 15, roof: "cone", ridge: 3 }));
  blocks.push(block({ x: 28, z: -12, halfX: 12, halfZ: 7, base: padLevel, height: 7, roof: "gable", ridge: 2.2, roofColour: colours.rustRoof, wallColour: colours.steel, roofReflectance: 0.3 }));
  for (const [x, z] of [[16, 32], [16, 36], [30, 40]] as const) {
    blocks.push(block({ x, z, halfX: 6, halfZ: 1.6, base: padLevel, height: 2.9, roofColour: colours.cabin, wallColour: colours.cabin, roofReflectance: 0.5 }));
  }
  blocks.push(block({ x: 44, z: 36, halfX: 9, halfZ: 1.8, base: padLevel, height: 0.35, roofColour: colours.concrete, wallColour: colours.concrete, roofReflectance: 0.4 }));

  // Conveyors run from the screen house out to the crests of the piles, on trestles.
  const belt = (from: readonly [number, number, number], to: readonly [number, number, number]) => {
    segment(thins, from, to, 0.7, colours.steel, 0.3);
    const length = Math.hypot(to[0] - from[0], to[2] - from[2]);
    for (let d = 8; d < length - 4; d += 9) {
      const t = d / length;
      const x = from[0] + (to[0] - from[0]) * t;
      const y = from[1] + (to[1] - from[1]) * t;
      const z = from[2] + (to[2] - from[2]) * t;
      segment(thins, [x, padLevel, z], [x, y - 0.7, z], 0.2, colours.steel, 0.3);
    }
  };
  belt([86, padLevel + 12, -10], [96, padLevel + 16, -13]);
  belt([98, padLevel + 16, -10], [62, padLevel + 8, 31]);
  belt([100, padLevel + 16, -10], [92, padLevel + 7, 28]);
  belt([95, padLevel + 15, -12], [104, padLevel + 5, 2]);

  // Plant on the move: haul trucks, a wheel loader, an excavator on a bench, cars by the cabins.
  const machine = (x: number, z: number, angle: number, halfX: number, halfZ: number, height: number, colour: Rgb) =>
    blocks.push(block({ x, z, angle, halfX, halfZ, height, roofColour: colour, wallColour: colour, roofReflectance: 0.45, wallReflectance: 0.4 }));
  machine(101, -27, 1.1, 5, 2.4, 4.3, colours.yellow);
  machine(46, 55, 1.5, 5, 2.4, 4.3, colours.yellow);
  machine(50, 22, 0.4, 3.4, 1.4, 3.3, colours.yellow);
  const benchSpot = (() => {
    const theta = rampStart + 1.2;
    const rho = 1 + (-25 / 72);
    return [quarry.x + Math.cos(theta) * rho * quarry.ax * 1.08, quarry.z + Math.sin(theta) * rho * quarry.az * 1.08] as const;
  })();
  machine(benchSpot[0], benchSpot[1], 0.7, 3, 1.6, 3.1, colours.yellow);
  for (const [x, z, colour] of [[10, 44, rgb(40, 44, 50)], [13, 44, rgb(176, 178, 182)], [16, 44, rgb(150, 40, 36)], [22, 44, rgb(210, 210, 206)]] as const) {
    machine(x, z, Math.PI / 2, 2.2, 0.9, 1.5, colour);
  }

  // The farm: a house with a wing, a barn, a machinery shed and two grain bins.
  const farmAngle = -0.18;
  const turn = (dx: number, dz: number): [number, number] => [yard.x + dx * Math.cos(farmAngle) - dz * Math.sin(farmAngle), yard.z + dx * Math.sin(farmAngle) + dz * Math.cos(farmAngle)];
  const farm = (dx: number, dz: number, spec: Omit<Parameters<typeof block>[0], "x" | "z">) => {
    const [x, z] = turn(dx, dz);
    blocks.push(block({ ...spec, x, z, angle: (spec.angle ?? 0) + farmAngle }));
  };
  farm(-18, -12, { halfX: 8, halfZ: 5, height: 5.6, roof: "gable", ridge: 3.4, roofColour: colours.tile, wallColour: colours.render, roofReflectance: 0.28 });
  farm(-12, -3, { halfX: 3.5, halfZ: 4.5, height: 3.2, roof: "gable", ridge: 2.2, roofColour: colours.tile, wallColour: colours.render, roofReflectance: 0.28 });
  farm(12, -10, { halfX: 16, halfZ: 8, height: 6.5, roof: "gable", ridge: 3.6, roofColour: colours.metalRoof, wallColour: colours.wood, roofReflectance: 0.42 });
  farm(8, 12, { halfX: 11, halfZ: 5, height: 4.5, roof: "shed", ridge: 1.2, roofColour: colours.rustRoof, wallColour: colours.wood, roofReflectance: 0.3 });
  farm(30, 4, { halfX: 3.4, round: true, height: 10, roof: "cone", ridge: 2.2, roofColour: colours.galvanised, wallColour: colours.galvanised, roofReflectance: 0.55, wallReflectance: 0.5 });
  farm(30, 12, { halfX: 3.4, round: true, height: 10, roof: "cone", ridge: 2.2, roofColour: colours.galvanised, wallColour: colours.galvanised, roofReflectance: 0.55, wallReflectance: 0.5 });
  farm(-4, 10, { halfX: 2.6, halfZ: 1.2, height: 2.8, roofColour: rgb(60, 104, 60), wallColour: rgb(60, 104, 60), roofReflectance: 0.35 });

  // Two houses along the road, east of the site entrance.
  for (const [x, z, angle] of [[156, 48, 0.12], [196, 52, -0.1]] as const) {
    blocks.push(block({ x, z, angle, halfX: 7, halfZ: 5, height: 5.2, roof: "gable", ridge: 3, roofColour: colours.tile, wallColour: colours.render, roofReflectance: 0.28 }));
    blocks.push(block({ x: x + 12, z: z - 4, angle, halfX: 3, halfZ: 2.8, height: 2.6, roof: "gable", ridge: 1, roofColour: colours.metalRoof, wallColour: colours.wood }));
    for (let index = 0; index < 3; index += 1) trees.push(tree(random, x + jitter(random, 30), z - 12 - random() * 10, 7 + random() * 6, random() < 0.3));
  }

  // The transmission line: lattice towers carrying a double circuit and an earth wire.
  const dx = lineEnd[0] - lineStart[0];
  const dz = lineEnd[1] - lineStart[1];
  const length = Math.hypot(dx, dz);
  const along = [dx / length, dz / length] as const;
  const across = [-along[1], along[0]] as const;
  let previous: Array<[number, number, number]> | undefined;
  for (const fraction of towerFractions) {
    const tx = lineStart[0] + dx * fraction;
    const tz = lineStart[1] + dz * fraction;
    const base = groundAt(tx, tz).height - 0.2;
    const at = (a: number, c: number, h: number): [number, number, number] => [tx + along[0] * a + across[0] * c, base + h, tz + along[1] * a + across[1] * c];
    const width = (h: number) => 4.5 - (3.3 * h) / 42;
    const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    for (const [sa, sc] of legs) segment(thins, at(sa * width(0), sc * width(0), 0), at(sa * width(38), sc * width(38), 38), 0.18, colours.galvanised, 0.35);
    for (let face = 0; face < 4; face += 1) {
      const [a1, c1] = legs[face]!;
      const [a2, c2] = legs[(face + 1) % 4]!;
      for (let h = 0; h < 36; h += 6) {
        const next = h + 6;
        segment(thins, at(a1 * width(h), c1 * width(h), h), at(a2 * width(next), c2 * width(next), next), 0.08, colours.galvanised, 0.35);
        segment(thins, at(a2 * width(h), c2 * width(h), h), at(a1 * width(next), c1 * width(next), next), 0.08, colours.galvanised, 0.35);
      }
    }
    const attachments: Array<[number, number, number]> = [];
    for (const [h, reach] of [[27, 7.5], [32, 8.5], [37, 6.5]] as const) {
      segment(thins, at(0, -reach, h), at(0, reach, h), 0.25, colours.galvanised, 0.35);
      for (const side of [-1, 1]) {
        const tip = at(0, side * reach, h - 2.4);
        segment(thins, at(0, side * reach, h), tip, 0.15, rgb(150, 160, 170), 0.3);
        attachments.push(tip);
      }
    }
    const peak = at(0, 0, 43);
    for (const [sa, sc] of legs) segment(thins, at(sa * width(38), sc * width(38), 38), peak, 0.1, colours.galvanised, 0.35);
    attachments.push(peak);
    if (previous !== undefined) {
      attachments.forEach((point, index) => conductor(thins, previous![index]!, point, index === attachments.length - 1 ? 3.5 : 5.2, 0.16, colours.conductor));
    }
    previous = attachments;
  }

  // Wooden distribution poles along the north verge of the road, with three conductors.
  const road = paths[0]!;
  const poles: Array<Array<[number, number, number]>> = [];
  for (let d = 20; d < road.along[road.along.length - 1]!; d += 46) {
    let index = 0;
    while (index < road.along.length - 2 && road.along[index + 1]! < d) index += 1;
    const t = (d - road.along[index]!) / (road.along[index + 1]! - road.along[index]!);
    const x = road.xs[index]! + (road.xs[index + 1]! - road.xs[index]!) * t;
    const z = road.zs[index]! + (road.zs[index + 1]! - road.zs[index]!) * t;
    const ux = road.xs[index + 1]! - road.xs[index]!;
    const uz = road.zs[index + 1]! - road.zs[index]!;
    const norm = Math.hypot(ux, uz);
    const nx = uz / norm;
    const nz = -ux / norm;
    const px = x + nx * 6.5;
    const pz = z + nz * 6.5;
    if (Math.abs(px) > halfWidth + 20) continue;
    const ground = groundAt(px, pz).height;
    segment(thins, [px, ground, pz], [px, ground + 9.6, pz], 0.14, colours.wood, 0.3);
    const arm = (s: number): [number, number, number] => [px + nx * s, ground + 9.1, pz + nz * s];
    segment(thins, arm(-1.1), arm(1.1), 0.1, colours.wood, 0.3);
    poles.push([arm(-1), [px, ground + 9.8, pz], arm(1)]);
  }
  for (let index = 1; index < poles.length; index += 1) {
    for (let wire = 0; wire < 3; wire += 1) conductor(thins, poles[index - 1]![wire]!, poles[index]![wire]!, 0.8, 0.07, colours.conductor);
  }

  // --- vegetation

  // A conifer plantation in rows, the way forestry plants it.
  const rowAngle = 0.35;
  for (let a = -160; a < 160; a += 4.2) {
    for (let b = -160; b < 160; b += 4.2) {
      const x = -176 + a * Math.cos(rowAngle) - b * Math.sin(rowAngle) + jitter(random, 0.6);
      const z = -146 + a * Math.sin(rowAngle) + b * Math.cos(rowAngle) + jitter(random, 0.6);
      if (x < plantation.minX || x > plantation.maxX || z < plantation.minZ || z > plantation.maxZ) continue;
      if (random() < 0.07 || distanceFromLine(x, z) < rightOfWay || !openForTrees(x, z)) continue;
      const stand = 17 + 2.5 * fbm(x / 40, z / 40, 2, 41);
      trees.push(tree(random, x, z, stand + jitter(random, 2), true, 1.9 + random() * 0.6));
    }
  }

  // Natural mixed forest, with an understory, snags, and scrub regrowing under the power line.
  const spacing = 6;
  for (let z = -halfDepth; z < halfDepth; z += spacing) {
    for (let x = -halfWidth; x < halfWidth; x += spacing) {
      const tx = x + jitter(random, spacing);
      const tz = z + jitter(random, spacing);
      if (tx > plantation.minX - 2 && tx < plantation.maxX && tz > plantation.minZ && tz < plantation.maxZ) continue;
      const score = forestScore(tx, tz);
      if (score <= 0 || !openForTrees(tx, tz)) continue;
      if (distanceFromLine(tx, tz) < rightOfWay) {
        if (random() < 0.55) trees.push(shrub(random, tx, tz, 1.2 + random() * 3));
        continue;
      }
      if (random() > 0.55 + score) continue;
      const age = 0.5 + 0.5 * fbm(tx / 60, tz / 60, 2, 42);
      const height = 9 + 15 * age + jitter(random, 5);
      const conifer = random() < 0.2 + 0.35 * smoothstep(40, 60, naturalHeight(tx, tz));
      if (random() < 0.025) {
        // A dead standing tree: a bare trunk and a couple of limbs.
        const base = groundAt(tx, tz).height;
        segment(thins, [tx, base, tz], [tx, base + height * 0.8, tz], 0.25, rgb(120, 110, 96), 0.4);
        segment(thins, [tx, base + height * 0.55, tz], [tx + 2, base + height * 0.7, tz + 1], 0.12, rgb(120, 110, 96), 0.4);
        continue;
      }
      trees.push(tree(random, tx, tz, height, conifer));
      if (random() < 0.35) trees.push(shrub(random, tx + jitter(random, 5), tz + jitter(random, 5), 1 + random() * 2.5));
    }
  }

  // Trees growing into the right-of-way, closer to the conductors than a utility allows.
  for (const fraction of [0.21, 0.4, 0.58]) {
    const x = lineStart[0] + dx * fraction + across[0] * 11;
    const z = lineStart[1] + dz * fraction + across[1] * 11;
    trees.push(tree(random, x, z, 17 + random() * 4, false));
  }

  // Alders and willows along the creek, hedgerows between the fields, and field trees.
  for (let x = -halfWidth; x < halfWidth; x += 5 + random() * 4) {
    for (const side of [-1, 1]) {
      if (random() > 0.72) continue;
      const tx = x + jitter(random, 2);
      const tz = creekZ(tx) + side * (5 + random() * 5);
      if (!openForTrees(tx, tz) && Math.abs(tz - creekZ(tx)) < 4.5) continue;
      if (nearestPath(tx, tz) !== undefined && nearestPath(tx, tz)!.distance < nearestPath(tx, tz)!.path.halfWidth + 3) continue;
      trees.push(tree(random, tx, tz, 8 + random() * 9, false, 2.8 + random() * 2.4));
    }
  }
  for (const field of fields) {
    const cos = Math.cos(field.angle);
    const sin = Math.sin(field.angle);
    for (const [u0, v0, u1, v1] of [
      [-1, -1, 1, -1],
      [1, -1, 1, 1],
      [-1, 1, 1, 1],
      [-1, -1, -1, 1],
    ] as const) {
      if (random() < 0.3) continue;
      const length = Math.hypot((u1 - u0) * field.halfX, (v1 - v0) * field.halfZ);
      for (let d = 0; d < length; d += 3 + random() * 2) {
        if (random() < 0.12) continue;
        const t = d / length;
        const u = (u0 + (u1 - u0) * t) * (field.halfX + 2);
        const v = (v0 + (v1 - v0) * t) * (field.halfZ + 2);
        const x = field.x + u * cos - v * sin;
        const z = field.z + u * sin + v * cos;
        if (Math.abs(z - creekZ(x)) < 5 || Math.abs(x) > halfWidth || Math.abs(z) > halfDepth) continue;
        const path = nearestPath(x, z);
        if (path !== undefined && path.distance < path.path.halfWidth + 2) continue;
        trees.push(random() < 0.12 ? tree(random, x, z, 9 + random() * 6, false) : shrub(random, x, z, 2.5 + random() * 2.5));
      }
    }
  }
  for (const [x, z] of [[-52, 128], [-24, 156], [-40, 170]] as const) trees.push(tree(random, x, z, 13 + random() * 4, false, 6 + random() * 1.5));
  for (let index = 0; index < 8; index += 1) {
    const [x, z] = turn(-30 + random() * 20, -26 + random() * 8);
    trees.push(tree(random, x, z, 7 + random() * 7, random() < 0.3));
  }
  // Scrub colonising the pad's embankments.
  for (let index = 0; index < 60; index += 1) {
    const side = random() * 4;
    const t = random() * 2 - 1;
    const x = side < 1 ? pad.x - pad.halfX - 8 : side < 2 ? pad.x + pad.halfX + 8 : pad.x + t * pad.halfX;
    const z = side < 2 ? pad.z + t * pad.halfZ : side < 3 ? pad.z - pad.halfZ - 8 : pad.z + pad.halfZ + 8;
    if (nearestPath(x, z) !== undefined) continue;
    if (quarryAt(x, z).rho < 1.1) continue;
    trees.push(shrub(random, x + jitter(random, 4), z + jitter(random, 4), 1 + random() * 2.5));
  }

  // Trunks, up into the lower crown: thin, so traced exactly like the conductors.
  for (const t of trees) {
    if (t.top - t.base < 5) continue;
    segment(thins, [t.x, t.base, t.z], [t.x, t.crownBase + (t.top - t.crownBase) * 0.3, t.z], 0.12 + (t.top - t.base) * 0.012, rgb(92, 80, 66), 0.3);
  }

  return { blocks, piles, trees, thins };
}

/** A per-tree, per-voxel variation in foliage, so crowns have gaps and clumps instead of an even fog. */
export function foliageClump(tree: Tree, x: number, y: number, z: number): number {
  return 0.25 + 1.5 * hash(Math.floor(x * 1.3), Math.floor(y * 1.3), Math.floor(z * 1.3) + tree.seed);
}

/** Whether a point is inside a tree's crown. Broadleaf crowns are lumpy ellipsoids, conifers tiered cones. */
export function insideCrown(tree: Tree, x: number, y: number, z: number): boolean {
  if (y < tree.crownBase || y > tree.top) return false;
  const dx = x - tree.x;
  const dz = z - tree.z;
  const horizontal = dx * dx + dz * dz;
  if (horizontal > tree.radius * tree.radius * 1.4) return false;
  if (tree.conifer) {
    const t = (tree.top - y) / (tree.top - tree.crownBase);
    const radius = tree.radius * t * (0.78 + 0.22 * ((t * 9) % 1));
    return horizontal < radius * radius;
  }
  const half = (tree.top - tree.crownBase) / 2;
  const dy = (y - tree.crownBase - half) / half;
  // Three lobes round the crown: sin(3θ + φ), from the direction's sine and cosine.
  const length = Math.sqrt(horizontal) || 1;
  const c = dx / length;
  const s = dz / length;
  const sin3 = 3 * s - 4 * s * s * s;
  const cos3 = 4 * c * c * c - 3 * c;
  const lobe = 1 + 0.18 * (sin3 * tree.lobeCos + cos3 * tree.lobeSin) + 0.08 * (c * c - s * s) + 0.1 * dy;
  const radius = tree.radius * lobe;
  return horizontal / (radius * radius) + dy * dy < 1;
}
