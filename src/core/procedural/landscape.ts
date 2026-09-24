import { jitter, patchiness, rgb, smoothstep, sunShade, type Random, type Rgb, type Surface } from "./sampling.js";

/**
 * The land the town is built on: a river winding down a valley, a flat
 * terrace on its west bank for the town, and a forested hill rising to the
 * east. Everything else - roads, fields, buildings - is laid onto this.
 */

export const sceneHalfWidth = 220;
export const sceneHalfDepth = 170;

export const riverHalfWidth = 9;
/** Where the river bank flattens out into the terrace. */
export const bankOuter = 24;
/** The water surface. Nothing is sampled on it: water returns almost nothing to a laser. */
export const waterLevel = 0.3;

export function riverX(z: number): number {
  return 40 + 30 * Math.sin(z / 65 + 0.5);
}

function riverSlope(z: number): number {
  return (30 / 65) * Math.cos(z / 65 + 0.5);
}

/** Signed distance across the river from its centre line: negative on the town side. */
export function riverDistance(x: number, z: number): number {
  const slope = riverSlope(z);
  return (x - riverX(z)) / Math.sqrt(1 + slope * slope);
}

/** The angle of the river's direction of flow, for lining things up with it. */
export function riverAngle(z: number): number {
  return Math.atan2(1, riverSlope(z));
}

/** The x coordinate `distance` metres across the river from its centre line, at `z`. */
export function acrossRiver(z: number, distance: number): number {
  const slope = riverSlope(z);
  return riverX(z) + distance * Math.sqrt(1 + slope * slope);
}

export function inWater(x: number, z: number): boolean {
  return Math.abs(riverDistance(x, z)) < riverHalfWidth;
}

export function terrainHeight(x: number, z: number): number {
  const across = riverDistance(x, z);
  const west = 4.6 + Math.max(0, -across) * 0.012 + 1.1 * Math.sin(x / 53 + 0.4) * Math.cos(z / 41);
  const east =
    4.2 + smoothstep(12, 150, across) * (20 + 3 * Math.sin(z / 47 + 1.3)) + 1.4 * Math.sin(z / 29 + x / 61) * smoothstep(30, 120, across);
  const land = across < 0 ? west : east;
  const bank = smoothstep(riverHalfWidth, bankOuter, Math.abs(across));
  const micro = 0.14 * Math.sin(x / 9.3 + z / 13.7) + 0.1 * Math.cos(x / 5.1 - z / 7.9);
  return waterLevel + (land - waterLevel + micro) * bank;
}

/** Sunlight on the ground at a point, from the slope of the terrain there. */
export function terrainShade(x: number, z: number, y: number): number {
  const step = 0.8;
  return sunShade(-(terrainHeight(x + step, z) - y) / step, 1, -(terrainHeight(x, z + step) - y) / step);
}

/**
 * The terrain and its sunlight precomputed on a one-metre grid. The ground is
 * most of the points, and interpolating this is several times cheaper than
 * evaluating the terrain three times per point for its height and slope.
 */
class TerrainGrid {
  private readonly cols = sceneHalfWidth * 2 + 2;
  private readonly rows = sceneHalfDepth * 2 + 2;
  private readonly heights = new Float32Array(this.cols * this.rows);
  private readonly shades = new Float32Array(this.cols * this.rows);
  private readonly patches = new Float32Array(this.cols * this.rows);
  private readonly forest = new Uint8Array(this.cols * this.rows);

