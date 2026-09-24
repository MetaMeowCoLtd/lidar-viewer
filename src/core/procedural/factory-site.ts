import { clamp, fbm, hash, jitter, mix, rgb, smoothstep, valueNoise, type Random, type Rgb } from "./sampling.js";

/**
 * The ground truth of the sample survey: a mid-sized manufacturing plant and
 * the land around it, 190 × 144 m, as a drone operator would be hired to fly
 * it. The contents follow what published industrial drone LiDAR work
 * actually delivers:
 *
 * - An as-built of the plant for re-engineering: buildings, conveyors, tanks
 *   and stockpile areas (YellowScan's survey of the Huasco pellet plant was
 *   flown to relocate conveyors and thickeners, plan new stockpile sites and
 *   refurbish corroded buildings).
 * - A topographic survey for expansion: the graded plot next door, its
 *   stormwater pond and the drainage of the surrounding fields - contours,
 *   bare-earth model and flood-prone ground are the standard deliverables.
 * - Stockpile volumes in the yard and on the plot.
 * - The details as-built drone surveys are praised for: light poles, fences,
 *   kerbs, vehicles, overhead lines, the solar and plant on a roof.
 *
 * Coordinates are metres in the viewer's frame: x east, y up, z south.
 */

export const halfWidth = 95;
export const halfDepth = 72;

/**
 * How the site is flown, after DJI's reference mission for its Zenmuse L2:
 * straight east-west strips with 20% side overlap, the 70° repetitive line
 * scan, nadir. At this site's size two strips at about 90 m cover it.
 */
export const flight = {
  stripZs: [-50, 50] as readonly number[],
  runIn: 28,
  heightAboveHighest: 84,
  halfFieldOfView: (35 * Math.PI) / 180,
};

// -------------------------------------------------------------- terrain

/** Farmland falling gently to the south-east, where the site drains. */
export function naturalHeight(x: number, z: number): number {
  return 100 - 0.024 * z + 0.011 * x + 0.8 * fbm(x / 55 + 3.2, z / 55 - 1.7, 3, 1) + 0.12 * fbm(x / 9, z / 9, 2, 2);
}

/** The level platform the plant stands on, cut and filled, with embankments at its edge. */
const platform = { x: -23, z: -6, halfX: 65, halfZ: 51 };
export const platformLevel = Math.round(naturalHeight(platform.x, platform.z) * 2) / 2;
/** The expansion plot: stripped of topsoil and graded a little lower, waiting for the next building. */
const plot = { x: 70, z: 0, halfX: 22, halfZ: 38 };
export const plotLevel = platformLevel - 1.2;
/** The stormwater attenuation pond in the low corner. */
const pond = { x: 72, z: 52, rx: 13, rz: 7.5, depth: 2.6 };
const carPark = { minX: -86, maxX: -44, minZ: 26, maxZ: 42 };

function inBox(box: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number): boolean {
  return x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ;
}

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

