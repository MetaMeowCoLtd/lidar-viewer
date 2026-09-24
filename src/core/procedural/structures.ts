import { lowestGround } from "./landscape.js";
import { jitter, mix, rgb, sunShade, type PointWriter, type Random, type Rgb, type Surface, type Vec3 } from "./sampling.js";

/** How densely walls are sampled relative to the ground: an airborne laser grazes them. */
const wallDensity = 0.5;

// ---------------------------------------------------------------- buildings

export type RoofKind = "flat" | "gable" | "hip" | "pyramid" | "shed" | "sawtooth" | "dome";

export interface Building {
  readonly cx: number;
  readonly cz: number;
  readonly cos: number;
  readonly sin: number;
  /** Half the footprint along the building's own u axis (its length), or the radius of a round one. */
  readonly hw: number;
  readonly hd: number;
  readonly round: boolean;
  readonly base: number;
  /** Height of the eaves above `base`. */
  readonly height: number;
  readonly roof: RoofKind;
  /** Height of the roof's peak above the eaves. */
  readonly ridge: number;
  /** A low wall around a flat roof's edge. */
  readonly parapet: number;
  readonly wall: Rgb;
  readonly roofColour: Rgb;
  /** 0 for a blank wall, ~0.3 for punched windows, 0.7 and above for a curtain wall. */
  readonly glass: number;
  readonly glassColour: Rgb;
  readonly roofPaint: ((u: number, v: number) => Rgb) | undefined;
  /** Upper tiers standing on this roof; the roof is not sampled underneath them. */
  readonly holes: Building[];
}

export interface BuildingSpec {
  x: number;
  z: number;
  angle?: number;
  halfWidth: number;
  halfDepth?: number;
  round?: boolean;
  base?: number;
  height: number;
  roof?: RoofKind;
  ridge?: number;
  parapet?: number;
  wall: Rgb;
  roofColour: Rgb;
  glass?: number;
  glassColour?: Rgb;
  roofPaint?: (u: number, v: number) => Rgb;
}

export function makeBuilding(spec: BuildingSpec): Building {
  const angle = spec.angle ?? 0;
  const hd = spec.halfDepth ?? spec.halfWidth;
  return {
    cx: spec.x,
    cz: spec.z,
    cos: Math.cos(angle),
    sin: Math.sin(angle),
    hw: spec.halfWidth,
    hd,
    round: spec.round ?? false,
    base: spec.base ?? lowestGround(spec.x, spec.z, Math.max(spec.halfWidth, hd)) - 0.15,
    height: spec.height,
    roof: spec.roof ?? "flat",
    ridge: spec.ridge ?? 0,
    parapet: spec.parapet ?? 0,
    wall: spec.wall,
    roofColour: spec.roofColour,
    glass: spec.glass ?? 0,
    glassColour: spec.glassColour ?? rgb(54, 70, 88),
    roofPaint: spec.roofPaint,
    holes: [],
  };
}

/** Puts `upper` on top of `lower`, and returns it. */
export function stack(lower: Building, upper: Omit<BuildingSpec, "base">): Building {
  const building = makeBuilding({ ...upper, base: lower.base + lower.height });
  lower.holes.push(building);
  return building;
}

export function top(building: Building): number {
  return building.base + building.height;
}

export function insideFootprint(b: Building, x: number, z: number, margin: number): boolean {
  const dx = x - b.cx;
  const dz = z - b.cz;
  const u = dx * b.cos + dz * b.sin;
  const v = -dx * b.sin + dz * b.cos;
  if (b.round) return u * u + v * v < (b.hw + margin) * (b.hw + margin);
  return Math.abs(u) < b.hw + margin && Math.abs(v) < b.hd + margin;
}

function roofRise(b: Building, u: number, v: number): number {
  switch (b.roof) {
    case "flat":
      return 0;
    case "gable":
      return b.ridge * (1 - Math.abs(v) / b.hd);
    case "hip":
      return Math.max(0, Math.min(b.ridge * (1 - Math.abs(v) / b.hd), (b.ridge * (b.hw - Math.abs(u))) / b.hd));
    case "pyramid":
      return b.ridge * Math.max(0, 1 - Math.max(Math.abs(u) / b.hw, Math.abs(v) / b.hd));
    case "shed":
      return (b.ridge * (v + b.hd)) / (2 * b.hd);
    case "sawtooth":
      return b.ridge * (((((u + b.hw) / 6) % 1) + 1) % 1);
    case "dome":
      return b.ridge * Math.sqrt(Math.max(0, 1 - (u * u + v * v) / (b.hw * b.hw)));
  }
}