  public constructor() {
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const x = col - sceneHalfWidth;
        const z = row - sceneHalfDepth;
        const y = terrainHeight(x, z);
        this.heights[row * this.cols + col] = y;
        this.shades[row * this.cols + col] = terrainShade(x, z, y);
        this.patches[row * this.cols + col] = patchiness(x, z);
        this.forest[row * this.cols + col] = forestAt(x, z) ? 1 : 0;
      }
    }
  }

  /** The grid node nearest a point inside the scene. */
  public node(x: number, z: number): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.round(x + sceneHalfWidth)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.round(z + sceneHalfDepth)));
    return row * this.cols + col;
  }

  public isForest(node: number): boolean {
    return this.forest[node] === 1;
  }

  public patch(node: number): number {
    return this.patches[node]!;
  }

  /** Height and shade at a point inside the scene, bilinearly interpolated; `into[0]` is height, `into[1]` shade. */
  public sample(x: number, z: number, into: Float64Array): void {
    const fx = Math.min(this.cols - 1.001, Math.max(0, x + sceneHalfWidth));
    const fz = Math.min(this.rows - 1.001, Math.max(0, z + sceneHalfDepth));
    const col = Math.floor(fx);
    const row = Math.floor(fz);
    const tx = fx - col;
    const tz = fz - row;
    const i = row * this.cols + col;
    const j = i + this.cols;
    into[0] = (this.heights[i]! * (1 - tx) + this.heights[i + 1]! * tx) * (1 - tz) + (this.heights[j]! * (1 - tx) + this.heights[j + 1]! * tx) * tz;
    into[1] = (this.shades[i]! * (1 - tx) + this.shades[i + 1]! * tx) * (1 - tz) + (this.shades[j]! * (1 - tx) + this.shades[j + 1]! * tx) * tz;
  }
}

/** The lowest ground under a footprint, so nothing built on a slope floats. */
export function lowestGround(x: number, z: number, radius: number): number {
  let lowest = terrainHeight(x, z);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    lowest = Math.min(lowest, terrainHeight(x + dx * radius, z + dz * radius));
  }
  return lowest;
}

// ---------------------------------------------------------------- the bridge

export const bridgeZ = 0;
export const bridgeHalfWidth = 7;
export const bridgeWestX = riverX(bridgeZ) - 27;
export const bridgeEastX = riverX(bridgeZ) + 27;

export function underBridge(x: number, z: number): boolean {
  return Math.abs(z - bridgeZ) < bridgeHalfWidth + 0.4 && x > bridgeWestX && x < bridgeEastX;
}

// ------------------------------------------------------------------- roads

export type RoadKind = "town" | "rural" | "track";

interface Segment {
  readonly ax: number;
  readonly az: number;
  readonly dx: number;
  readonly dz: number;
  readonly length: number;
  readonly start: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface Road {
  readonly kind: RoadKind;
  readonly halfWidth: number;
  readonly segments: ReadonlyArray<Segment>;
  /** Distances along the road at which a zebra crossing is painted. */
  readonly crossings: ReadonlyArray<number>;
}

export const sidewalkWidth = 2.6;
const reach = 8;

function makeRoad(kind: RoadKind, halfWidth: number, points: ReadonlyArray<readonly [number, number]>, junctions: ReadonlyArray<readonly [number, number]> = []): Road {
  const segments: Segment[] = [];
  let start = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [ax, az] = points[index - 1]!;
    const [bx, bz] = points[index]!;
    const length = Math.hypot(bx - ax, bz - az);
    segments.push({
      ax,
      az,
      dx: bx - ax,
      dz: bz - az,
      length,
      start,
      minX: Math.min(ax, bx) - halfWidth - reach,
      maxX: Math.max(ax, bx) + halfWidth + reach,
      minZ: Math.min(az, bz) - halfWidth - reach,
      maxZ: Math.max(az, bz) + halfWidth + reach,
    });
    start += length;
  }
  const road = { kind, halfWidth, segments, crossings: [] as number[] };
  for (const [x, z] of junctions) {
    const hit = distanceToRoad(road, x, z);
    if (hit !== undefined && hit.distance < 1) road.crossings.push(hit.along - 11, hit.along + 11);
  }
  return road;
}

export const avenueX = -70;
export const northStreetZ = -85;
export const southRoadZ = 95;

const junctions: ReadonlyArray<readonly [number, number]> = [
  [avenueX, bridgeZ],
  [avenueX, northStreetZ],
];

export const roads: ReadonlyArray<Road> = [
  makeRoad("town", 5, [[-sceneHalfWidth, bridgeZ], [bridgeWestX, bridgeZ]], junctions),
  makeRoad("town", 4.5, [[avenueX, -sceneHalfDepth], [avenueX, southRoadZ]], junctions),
  makeRoad("town", 4, [[-sceneHalfWidth, northStreetZ], [riverX(northStreetZ) - 28, northStreetZ]], junctions),
  makeRoad("rural", 3.5, [[-sceneHalfWidth, southRoadZ], [riverX(southRoadZ) - 27, southRoadZ]]),
  makeRoad("track", 2, [[avenueX, southRoadZ], [avenueX, sceneHalfDepth]]),
  // Switchbacks up the hill to the first wind turbine.
  makeRoad("rural", 3.5, [[bridgeEastX, bridgeZ], [105, -8], [128, -30], [112, -56], [138, -78], [162, -98], [174, -104]]),
  makeRoad("rural", 3.5, [[bridgeEastX, bridgeZ], [128, 12], [172, 24], [sceneHalfWidth, 30]]),
];