export const paths: ReadonlyArray<Path> = [
  makePath("paved", 3.3, [[-105, 63], [-50, 61], [0, 63.5], [50, 62], [105, 60]]),
  // The site entrance, through the gate into the yard.
  makePath("paved", 4, [[-20, 61], [-20, 52], [-20, 44]]),
  // The haul track from the yard onto the expansion plot.
  makePath("gravel", 3, [[42, 28], [56, 22], [68, 8]]),
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

/** What the ground is covered with, as a small code so a whole raster of it stays compact. */
export const Cover = {
  Meadow: 0,
  Water: 1,
  Paved: 2,
  Concrete: 3,
  Gravel: 4,
  Soil: 5,
  Lawn: 6,
  ForestFloor: 7,
  Bank: 8,
  Parking: 9,
} as const;
export type Cover = (typeof Cover)[keyof typeof Cover];

/** The strip of woodland along the north-east boundary. */
export function woodlandAt(x: number, z: number): boolean {
  return x > 46 && z < -42 + 4 * valueNoise(x / 12, 3, 8);
}

export interface GroundCell {
  height: number;
  cover: Cover;
}

const cell: GroundCell = { height: 0, cover: Cover.Meadow };

/** The finished ground at a point - natural, cut, filled and graded - and what covers it. */
export function groundAt(x: number, z: number): GroundCell {
  const natural = naturalHeight(x, z);
  let height = natural;
  let cover: Cover = Cover.Meadow;

  const onPlatform = boxFalloff(platform, x, z, 7);
  if (onPlatform > 0) {
    height += (platformLevel - height) * onPlatform;
    if (onPlatform > 0.9) cover = inBox(carPark, x, z) ? Cover.Parking : x < -44 && z > -2 ? Cover.Lawn : Cover.Concrete;
  }
  const onPlot = boxFalloff(plot, x, z, 6);
  if (onPlot > 0) {
    height += (plotLevel - height) * onPlot;
    if (onPlot > 0.8) cover = Cover.Soil;
  }

  const pondRadius = Math.hypot((x - pond.x) / pond.rx, (z - pond.z) / pond.rz);
  if (pondRadius < 1.4) {
    const dug = natural - pond.depth * Math.max(0, 1 - pondRadius * pondRadius);
    height = Math.min(height, dug);
    if (pondRadius < 0.72) cover = Cover.Water;
    else if (pondRadius < 1.1) cover = Cover.Bank;
  }

  const path = nearestPath(x, z);
  if (path !== undefined) {
    const edge = path.distance - path.path.halfWidth;
    if (edge < 3 && onPlatform < 0.9) {
      const grade = 1 - smoothstep(0, 3, edge);
      height += (natural - height) * grade * 0.5;
    }
    if (path.path === paths[0] && edge > 0.8 && edge < 2.8) height -= 0.45 * Math.sin(((edge - 0.8) / 2) * Math.PI);
    if (edge < 0) cover = path.path.kind === "paved" ? Cover.Paved : Cover.Gravel;
  }

  if (cover === Cover.Meadow && woodlandAt(x, z)) cover = Cover.ForestFloor;
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
  asphalt: rgb(72, 72, 75),
  parking: rgb(84, 84, 86),
  paint: rgb(210, 210, 202),
  concrete: rgb(168, 166, 158),
  joint: rgb(128, 126, 120),
  stain: rgb(110, 108, 102),
  gravel: rgb(152, 144, 126),
  soilLight: rgb(136, 112, 86),
  soilDark: rgb(110, 90, 68),
  lawn: rgb(96, 128, 66),
  lawnStripe: rgb(110, 140, 74),
  grassGreen: rgb(104, 120, 72),
  grassDry: rgb(146, 142, 98),
  litter: rgb(84, 80, 58),
  bank: rgb(108, 114, 78),
  water: rgb(86, 100, 108),
} as const;

/** What a laser pulse, and a camera, would see on the ground at a point. */
export function surfaceAt(cover: Cover, x: number, z: number, slope: number): Surface {
  const grain = valueNoise(x * 0.9, z * 0.9, 11);
  switch (cover) {
    case Cover.Paved: {
      const path = nearestPath(x, z);
      if (path !== undefined && path.path === paths[0]) {
        const offset = Math.abs(path.across);
        const dashed = offset < 0.1 && path.along % 9 < 3;
        const edge = Math.abs(offset - (path.path.halfWidth - 0.25)) < 0.08;
        if (dashed || edge) return paint(tones.paint, 0.62);
      }
      return paint(mix(tones.asphalt, tones.stain, 0.25 + 0.2 * grain), 0.12);
    }
    case Cover.Parking: {
      // Bays 2.5 m wide in two rows nose to nose, and the line down the middle.
      const bay = (((x - carPark.minX) % 2.5) + 2.5) % 2.5 < 0.12;
      const inRows = z > carPark.minZ + 1 && z < carPark.minZ + 11;
      if ((bay && inRows) || Math.abs(z - (carPark.minZ + 6)) < 0.07) return paint(tones.paint, 0.6);
      return paint(mix(tones.parking, tones.stain, 0.3 + 0.2 * grain), 0.14);
    }
    case Cover.Concrete: {
      // Slabs cast in six-metre bays, with the stains a working yard collects.
      const joint = ((x + 600) % 6) < 0.12 || ((z + 600) % 6) < 0.12;
      if (joint) return paint(tones.joint, 0.28);
      const stain = smoothstep(0.35, 0.8, valueNoise(x / 4, z / 4, 19));
      return paint(mix(tones.concrete, tones.stain, stain * 0.7), 0.36 - stain * 0.1);
    }
    case Cover.Gravel:
      return paint(mix(tones.gravel, tones.soilDark, 0.2 + 0.3 * grain), 0.34);
    case Cover.Soil: {
      // Stripped ground, tracked by the machines that graded it.
      const track = Math.abs(Math.sin((x * 0.8 + z * 0.35) * 1.3)) > 0.93;
      return paint(track ? tones.soilDark : mix(tones.soilLight, tones.soilDark, 0.3 + 0.3 * valueNoise(x / 6, z / 6, 14)), 0.27);
    }
    case Cover.Lawn: {
      const stripe = Math.floor((x + 600) / 1.6) % 2 === 0;
      return paint(stripe ? tones.lawn : tones.lawnStripe, 0.46, 0.05);
    }
    case Cover.ForestFloor:
      return paint(mix(tones.litter, tones.grassGreen, 0.3 + 0.4 * grain), 0.32, 0.25);
    case Cover.Bank:
      return paint(mix(tones.bank, tones.grassDry, 0.3 + 0.3 * grain), 0.4, 0.4);
    case Cover.Water:
      return paint(tones.water, 0.04);
    case Cover.Meadow:
    default:
      return paint(mix(tones.grassGreen, tones.grassDry, clamp(0.45 + 0.5 * fbm(x / 30, z / 30, 3, 18) + slope * 0.2, 0, 1)), 0.44, 0.2);
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
  roofMetal: rgb(148, 152, 156),
  cladding: rgb(178, 182, 184),
  claddingBlue: rgb(116, 136, 150),
  office: rgb(204, 198, 186),
  gravelRoof: rgb(140, 138, 130),
  concrete: rgb(170, 168, 160),
  steel: rgb(118, 124, 130),
  galvanised: rgb(150, 154, 154),
  tank: rgb(208, 208, 202),
  solar: rgb(34, 46, 84),
  yellow: rgb(206, 164, 44),
  wood: rgb(104, 82, 60),
  conductor: rgb(140, 142, 146),
  fence: rgb(96, 110, 96),
};

const carPaints = [rgb(40, 44, 50), rgb(176, 178, 182), rgb(210, 210, 206), rgb(150, 40, 36), rgb(44, 70, 120), rgb(96, 98, 104)];

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
  const level = platformLevel;
  const box = (spec: Parameters<typeof block>[0]) => blocks.push(block(spec));
  const line = (a: readonly [number, number, number], b: readonly [number, number, number], radius: number, colour: Rgb, reflectance = 0.3) =>
    segment(thins, a, b, radius, colour, reflectance);

  // The production hall: a portal-frame shed with a shallow ridge running east-west.
  const hall = { x: -25, z: -22, halfX: 35, halfZ: 19, height: 10, ridge: 1.6 };
  box({ ...hall, base: level, roof: "gable", roofColour: colours.roofMetal, wallColour: colours.cladding, roofReflectance: 0.45, wallReflectance: 0.4 });
  const hallRoof = (z: number) => level + hall.height + hall.ridge * (1 - Math.abs(z - hall.z) / hall.halfZ);
  // Air handling units on the north slope, a solar array on the south one.
  for (const x of [-50, -38, -26, -14, -2]) box({ x, z: -33, halfX: 2.2, halfZ: 1.5, base: hallRoof(-33), height: 1.7, roofColour: colours.galvanised, wallColour: colours.galvanised, roofReflectance: 0.5 });
  for (let v = 3; v < 17; v += 2.3) {
    const z = hall.z + v;
    box({ x: -26, z, halfX: 29, halfZ: 0.85, base: hallRoof(z) + 0.2, height: 0.25, roofColour: colours.solar, wallColour: colours.steel, roofReflectance: 0.1 });
  }

  // The warehouse, with trailers backed onto its loading docks.
  box({ x: 27, z: -25, halfX: 13, halfZ: 12, base: level, height: 9, roofColour: colours.gravelRoof, wallColour: colours.claddingBlue, roofReflectance: 0.36, wallReflectance: 0.34 });
  for (const [x, colour] of [[19, rgb(214, 214, 210)], [26, rgb(60, 86, 130)], [33, rgb(214, 214, 210)]] as const) {
    box({ x, z: -5.6, angle: Math.PI / 2, halfX: 6.8, halfZ: 1.25, base: level, height: 4, roofColour: colour, wallColour: colour, roofReflectance: 0.5 });
  }
  box({ x: 38, z: 9, angle: 0.3, halfX: 3, halfZ: 1.25, base: level, height: 3.4, roofColour: rgb(170, 40, 34), wallColour: rgb(170, 40, 34) });

  // Silos fed by a bucket elevator, with a gallery across their tops and a conveyor into the hall.
  const siloXs = [-1, 6, 13];
  for (const x of siloXs) box({ x, z: 10, halfX: 3.1, round: true, base: level, height: 15, roof: "cone", ridge: 2.4, roofColour: colours.galvanised, wallColour: colours.galvanised, roofReflectance: 0.55, wallReflectance: 0.5 });
  box({ x: -9, z: 10, halfX: 1.2, halfZ: 1.2, base: level, height: 23, roofColour: colours.steel, wallColour: colours.steel });
  line([-9, level + 20.5, 10], [13, level + 20.5, 10], 0.7, colours.steel);
  line([-9, level + 20, 9], [-9, level + 11.6, -3], 0.6, colours.steel);

  // The tank farm inside its bund, and the pipe rack that carries its lines to the hall and warehouse.
  for (const [x, z] of [[-78, -48], [-68, -48], [-78, -36], [-68, -36]] as const) {
    box({ x, z, halfX: 4, round: true, base: level, height: 8, roof: "cone", ridge: 0.6, roofColour: colours.tank, wallColour: colours.tank, roofReflectance: 0.6, wallReflectance: 0.55 });
  }
  const bund = { minX: -85, maxX: -61.5, minZ: -55, maxZ: -29 };
  box({ x: (bund.minX + bund.maxX) / 2, z: bund.minZ, halfX: (bund.maxX - bund.minX) / 2, halfZ: 0.15, base: level, height: 1.1, roofColour: colours.concrete, wallColour: colours.concrete });
  box({ x: (bund.minX + bund.maxX) / 2, z: bund.maxZ, halfX: (bund.maxX - bund.minX) / 2, halfZ: 0.15, base: level, height: 1.1, roofColour: colours.concrete, wallColour: colours.concrete });
  box({ x: bund.minX, z: (bund.minZ + bund.maxZ) / 2, halfX: 0.15, halfZ: (bund.maxZ - bund.minZ) / 2, base: level, height: 1.1, roofColour: colours.concrete, wallColour: colours.concrete });
  box({ x: bund.maxX, z: (bund.minZ + bund.maxZ) / 2, halfX: 0.15, halfZ: (bund.maxZ - bund.minZ) / 2, base: level, height: 1.1, roofColour: colours.concrete, wallColour: colours.concrete });
  for (let x = -62; x <= 20; x += 6) {
    line([x, level, -46], [x, level + 5.6, -46], 0.15, colours.steel);
    line([x, level + 5.6, -47.2], [x, level + 5.6, -44.8], 0.12, colours.steel);
  }
  for (const [offset, radius] of [[-0.8, 0.2], [0, 0.15], [0.8, 0.25]] as const) line([-62, level + 5.9, -46 + offset], [20, level + 5.9, -46 + offset], radius, colours.galvanised);
  box({ x: 18, z: -52, halfX: 1.1, round: true, base: level, height: 24, roofColour: rgb(60, 58, 56), wallColour: colours.concrete });

  // The office and its car park, the gatehouse and barrier.
  box({ x: -68, z: 10, halfX: 14, halfZ: 8, base: level, height: 10.5, roofColour: colours.gravelRoof, wallColour: colours.office, roofReflectance: 0.36, wallReflectance: 0.42 });
  box({ x: -64, z: 8, halfX: 3, halfZ: 2, base: level + 10.5, height: 1.6, roofColour: colours.galvanised, wallColour: colours.galvanised });
  for (const rowZ of [carPark.minZ + 3.5, carPark.minZ + 8.5]) {
    for (let x = carPark.minX + 1.25; x < carPark.maxX - 1; x += 2.5) {
      if (random() < 0.35) continue;
      const paint = carPaints[Math.floor(random() * carPaints.length)]!;
      box({ x, z: rowZ, angle: Math.PI / 2, halfX: 2.2, halfZ: 0.9, base: level, height: 1.45, roofColour: paint, wallColour: paint, roofReflectance: 0.5 });
    }
  }
  box({ x: -13, z: 40, halfX: 2, halfZ: 1.6, base: level, height: 3, roofColour: colours.gravelRoof, wallColour: colours.office });
  line([-24, level + 1, 44], [-16.5, level + 1, 44], 0.06, rgb(210, 60, 50));

  // Yard stockpiles of raw material, and the loader that works them.
  piles.push({ ax: 30, az: 24, bx: 30, bz: 24, radius: 8, height: 4, base: level - 0.05, colour: rgb(160, 156, 148), reflectance: 0.5 });
  piles.push({ ax: 18, az: 35, bx: 22, bz: 37, radius: 5.5, height: 2.8, base: level - 0.05, colour: rgb(190, 164, 122), reflectance: 0.46 });
  box({ x: 37, z: 31, angle: -0.6, halfX: 3.2, halfZ: 1.3, base: level, height: 3.2, roofColour: colours.yellow, wallColour: colours.yellow, roofReflectance: 0.45 });

  // The expansion plot: a topsoil heap, a windrow, an excavator and a dumper.
  piles.push({ ax: 70, az: -22, bx: 74, bz: -18, radius: 10, height: 3.5, base: plotLevel - 0.05, colour: rgb(104, 86, 66), reflectance: 0.26 });
  piles.push({ ax: 60, az: 22, bx: 80, bz: 27, radius: 4.5, height: 1.8, base: plotLevel - 0.05, colour: rgb(118, 96, 72), reflectance: 0.27 });
  box({ x: 79, z: 2, angle: 0.8, halfX: 3, halfZ: 1.6, base: plotLevel, height: 3.1, roofColour: colours.yellow, wallColour: colours.yellow });
  line([79 + 2.1, plotLevel + 3, 2 + 2.1], [79 + 6, plotLevel + 4.5, 2 + 6], 0.3, colours.yellow);
  line([79 + 6, plotLevel + 4.5, 2 + 6], [79 + 7.5, plotLevel + 0.8, 2 + 7.5], 0.3, colours.yellow);
  box({ x: 60, z: 6, angle: -0.4, halfX: 3.2, halfZ: 1.4, base: plotLevel, height: 2.8, roofColour: colours.yellow, wallColour: colours.yellow });

  // Light columns across the car park and the yard.
  for (const [x, z] of [[-80, 38], [-65, 38], [-50, 38], [-35, 22], [-5, 30], [25, 4], [-40, -52], [0, -52]] as const) {
    line([x, level, z], [x, level + 9, z], 0.1, colours.steel);
    line([x, level + 9, z], [x + 1.2, level + 9, z], 0.2, rgb(200, 200, 196));
  }

  // The perimeter fence: posts every three metres and a top rail, open at the gate.
  const fence = { minX: platform.x - platform.halfX - 1.5, maxX: platform.x + platform.halfX + 1.5, minZ: platform.z - platform.halfZ - 1.5, maxZ: platform.z + platform.halfZ + 1.5 };
  const corners: Array<readonly [number, number]> = [[fence.minX, fence.minZ], [fence.maxX, fence.minZ], [fence.maxX, fence.maxZ], [fence.minX, fence.maxZ], [fence.minX, fence.minZ]];
  for (let side = 0; side < 4; side += 1) {
    const [ax, az] = corners[side]!;
    const [bx, bz] = corners[side + 1]!;
    const length = Math.hypot(bx - ax, bz - az);
    let previous: [number, number, number] | undefined;
    for (let d = 0; d <= length; d += 3) {
      const x = ax + ((bx - ax) * d) / length;
      const z = az + ((bz - az) * d) / length;
      if (side === 2 && Math.abs(x + 20) < 6) {
        previous = undefined;
        continue;
      }
      const ground = groundAt(x, z).height;
      line([x, ground, z], [x, ground + 2.4, z], 0.05, colours.fence);
      const top: [number, number, number] = [x, ground + 2.4, z];
      if (previous !== undefined) line(previous, top, 0.04, colours.fence);
      previous = top;
    }
  }

  // The distribution line along the road's north verge, and the drop into the substation.
  const road = paths[0]!;
  const poles: Array<Array<[number, number, number]>> = [];
  for (let d = 12; d < road.along[road.along.length - 1]!; d += 38) {
    let index = 0;
    while (index < road.along.length - 2 && road.along[index + 1]! < d) index += 1;
    const t = (d - road.along[index]!) / (road.along[index + 1]! - road.along[index]!);
    const x = road.xs[index]! + (road.xs[index + 1]! - road.xs[index]!) * t;
    const z = road.zs[index]! + (road.zs[index + 1]! - road.zs[index]!) * t - 6;
    if (Math.abs(x + 20) < 7) continue;
    const ground = groundAt(x, z).height;
    line([x, ground, z], [x, ground + 9.6, z], 0.14, colours.wood);
    line([x, ground + 9.1, z - 1.1], [x, ground + 9.1, z + 1.1], 0.1, colours.wood);
    poles.push([[x, ground + 9.1, z - 1], [x, ground + 9.8, z], [x, ground + 9.1, z + 1]]);
  }
  for (let index = 1; index < poles.length; index += 1) {
    for (let wire = 0; wire < 3; wire += 1) conductor(thins, poles[index - 1]![wire]!, poles[index]![wire]!, 0.7, 0.07, colours.conductor);
  }
  const substation = { x: -80, z: 53 };
  for (const dx of [-3, 3]) box({ x: substation.x + dx, z: substation.z, halfX: 1.4, halfZ: 1.1, height: 2.8, roofColour: colours.steel, wallColour: rgb(96, 112, 100) });
  const nearest = poles.reduce((best, pole) => (Math.hypot(pole[1]![0] - substation.x, pole[1]![2] - substation.z) < Math.hypot(best[1]![0] - substation.x, best[1]![2] - substation.z) ? pole : best), poles[0]!);
  const substationGround = groundAt(substation.x, substation.z).height;
  for (const [wire, dx] of [[0, -3], [2, 3]] as const) conductor(thins, nearest[wire]!, [substation.x + dx, substationGround + 3.4, substation.z], 0.3, 0.05, colours.conductor);
  for (const [dx, dz] of [[-6, -4], [6, -4], [6, 4], [-6, 4]] as const) {
    const ground = groundAt(substation.x + dx, substation.z + dz).height;
    line([substation.x + dx, ground, substation.z + dz], [substation.x + dx, ground + 2.2, substation.z + dz], 0.06, colours.fence);
  }

  // --- vegetation

  // Woodland along the north-east boundary, with an understory.
  for (let z = -halfDepth; z < -30; z += 5.5) {
    for (let x = 44; x < halfWidth; x += 5.5) {
      const tx = x + jitter(random, 5);
      const tz = z + jitter(random, 5);
      if (!woodlandAt(tx, tz) || Math.abs(tx) > halfWidth || Math.abs(tz) > halfDepth || random() < 0.15) continue;
      trees.push(tree(random, tx, tz, 10 + random() * 9, random() < 0.2));
      if (random() < 0.4) trees.push(shrub(random, tx + jitter(random, 4), tz + jitter(random, 4), 1 + random() * 2.5));
    }
  }
  // A tree line along the north boundary and a hedge along the west one.
  for (let x = -halfWidth + 2; x < 44; x += 5 + random() * 3) {
    if (random() < 0.25) continue;
    trees.push(random() < 0.6 ? tree(random, x, -68 + jitter(random, 3), 8 + random() * 8, random() < 0.25) : shrub(random, x, -67 + jitter(random, 2), 2 + random() * 2));
  }
  for (let z = -60; z < 56; z += 3 + random() * 2) {
    if (random() < 0.15) continue;
    trees.push(random() < 0.12 ? tree(random, -92 + jitter(random, 1.5), z, 8 + random() * 5, false) : shrub(random, -92 + jitter(random, 1.5), z, 2.2 + random() * 1.8));
  }
  // Street trees along the road, trees on the office lawn and in the car park, scrub round the pond.
  for (let x = -90; x < 90; x += 16 + random() * 6) {
    if (Math.abs(x + 20) < 10 || Math.abs(x + 80) < 10) continue;
    trees.push(tree(random, x, 67 + jitter(random, 2), 7 + random() * 5, false));
  }
  for (const [x, z] of [[-86, 4], [-86, 16], [-50, 6], [-50, 18], [-58, 22]] as const) trees.push(tree(random, x + jitter(random, 2), z + jitter(random, 2), 6 + random() * 4, false));
  for (let index = 0; index < 7; index += 1) {
    const angle = random() * Math.PI * 2;
    trees.push(shrub(random, pond.x + Math.cos(angle) * pond.rx * 1.15, pond.z + Math.sin(angle) * pond.rz * 1.2, 1.5 + random() * 2.5));
  }
  // Scrub on the platform's embankments.
  for (let index = 0; index < 40; index += 1) {
    const side = Math.floor(random() * 3);
    const t = random() * 2 - 1;
    const x = side === 0 ? platform.x - platform.halfX - 5 : platform.x + t * platform.halfX;
    const z = side === 0 ? platform.z + t * platform.halfZ : side === 1 ? platform.z - platform.halfZ - 5 : platform.z + platform.halfZ + 5;
    if (nearestPath(x, z) !== undefined || woodlandAt(x, z) || x > 44) continue;
    trees.push(shrub(random, x + jitter(random, 2), z + jitter(random, 2), 0.8 + random() * 1.8));
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

/**
 * Where a surveyor would put checkpoints on this site: open, hard or level
 * hard ground that a laser sees clearly - the yard, the road, the lawn and the
 * stripped plot - spread across both flight strips and their overlap. Tall
 * grass lifts returns off the ground, which is why non-vegetated accuracy is
 * checked on surfaces like these.
 */
export const checkpointSites: ReadonlyArray<readonly [name: string, x: number, z: number]> = [
  ["CP01 yard west", -40, 15],
  ["CP02 yard centre", -10, 22],
  ["CP03 yard east", 12, 30],
  ["CP04 north apron", 0, -51],
  ["CP05 car park aisle", -60, 40],
  ["CP06 office lawn", -75, -1],
  ["CP07 road west", -60, 61],
  ["CP08 road east", 40, 62.5],
  ["CP09 road centre", -30, 62],
  ["CP10 road verge east", 20, 64.5],
  ["CP11 plot north", 60, -8],
  ["CP12 plot east", 86, -32],
  ["CP13 plot south", 58, 30],
  ["CP14 plot centre", 78, -6],
];