function nearEdge(b: Building, u: number, v: number): boolean {
  if (b.round) return b.hw - Math.hypot(u, v) < 0.4;
  return Math.min(b.hw - Math.abs(u), b.hd - Math.abs(v)) < 0.4;
}

function isWindow(along: number, height: number, glass: number): boolean {
  if (glass <= 0) return false;
  if (glass >= 0.7) return ((along % 1.5) + 1.5) % 1.5 > 0.1 && ((height % 3.6) + 3.6) % 3.6 > 0.35;
  const storey = ((height % 3.2) + 3.2) % 3.2;
  const bay = ((along % 2.6) + 2.6) % 2.6;
  return height > 0.9 && storey > 0.8 && storey < 2.5 && bay > 0.5 && bay < 0.5 + 2.6 * glass * 2.2;
}

function emitRoof(b: Building, random: Random, out: PointWriter): void {
  let u = 0;
  let v = 0;
  let x = b.cx;
  let z = b.cz;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    u = jitter(random, b.hw * 2);
    v = jitter(random, b.hd * 2);
    if (b.round && u * u + v * v > b.hw * b.hw) continue;
    x = b.cx + u * b.cos - v * b.sin;
    z = b.cz + u * b.sin + v * b.cos;
    if (!b.holes.some((hole) => insideFootprint(hole, x, z, 0))) break;
  }
  const rise = roofRise(b, u, v);
  const rim = b.roof === "flat" && b.parapet > 0 && nearEdge(b, u, v) ? b.parapet : 0;
  // The roof's slope, turned into the world, decides how the sun catches it.
  const step = 0.2;
  const slopeU = (roofRise(b, u + step, v) - roofRise(b, u - step, v)) / (2 * step);
  const slopeV = (roofRise(b, u, v + step) - roofRise(b, u, v - step)) / (2 * step);
  const slopeX = slopeU * b.cos - slopeV * b.sin;
  const slopeZ = slopeU * b.sin + slopeV * b.cos;
  const colour = b.roofPaint === undefined ? b.roofColour : b.roofPaint(u, v);
  out.put(x, b.base + b.height + rise + rim + jitter(random, 0.04), z, colour, sunShade(-slopeX, 1, -slopeZ), random, 12);
}

function emitWall(b: Building, random: Random, out: PointWriter): void {
  let u: number;
  let v: number;
  let along: number;
  let nu: number;
  let nv: number;
  if (b.round) {
    const angle = random() * Math.PI * 2;
    nu = Math.cos(angle);
    nv = Math.sin(angle);
    u = nu * b.hw;
    v = nv * b.hw;
    along = angle * b.hw;
  } else {
    let t = random() * 4 * (b.hw + b.hd);
    if (t < 2 * b.hw) {
      u = t - b.hw;
      v = -b.hd;
      nu = 0;
      nv = -1;
      along = t;
    } else if ((t -= 2 * b.hw) < 2 * b.hd) {
      u = b.hw;
      v = t - b.hd;
      nu = 1;
      nv = 0;
      along = t;
    } else if ((t -= 2 * b.hd) < 2 * b.hw) {
      u = b.hw - t;
      v = b.hd;
      nu = 0;
      nv = 1;
      along = t;
    } else {
      t -= 2 * b.hw;
      u = -b.hw;
      v = b.hd - t;
      nu = -1;
      nv = 0;
      along = t;
    }
  }
  const wallTop = b.height + Math.max(0, roofRise(b, u * 0.999, v * 0.999)) + (b.roof === "flat" ? b.parapet : 0);
  const height = random() * wallTop;
  const x = b.cx + u * b.cos - v * b.sin;
  const z = b.cz + u * b.sin + v * b.cos;
  const shade = sunShade(nu * b.cos - nv * b.sin, 0.15, nu * b.sin + nv * b.cos);

  let colour = b.wall;
  if (height < b.height && isWindow(along, height, b.glass)) {
    // Glass reflects more sky the higher it is.
    colour = b.glass >= 0.7 ? mix(b.glassColour, rgb(150, 186, 212), Math.min(1, height / (b.height * 1.2))) : b.glassColour;
  } else if (height < 0.6) {
    colour = mix(b.wall, rgb(60, 58, 54), 0.35);
  }
  out.put(x, b.base + height, z, colour, shade, random, 10);
}