export interface RoadHit {
  readonly road: Road;
  /** Distance from the road's centre line. */
  readonly distance: number;
  /** Signed offset across the road. */
  readonly across: number;
  /** Distance along the road from its start. */
  readonly along: number;
}

function distanceToRoad(road: Road, x: number, z: number): RoadHit | undefined {
  let best: RoadHit | undefined;
  for (const segment of road.segments) {
    if (x < segment.minX || x > segment.maxX || z < segment.minZ || z > segment.maxZ) continue;
    const t = Math.max(0, Math.min(1, ((x - segment.ax) * segment.dx + (z - segment.az) * segment.dz) / (segment.length * segment.length)));
    const px = x - (segment.ax + t * segment.dx);
    const pz = z - (segment.az + t * segment.dz);
    const distance = Math.hypot(px, pz);
    if (best === undefined || distance < best.distance) {
      best = { road, distance, across: (segment.dx * pz - segment.dz * px) / segment.length, along: segment.start + t * segment.length };
    }
  }
  return best;
}

/** The road whose edge is nearest a point, if one is within a few metres of it. */
export function nearestRoad(x: number, z: number): RoadHit | undefined {
  let best: RoadHit | undefined;
  for (const road of roads) {
    const hit = distanceToRoad(road, x, z);
    if (hit !== undefined && (best === undefined || hit.distance - road.halfWidth < best.distance - best.road.halfWidth)) best = hit;
  }
  return best;
}

/** How far a point is from the edge of the nearest road; large when there is none nearby. */
export function roadClearance(x: number, z: number): number {
  const hit = nearestRoad(x, z);
  return hit === undefined ? reach : hit.distance - hit.road.halfWidth;
}

// ----------------------------------------------------- landmarks on the land

export const stadium = { x: -140, z: 52, straight: 34, inner: 18, outer: 24.5, apron: 28.5 };
export const carPark = { minX: -55, maxX: -12, minZ: 14, maxZ: 48 };
export const churchPlaza = { minX: -54, maxX: -22, minZ: -160, maxZ: -96 };
export const solarFarm = { minX: -212, maxX: -150, minZ: 104, maxZ: 166 };
export const turbines: ReadonlyArray<{ readonly x: number; readonly z: number }> = [
  { x: 184, z: -112 },
  { x: 198, z: 52 },
];

/** Pylons march across the fields, over the river and up through the forest. */
export const pylonXs: ReadonlyArray<number> = [-205, -130, -55, 20, 95, 170];
export function powerLineZ(x: number): number {
  return 140 - 0.055 * (x + 205);
}

/** Distance from the stadium's rounded rectangle: the radius of a running track. */
export function stadiumRadius(x: number, z: number): number {
  const dx = x - stadium.x;
  return Math.hypot(dx - Math.max(-stadium.straight, Math.min(stadium.straight, dx)), z - stadium.z);
}

function inBox(box: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number): boolean {
  return x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ;
}

export type Zone = "none" | "plaza" | "stadium" | "carPark" | "solar" | "wheat" | "plough" | "crop" | "pad";

export function zoneAt(x: number, z: number, across = riverDistance(x, z)): Zone {
  if (inBox(churchPlaza, x, z)) return "plaza";
  if (inBox(carPark, x, z)) return "carPark";
  if (Math.abs(x - stadium.x) < stadium.straight + stadium.apron && Math.abs(z - stadium.z) < stadium.apron && stadiumRadius(x, z) < stadium.apron) return "stadium";
  if (z > southRoadZ + 6 && across < -bankOuter) {
    if (inBox(solarFarm, x, z)) return "solar";
    if (x > -144 && x < avenueX - 4) return "wheat";
    if (x > avenueX + 4 && x < -8) return z < 137 ? "plough" : "crop";
  }
  for (const turbine of turbines) if (Math.hypot(x - turbine.x, z - turbine.z) < 10) return "pad";
  return "none";
}

/**
 * Where the hillside forest grows: above the east bank, with an irregular
 * edge and a few meadows, cleared around the turbines, along the roads and
 * under the power line - the corridor a utility keeps free of trees.
 */
export function forestAt(x: number, z: number, clearance = roadClearance(x, z), across = riverDistance(x, z)): boolean {
  if (across < 30 + 8 * Math.sin(z / 23)) return false;
  if (patchiness(x * 1.3, z * 1.3) > 0.8) return false;
  if (Math.abs(z - powerLineZ(x)) < 13) return false;
  for (const turbine of turbines) if (Math.hypot(x - turbine.x, z - turbine.z) < 24) return false;
  return clearance > 4;
}

// ------------------------------------------------------------ the ground

const colours = {
  asphalt: rgb(52, 53, 57),
  parking: rgb(62, 63, 66),
  paint: rgb(236, 236, 226),
  paving: rgb(178, 174, 166),
  kerb: rgb(146, 146, 142),
  gravel: rgb(160, 148, 124),
  rut: rgb(118, 102, 80),
  stone: rgb(198, 188, 170),
  track: rgb(176, 78, 56),
  apron: rgb(150, 150, 146),
  pitchLight: rgb(92, 160, 72),
  pitchDark: rgb(72, 138, 58),
  wheat: rgb(204, 176, 96),
  wheatShadow: rgb(176, 146, 76),
  plough: rgb(116, 86, 60),
  furrow: rgb(88, 64, 44),
  crop: rgb(96, 146, 62),
  cropGap: rgb(104, 84, 58),
  meadowDry: rgb(128, 136, 80),
  shore: rgb(152, 142, 118),
  path: rgb(186, 172, 142),
  forestFloor: rgb(68, 74, 44),
  grassA: rgb(84, 128, 54),
  grassB: rgb(116, 144, 66),
} as const;

interface GroundPaint {
  colour: Rgb;
  lift: number;
  spread: number;
}

const paint: GroundPaint = { colour: colours.grassA, lift: 0, spread: 12 };

function set(colour: Rgb, lift = 0, spread = 12): GroundPaint {
  paint.colour = colour;
  paint.lift = lift;
  paint.spread = spread;
  return paint;
}

function roadPaint(hit: RoadHit, random: Random): GroundPaint {
  const { road, across, along } = hit;
  const offset = Math.abs(across);
  if (road.kind === "track") {
    if (offset < 0.35) return set(colours.grassA, 0.02);
    if (Math.abs(offset - 0.85) < 0.3) return set(colours.rut, -0.03);
    return set(colours.gravel, 0, 18);
  }
  if (offset < 0.16 && ((along % 9) + 9) % 9 < 4.5) return set(colours.paint, 0.01, 8);
  if (road.kind === "rural" && offset > road.halfWidth - 0.35 && offset < road.halfWidth - 0.15) return set(colours.paint, 0.01, 8);
  if (road.kind === "town") {
    for (const crossing of road.crossings) {
      if (Math.abs(along - crossing) < 1.8 && ((across + 40) % 1.2) < 0.6) return set(colours.paint, 0.01, 8);
    }
  }
  return set(colours.asphalt, -0.02, 6 + random() * 8);
}

function stadiumPaint(x: number, z: number): GroundPaint {
  const radius = stadiumRadius(x, z);
  if (radius > stadium.outer) return set(colours.apron);
  if (radius > stadium.inner) {
    const lane = (radius - stadium.inner) % 1.22;
    return lane < 0.14 ? set(colours.paint, 0.01, 6) : set(colours.track, 0, 10);
  }
  const u = x - stadium.x;
  const v = z - stadium.z;
  const halfLength = 40;
  const halfWidth = 15;
  if (Math.abs(u) > halfLength || Math.abs(v) > halfWidth) return set(colours.pitchDark);
  const line = 0.3;
  const onLine =
    Math.abs(Math.abs(u) - halfLength) < line ||
    Math.abs(Math.abs(v) - halfWidth) < line ||
    Math.abs(u) < line ||
    Math.abs(Math.hypot(u, v) - 7) < line ||
    (Math.abs(Math.abs(u) - (halfLength - 11)) < line && Math.abs(v) < 8) ||
    (Math.abs(Math.abs(v) - 8) < line && Math.abs(u) > halfLength - 11);
  if (onLine) return set(colours.paint, 0.01, 6);
  return Math.floor((u + halfLength) / 5) % 2 === 0 ? set(colours.pitchLight, 0, 8) : set(colours.pitchDark, 0, 8);
}