export function buildingSurfaces(b: Building): Surface[] {
  const footprint = b.round ? Math.PI * b.hw * b.hw : 4 * b.hw * b.hd;
  const perimeter = b.round ? 2 * Math.PI * b.hw : 4 * (b.hw + b.hd);
  return [
    { weight: footprint * (1 + b.ridge / (b.hd * 4)), emit: (random, out) => emitRoof(b, random, out) },
    { weight: perimeter * (b.height + b.ridge * 0.3 + b.parapet) * wallDensity, emit: (random, out) => emitWall(b, random, out) },
  ];
}

/** A grid index of footprints, so asking "is this spot built on?" does not test every building. */
export class FootprintIndex {
  private readonly cells = new Map<number, Building[]>();
  private static readonly cellSize = 10;
  private static readonly padding = 5;

  public add(building: Building): void {
    const radius = (building.round ? building.hw : Math.hypot(building.hw, building.hd)) + FootprintIndex.padding;
    const size = FootprintIndex.cellSize;
    for (let ix = Math.floor((building.cx - radius) / size); ix <= Math.floor((building.cx + radius) / size); ix += 1) {
      for (let iz = Math.floor((building.cz - radius) / size); iz <= Math.floor((building.cz + radius) / size); iz += 1) {
        const key = FootprintIndex.key(ix, iz);
        const cell = this.cells.get(key);
        if (cell === undefined) this.cells.set(key, [building]);
        else cell.push(building);
      }
    }
  }

  /** Whether a point lies within `margin` (at most five metres) of any footprint. */
  public covers(x: number, z: number, margin = 0): boolean {
    const cell = this.cells.get(FootprintIndex.key(Math.floor(x / FootprintIndex.cellSize), Math.floor(z / FootprintIndex.cellSize)));
    return cell !== undefined && cell.some((building) => insideFootprint(building, x, z, margin));
  }

  private static key(ix: number, iz: number): number {
    return (ix + 1000) * 4096 + (iz + 1000);
  }
}

// -------------------------------------------------------------------- trees

export interface Tree {
  readonly x: number;
  readonly z: number;
  readonly base: number;
  readonly conifer: boolean;
  /** Bare trunk below the crown. */
  readonly trunk: number;
  readonly radius: number;
  readonly crown: number;
  readonly colour: Rgb;
  readonly lobes: ReadonlyArray<{ readonly dx: number; readonly dy: number; readonly dz: number; readonly scale: number }>;
}

const broadleafGreens = [rgb(64, 112, 44), rgb(78, 128, 50), rgb(54, 98, 42), rgb(98, 136, 56), rgb(70, 118, 60)];
const autumnColours = [rgb(186, 128, 44), rgb(168, 74, 40), rgb(196, 160, 60)];
const coniferGreens = [rgb(36, 74, 50), rgb(44, 86, 54), rgb(30, 64, 46)];
const bark = rgb(92, 72, 54);

export function makeTree(random: Random, x: number, z: number, base: number, conifer: boolean, scale = 1): Tree {
  if (conifer) {
    const crown = (11 + random() * 8) * scale;
    return { x, z, base, conifer, trunk: crown * 0.18, radius: crown * (0.22 + random() * 0.06), crown, colour: coniferGreens[Math.floor(random() * coniferGreens.length)]!, lobes: [] };
  }
  const radius = (2.6 + random() * 2.2) * scale;
  const lobes = [{ dx: 0, dy: 0, dz: 0, scale: 1 }];
  for (let index = 0; index < 3; index += 1) {
    const angle = random() * Math.PI * 2;
    lobes.push({ dx: Math.cos(angle) * radius * 0.5, dy: jitter(random, radius * 0.5), dz: Math.sin(angle) * radius * 0.5, scale: 0.55 + random() * 0.2 });
  }
  const autumn = random() < 0.08;
  return {
    x,
    z,
    base,
    conifer,
    trunk: (2 + random() * 2) * scale,
    radius,
    crown: radius * (1.5 + random() * 0.4),
    colour: autumn ? autumnColours[Math.floor(random() * autumnColours.length)]! : broadleafGreens[Math.floor(random() * broadleafGreens.length)]!,
    lobes,
  };
}

function emitBroadleaf(tree: Tree, random: Random, out: PointWriter): void {
  if (random() < 0.05) {
    const angle = random() * Math.PI * 2;
    out.put(tree.x + Math.cos(angle) * 0.25, tree.base + random() * (tree.trunk + tree.crown * 0.3), tree.z + Math.sin(angle) * 0.25, bark, 0.8, random, 12);
    return;
  }
  const lobe = tree.lobes[Math.floor(random() * tree.lobes.length)]!;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let length = 0;
  do {
    dx = random() * 2 - 1;
    dy = random() * 2 - 1;
    dz = random() * 2 - 1;
    length = Math.hypot(dx, dy, dz);
  } while (length > 1 || length < 0.05);
  dx /= length;
  dy /= length;
  dz /= length;
  // A laser from above mostly finds the top of the canopy, and some leaves inside it.
  if (dy < 0 && random() < 0.6) dy = -dy;
  const depth = random() < 0.15 ? random() : 1 - random() * random() * 0.3;
  const radius = tree.radius * lobe.scale * depth;
  const lit = 0.55 + 0.35 * (dy * 0.5 + 0.5) * depth + 0.25 * Math.max(0, -dx * 0.6 - dz * 0.5);
  out.put(
    tree.x + lobe.dx + dx * radius,
    tree.base + tree.trunk + tree.crown * 0.5 + lobe.dy + dy * (tree.crown / 2) * lobe.scale * depth,
    tree.z + lobe.dz + dz * radius,
    tree.colour,
    lit,
    random,
    22,
  );
}

function emitConifer(tree: Tree, random: Random, out: PointWriter): void {
  if (random() < 0.04) {
    out.put(tree.x + jitter(random, 0.3), tree.base + random() * tree.trunk, tree.z + jitter(random, 0.3), bark, 0.7, random, 12);
    return;
  }
  // Most of a cone's surface is near its base; tiers of drooping branches ripple its outline.
  const t = 1 - Math.sqrt(random());
  const radius = tree.radius * (1 - t) * (0.72 + 0.28 * ((t * 7) % 1)) * (0.8 + 0.2 * random());
  const angle = random() * Math.PI * 2;
  const lit = 0.6 + 0.45 * t + 0.2 * Math.max(0, -Math.cos(angle) * 0.6 - Math.sin(angle) * 0.5);
  out.put(tree.x + Math.cos(angle) * radius, tree.base + tree.trunk + t * tree.crown, tree.z + Math.sin(angle) * radius, tree.colour, lit, random, 18);
}

export function treeSurface(tree: Tree): Surface {
  const area = Math.PI * tree.radius * tree.radius;
  return tree.conifer
    ? { weight: area * 1.8, emit: (random, out) => emitConifer(tree, random, out) }
    : { weight: area * 1.4, emit: (random, out) => emitBroadleaf(tree, random, out) };
}

// ------------------------------------------------------ lines and cables

/** A thin thing - a cable, a pole, a steel member - sampled along its length. */
export function curveSurface(length: number, density: number, radius: number, colour: Rgb, at: (t: number) => Vec3): Surface {
  return {
    weight: length * density,
    emit(random, out) {
      const [x, y, z] = at(random());
      out.put(x + jitter(random, radius), y + jitter(random, radius), z + jitter(random, radius), colour, 0.85 + random() * 0.2, random, 10);
    },
  };
}

export function lineSurface(a: Vec3, b: Vec3, radius: number, colour: Rgb, density = 1.2): Surface {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return curveSurface(length, density, radius, colour, (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/** A cable hanging between two points, sagging in the middle. */
export function wireSurface(a: Vec3, b: Vec3, sag: number, colour: Rgb): Surface {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return curveSurface(length, 0.9, 0.04, colour, (t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t),
    a[2] + (b[2] - a[2]) * t,
  ]);
}