function groundPaint(x: number, z: number, across: number, grid: TerrainGrid, random: Random): GroundPaint {
  const hit = nearestRoad(x, z);
  const edge = hit === undefined ? reach : hit.distance - hit.road.halfWidth;
  if (hit !== undefined) {
    if (edge < 0) return roadPaint(hit, random);
    if (hit.road.kind === "town" && edge < sidewalkWidth) {
      if (edge < 0.3) return set(colours.kerb, 0.15);
      const joint = ((hit.along % 2) + 2) % 2 < 0.12;
      return set(joint ? colours.kerb : colours.paving, 0.15, 10);
    }
  }

  switch (zoneAt(x, z, across)) {
    case "plaza": {
      const checker = (Math.floor(x / 1.6) + Math.floor(z / 1.6)) & 1;
      return set(checker === 0 ? colours.stone : colours.paving, 0.1, 10);
    }
    case "carPark": {
      const bayX = (((x - carPark.minX) % 2.6) + 2.6) % 2.6;
      const row = z - carPark.minZ;
      const inBays = (row > 2 && row < 12) || (row > 18 && row < 28);
      if ((inBays && bayX < 0.14) || Math.abs(row - 7) < 0.1 || Math.abs(row - 23) < 0.1) return set(colours.paint, 0, 6);
      return set(colours.parking, -0.02, 8);
    }
    case "stadium":
      return stadiumPaint(x, z);
    case "solar":
      return set(colours.meadowDry, 0, 16);
    case "wheat":
      return ((x * 0.7 + z * 0.7) % 1.6 + 1.6) % 1.6 < 0.8 ? set(colours.wheat, 0.05, 14) : set(colours.wheatShadow, 0, 14);
    case "plough":
      return (z % 1.2 + 1.2) % 1.2 < 0.6 ? set(colours.plough, 0.06, 12) : set(colours.furrow, -0.06, 10);
    case "crop":
      return (x % 1.4 + 1.4) % 1.4 < 0.8 ? set(colours.crop, 0.08, 14) : set(colours.cropGap, 0, 10);
    case "pad":
      return set(colours.gravel, 0, 18);
    case "none":
      break;
  }

  if (Math.abs(across) < 12.5) return set(colours.shore, 0, 22);
  if (Math.abs(across + 17) < 1.1) return set(colours.path, 0, 14);
  const node = grid.node(x, z);
  if (grid.isForest(node)) return set(colours.forestFloor, 0, 16);
  const patch = grid.patch(node);
  const colour = patch < 0.5 ? colours.grassA : colours.grassB;
  return set({ r: colour.r * (0.9 + patch * 0.2), g: colour.g * (0.9 + patch * 0.2), b: colour.b }, 0, 16);
}

/**
 * The bare earth, roads and fields: uniform over the scene except where
 * something hides the ground from above - a building, the bridge deck, or
 * water, which leaves a genuine hole.
 */
export function groundSurface(covered: (x: number, z: number) => boolean): Surface {
  const grid = new TerrainGrid();
  const terrain = new Float64Array(2);
  return {
    weight: sceneHalfWidth * 2 * sceneHalfDepth * 2 * 0.86,
    emit(random, out) {
      let x = 0;
      let z = 0;
      let across = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        x = jitter(random, sceneHalfWidth * 2);
        z = jitter(random, sceneHalfDepth * 2);
        across = riverDistance(x, z);
        if (Math.abs(across) >= riverHalfWidth && !underBridge(x, z) && !covered(x, z)) break;
      }
      grid.sample(x, z, terrain);
      const ground = groundPaint(x, z, across, grid, random);
      out.put(x, terrain[0]! + ground.lift + jitter(random, 0.05), z, ground.colour, terrain[1]!, random, ground.spread);
    },
  };
}
