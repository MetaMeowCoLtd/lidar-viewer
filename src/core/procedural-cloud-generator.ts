import { PointCloud } from "./point-cloud.js";

export interface ProceduralCloudOptions {
  readonly pointCount?: number;
  readonly seed?: number;
  readonly width?: number;
  readonly depth?: number;
  readonly name?: string;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

interface Building {
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly base: number;
  readonly height: number;
  /** Height of the ridge above the eaves; zero for a flat roof. */
  readonly ridge: number;
  readonly wall: Rgb;
  readonly glassFraction: number;
}

interface Tree {
  readonly x: number;
  readonly z: number;
  readonly base: number;
  readonly trunkHeight: number;
  readonly trunkRadius: number;
  readonly canopyRadius: number;
  readonly canopy: Rgb;
}

interface Car {
  readonly x: number;
  readonly z: number;
  readonly base: number;
  readonly alongX: boolean;
  readonly paint: Rgb;
}

/** Where the streets run. Everything else is laid out around them. */
const avenueX = 60;
const streetZ = 48;
const roadHalfWidth = 5;
const sidewalkWidth = 2.4;
const pondCenter = { x: 0, z: 0, radius: 13 };

/**
 * A deterministic neighbourhood to open the app with: rolling ground, a street
 * grid, blocks of houses, mid-rise offices and a pair of towers, a park with a
 * pond, street trees, parked cars and lamp posts - all with material-accurate
 * colour.
 *
 * It is the scene every feature is demonstrated on, so it is built to give
 * each of them something to find: ground that undulates enough for contour
 * lines to mean something, roofs at a dozen different heights, pitched roofs
 * as well as flat ones, trees both in rows and in clumps, cars and lamp posts
 * as decoys that are neither building nor tree, and a pond the laser gets no
 * return from, which is what a hole in a terrain model really looks like.
 */
export class ProceduralCloudGenerator {
  public generate(options: ProceduralCloudOptions = {}): PointCloud {
    const pointCount = options.pointCount ?? 500_000;
    const width = options.width ?? 300;
    const depth = options.depth ?? 230;
    if (!Number.isSafeInteger(pointCount) || pointCount < 1) throw new Error("pointCount must be a positive integer");
    if (width <= 0 || depth <= 0) throw new Error("width and depth must be positive");

    const random = mulberry32(options.seed ?? 0x1d4a11);
    const positions = new Float32Array(pointCount * 3);
    const colors = new Uint8Array(pointCount * 3);

    const halfWidth = width / 2;
    const halfDepth = depth / 2;
    const buildings = createBuildings(random, halfWidth, halfDepth);
    const trees = createTrees(random, halfWidth, halfDepth, buildings);
    const cars = createCars(random, halfDepth, halfWidth);

    // Point budget across scene elements; ground absorbs the remainder so
    // the total always matches `pointCount` exactly.
    const weighted = [
      { key: "roads" as const, weight: 0.09 },
      { key: "sidewalks" as const, weight: 0.05 },
      { key: "buildings" as const, weight: 0.34 },
      { key: "trees" as const, weight: 0.18 },
      { key: "cars" as const, weight: 0.03 },
      { key: "lamps" as const, weight: 0.02 },
    ];
    const counts: Record<string, number> = {};
    let allocated = 0;
    for (const entry of weighted) {
      const count = Math.floor(pointCount * entry.weight);
      counts[entry.key] = count;
      allocated += count;
    }
    counts["ground"] = Math.max(0, pointCount - allocated);

    let offset = 0;
    offset = writeGround(positions, colors, offset, counts["ground"]!, random, halfWidth, halfDepth, buildings);
    offset = writeRoads(positions, colors, offset, counts["roads"]!, random, halfWidth, halfDepth);
    offset = writeSidewalks(positions, colors, offset, counts["sidewalks"]!, random, halfWidth, halfDepth);
    offset = writeBuildings(positions, colors, offset, counts["buildings"]!, random, buildings);
    offset = writeTrees(positions, colors, offset, counts["trees"]!, random, trees);
    offset = writeCars(positions, colors, offset, counts["cars"]!, random, cars);
    offset = writeLamps(positions, colors, offset, counts["lamps"]!, random, halfDepth);

    return new PointCloud({ positions, colors, name: options.name ?? "procedural-city-block" });
  }
}

/** Gentle hills, so the ground is never a plane and contour lines describe something. */
function terrainHeight(x: number, z: number): number {
  return 1.9 * Math.sin(x / 46) + 1.4 * Math.cos(z / 37) + 0.7 * Math.sin((x + z) / 27);
}

function onRoad(x: number, z: number): boolean {
  return Math.abs(Math.abs(x) - avenueX) < roadHalfWidth || Math.abs(Math.abs(z) - streetZ) < roadHalfWidth;
}

function onPavement(x: number, z: number): boolean {
  return Math.abs(Math.abs(x) - avenueX) < roadHalfWidth + sidewalkWidth || Math.abs(Math.abs(z) - streetZ) < roadHalfWidth + sidewalkWidth;
}

function inPond(x: number, z: number): boolean {
  return Math.hypot(x - pondCenter.x, z - pondCenter.z) < pondCenter.radius;
}

function insideBuilding(buildings: ReadonlyArray<Building>, x: number, z: number, margin: number): boolean {
  return buildings.some((b) => Math.abs(x - b.centerX) < b.halfWidth + margin && Math.abs(z - b.centerZ) < b.halfDepth + margin);
}

const materials: ReadonlyArray<{ wall: Rgb; glassFraction: number }> = [
  { wall: { r: 150, g: 72, b: 58 }, glassFraction: 0.32 }, // brick
  { wall: { r: 196, g: 174, b: 138 }, glassFraction: 0.28 }, // sandstone
  { wall: { r: 150, g: 150, b: 148 }, glassFraction: 0.36 }, // concrete
  { wall: { r: 118, g: 138, b: 150 }, glassFraction: 0.78 }, // glass curtain wall
];

/**
 * The blocks the streets cut the neighbourhood into, each built differently:
 * two towers and mid-rise offices in the middle, houses with pitched roofs
 * around them, and the middle block left to the park.
 */
function createBuildings(random: () => number, halfWidth: number, halfDepth: number): Building[] {
  const buildings: Building[] = [];
  const add = (centerX: number, centerZ: number, footprintWidth: number, footprintDepth: number, height: number, ridge: number, material: number) => {
    if (Math.abs(centerX) + footprintWidth / 2 > halfWidth - 3 || Math.abs(centerZ) + footprintDepth / 2 > halfDepth - 3) return;
    buildings.push({
      centerX,
      centerZ,
      halfWidth: footprintWidth / 2,
      halfDepth: footprintDepth / 2,
      base: terrainHeight(centerX, centerZ),
      height,
      ridge,
      wall: materials[material]!.wall,
      glassFraction: materials[material]!.glassFraction,
    });
  };

  // Two towers and their mid-rise neighbours, in the blocks either side of the park.
  add(-30, -78, 26, 22, 44 + random() * 8, 0, 3);
  add(26, -74, 20, 18, 31 + random() * 6, 0, 2);
  add(-32, 76, 30, 20, 17 + random() * 5, 0, 0);
  add(24, 78, 22, 24, 23 + random() * 6, 0, 3);

  // Mid-rise offices lining the avenues.
  for (const side of [-1, 1]) {
    for (let index = 0; index < 3; index += 1) {
      const centerZ = -30 + index * 30 + (random() - 0.5) * 6;
      const footprintWidth = 16 + random() * 8;
      add(side * (avenueX + roadHalfWidth + sidewalkWidth + 3 + footprintWidth / 2), centerZ, footprintWidth, 14 + random() * 8, 11 + random() * 9, 0, Math.floor(random() * 3));
    }
  }

  // Houses with pitched roofs, in rows behind the offices.
  for (const side of [-1, 1]) {
    for (let row = 0; row < 2; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        if (random() < 0.12) continue; // the occasional empty plot
        const centerX = side * (avenueX + 40 + row * 26);
        const centerZ = -66 + index * 44 + (random() - 0.5) * 5;
        const footprintWidth = 9 + random() * 3;
        const footprintDepth = 7 + random() * 3;
        add(centerX + (random() - 0.5) * 3, centerZ, footprintWidth, footprintDepth, 4.5 + random() * 1.5, 2 + random(), Math.floor(random() * 3));
      }
    }
  }

  return buildings;
}

function createTrees(random: () => number, halfWidth: number, halfDepth: number, buildings: ReadonlyArray<Building>): Tree[] {
  const canopyPalette: Rgb[] = [
    { r: 58, g: 104, b: 46 },
    { r: 70, g: 122, b: 52 },
    { r: 46, g: 88, b: 40 },
    { r: 150, g: 118, b: 40 }, // a few autumn-turned trees for variety
  ];
  const trees: Tree[] = [];
  const plant = (x: number, z: number, scale: number) => {
    if (Math.abs(x) > halfWidth - 2 || Math.abs(z) > halfDepth - 2) return;
    if (inPond(x, z) || onPavement(x, z) || insideBuilding(buildings, x, z, 2)) return;
    const autumn = random() < 0.15;
    trees.push({
      x,
      z,
      base: terrainHeight(x, z),
      trunkHeight: (2.2 + random() * 1.6) * scale,
      trunkRadius: (0.16 + random() * 0.12) * scale,
      canopyRadius: (2.2 + random() * 1.8) * scale,
      canopy: autumn ? canopyPalette[3]! : canopyPalette[Math.floor(random() * 3)]!,
    });
  };

  // Street trees, evenly spaced along both avenues.
  for (const side of [-1, 1]) {
    for (let z = -halfDepth + 14; z < halfDepth - 14; z += 16) {
      plant(side * (avenueX + roadHalfWidth + sidewalkWidth * 0.6), z + (random() - 0.5) * 2, 0.9);
    }
  }

  // The park: a loose clump around the pond, denser at its edges.
  for (let index = 0; index < 90; index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = pondCenter.radius + 2 + random() * 26;
    plant(pondCenter.x + Math.cos(angle) * distance, pondCenter.z + Math.sin(angle) * distance * 0.8, 0.9 + random() * 0.5);
  }

  // Garden trees scattered through the housing.
  for (let index = 0; index < 60; index += 1) {
    plant((random() - 0.5) * 2 * (halfWidth - 6), (random() - 0.5) * 2 * (halfDepth - 6), 0.8 + random() * 0.4);
  }

  return trees;
}

function createCars(random: () => number, halfDepth: number, halfWidth: number): Car[] {
  const paints: Rgb[] = [
    { r: 178, g: 182, b: 188 },
    { r: 40, g: 44, b: 52 },
    { r: 150, g: 58, b: 52 },
    { r: 48, g: 84, b: 132 },
    { r: 206, g: 202, b: 190 },
  ];
  const cars: Car[] = [];
  for (const side of [-1, 1]) {
    for (let z = -halfDepth + 20; z < halfDepth - 20; z += 13 + random() * 10) {
      const x = side * (avenueX - roadHalfWidth + 1.6);
      cars.push({ x, z, base: terrainHeight(x, z), alongX: false, paint: paints[Math.floor(random() * paints.length)]! });
    }
    for (let x = -halfWidth + 30; x < halfWidth - 30; x += 22 + random() * 14) {
      const z = side * (streetZ - roadHalfWidth + 1.6);
      cars.push({ x, z, base: terrainHeight(x, z), alongX: true, paint: paints[Math.floor(random() * paints.length)]! });
    }
  }
  return cars;
}

function noiseByte(random: () => number, base: number, spread: number): number {
  return clampByte(base + (random() - 0.5) * spread);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function writeGround(
  positions: Float32Array,
  colors: Uint8Array,
  startOffset: number,
  count: number,
  random: () => number,
  halfWidth: number,
  halfDepth: number,
  buildings: ReadonlyArray<Building>,
): number {
  let offset = startOffset;
  for (let i = 0; i < count; i += 1) {
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      x = (random() - 0.5) * 2 * halfWidth;
      z = (random() - 0.5) * 2 * halfDepth;
      // Water returns nothing to an airborne scanner, so the pond stays a hole.
      if (!onPavement(x, z) && !inPond(x, z) && !insideBuilding(buildings, x, z, 0.4)) break;
    }
    if (inPond(x, z)) continue;
    const y = terrainHeight(x, z) + (random() - 0.5) * 0.08;
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;

    const patch = (Math.sin(x * 0.21 + z * 0.13) + 1) / 2;
    if (random() < 0.04) {
      colors[offset] = noiseByte(random, 118, 20);
      colors[offset + 1] = noiseByte(random, 92, 16);
      colors[offset + 2] = noiseByte(random, 62, 14);
    } else {
      colors[offset] = noiseByte(random, 58 + patch * 26, 14);
      colors[offset + 1] = noiseByte(random, 104 + patch * 40, 18);
      colors[offset + 2] = noiseByte(random, 46 + patch * 20, 12);
    }
    offset += 3;
  }
  // Points skipped over the pond leave the tail of the buffer at the origin;
  // fill it with ground so every point in the cloud is a real sample.
  while (offset < startOffset + count * 3) {
    const x = (random() - 0.5) * 2 * halfWidth;
    const z = (random() - 0.5) * 2 * halfDepth;
    if (inPond(x, z) || insideBuilding(buildings, x, z, 0.4)) continue;
    positions[offset] = x;
    positions[offset + 1] = terrainHeight(x, z) + (random() - 0.5) * 0.08;
    positions[offset + 2] = z;
    colors[offset] = noiseByte(random, 70, 14);
    colors[offset + 1] = noiseByte(random, 118, 18);
    colors[offset + 2] = noiseByte(random, 54, 12);
    offset += 3;
  }
  return offset;
}

function writeRoads(
  positions: Float32Array,
  colors: Uint8Array,
  startOffset: number,
  count: number,
  random: () => number,
  halfWidth: number,
  halfDepth: number,
): number {
  let offset = startOffset;
  for (let i = 0; i < count; i += 1) {
    const alongZ = random() < 0.6;
    let x: number;
    let z: number;
    let acrossOffset: number;
    if (alongZ) {
      const side = random() < 0.5 ? -1 : 1;
      acrossOffset = (random() - 0.5) * 2 * roadHalfWidth;
      x = side * avenueX + acrossOffset;
      z = (random() - 0.5) * 2 * halfDepth;
    } else {
      const side = random() < 0.5 ? -1 : 1;
      acrossOffset = (random() - 0.5) * 2 * roadHalfWidth;
      z = side * streetZ + acrossOffset;
      x = (random() - 0.5) * 2 * halfWidth;
    }
    positions[offset] = x;
    positions[offset + 1] = terrainHeight(x, z) - 0.05 + (random() - 0.5) * 0.01;
    positions[offset + 2] = z;

    const along = alongZ ? z : x;
    const centreLine = Math.abs(acrossOffset) < 0.12 && ((along % 7) + 7) % 7 < 3.5;
    const edgeLine = Math.abs(Math.abs(acrossOffset) - (roadHalfWidth - 0.2)) < 0.08;
    if (centreLine) {
      colors[offset] = noiseByte(random, 220, 10);
      colors[offset + 1] = noiseByte(random, 196, 10);
      colors[offset + 2] = noiseByte(random, 58, 10);
    } else if (edgeLine) {
      colors[offset] = noiseByte(random, 228, 8);
      colors[offset + 1] = noiseByte(random, 228, 8);
      colors[offset + 2] = noiseByte(random, 222, 8);
    } else {
      const shade = noiseByte(random, 40, 10);
      colors[offset] = shade;
      colors[offset + 1] = shade;
      colors[offset + 2] = clampByte(shade + 2);
    }
    offset += 3;
  }
  return offset;
}

function writeSidewalks(
  positions: Float32Array,
  colors: Uint8Array,
  startOffset: number,
  count: number,
  random: () => number,
  halfWidth: number,
  halfDepth: number,
): number {
  let offset = startOffset;
  for (let i = 0; i < count; i += 1) {
    const alongZ = random() < 0.6;
    const side = random() < 0.5 ? -1 : 1;
    const across = (roadHalfWidth + random() * sidewalkWidth) * (random() < 0.5 ? -1 : 1);
    const x = alongZ ? side * avenueX + across : (random() - 0.5) * 2 * halfWidth;
    const z = alongZ ? (random() - 0.5) * 2 * halfDepth : side * streetZ + across;
    positions[offset] = x;
    positions[offset + 1] = terrainHeight(x, z) + 0.12 + (random() - 0.5) * 0.02;
    positions[offset + 2] = z;

    const joint = (((alongZ ? z : x) % 3) + 3) % 3 < 0.1;
    const shade = joint ? noiseByte(random, 140, 6) : noiseByte(random, 182, 10);
    colors[offset] = shade;
    colors[offset + 1] = shade;
    colors[offset + 2] = clampByte(shade - 4);
    offset += 3;
  }
  return offset;
}

function writeBuildings(
  positions: Float32Array,
  colors: Uint8Array,
  startOffset: number,
  count: number,
  random: () => number,
  buildings: ReadonlyArray<Building>,
): number {
  let offset = startOffset;
  if (buildings.length === 0) return offset;
  // Weighted by surface area, so a tower does not end up as sparse as a shed.
  const areas = buildings.map((b) => b.halfWidth * b.halfDepth * 4 + (b.halfWidth + b.halfDepth) * 2 * b.height);
  const totalArea = areas.reduce((sum, area) => sum + area, 0);

  for (let i = 0; i < count; i += 1) {
    let choice = random() * totalArea;
    let index = 0;
    while (index < buildings.length - 1 && choice > areas[index]!) {
      choice -= areas[index]!;
      index += 1;
    }
    const building = buildings[index]!;
    const roofArea = building.halfWidth * 2 * (building.halfDepth * 2);
    const wallAreaX = building.halfDepth * 2 * building.height;
    const wallAreaZ = building.halfWidth * 2 * building.height;
    const pick = random() * (roofArea + 2 * wallAreaX + 2 * wallAreaZ);

    let x: number;
    let y: number;
    let z: number;
    let isGlass = false;
    const eaves = building.base + building.height;

    if (pick < roofArea) {
      const acrossX = (random() - 0.5) * 2 * building.halfWidth;
      x = building.centerX + acrossX;
      z = building.centerZ + (random() - 0.5) * 2 * building.halfDepth;
      // A pitched roof rises from both long edges to a ridge down the middle.
      const pitch = building.ridge === 0 ? 0 : building.ridge * (1 - Math.abs(acrossX) / building.halfWidth);
      y = eaves + pitch + (random() - 0.5) * 0.05;
    } else {
      const wallPick = pick - roofArea;
      y = building.base + random() * building.height;
      if (wallPick < wallAreaX) {
        x = building.centerX - building.halfWidth;
        z = building.centerZ + (random() - 0.5) * 2 * building.halfDepth;
        isGlass = isWindow(z - (building.centerZ - building.halfDepth), y - building.base, building.glassFraction);
      } else if (wallPick < 2 * wallAreaX) {
        x = building.centerX + building.halfWidth;
        z = building.centerZ + (random() - 0.5) * 2 * building.halfDepth;
        isGlass = isWindow(z - (building.centerZ - building.halfDepth), y - building.base, building.glassFraction);
      } else if (wallPick < 2 * wallAreaX + wallAreaZ) {
        z = building.centerZ - building.halfDepth;
        x = building.centerX + (random() - 0.5) * 2 * building.halfWidth;
        isGlass = isWindow(x - (building.centerX - building.halfWidth), y - building.base, building.glassFraction);
      } else {
        z = building.centerZ + building.halfDepth;
        x = building.centerX + (random() - 0.5) * 2 * building.halfWidth;
        isGlass = isWindow(x - (building.centerX - building.halfWidth), y - building.base, building.glassFraction);
      }
    }

    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;

    if (pick < roofArea) {
      // Tiles on a pitched roof, grey membrane and plant on a flat one.
      if (building.ridge > 0) {
        colors[offset] = noiseByte(random, 132, 16);
        colors[offset + 1] = noiseByte(random, 74, 12);
        colors[offset + 2] = noiseByte(random, 58, 10);
      } else {
        colors[offset] = noiseByte(random, 58, 8);
        colors[offset + 1] = noiseByte(random, 58, 8);
        colors[offset + 2] = noiseByte(random, 62, 8);
      }
    } else if (isGlass) {
      const lit = random() < 0.06;
      colors[offset] = noiseByte(random, lit ? 235 : 60, 12);
      colors[offset + 1] = noiseByte(random, lit ? 205 : 82, 12);
      colors[offset + 2] = noiseByte(random, lit ? 130 : 102, 14);
    } else {
      colors[offset] = noiseByte(random, building.wall.r, 12);
      colors[offset + 1] = noiseByte(random, building.wall.g, 12);
      colors[offset + 2] = noiseByte(random, building.wall.b, 12);
    }
    offset += 3;
  }
  return offset;
}

function isWindow(u: number, v: number, glassFraction: number): boolean {
  if (glassFraction >= 0.7) {
    // Full curtain-wall glass towers: mullions only, mostly glass.
    return ((u % 1.4) + 1.4) % 1.4 > 0.08;
  }
  const floorHeight = 3;
  const floorLocalV = ((v % floorHeight) + floorHeight) % floorHeight;
  const inBand = floorLocalV > floorHeight * 0.22 && floorLocalV < floorHeight * 0.78;
  const pitch = 2.4;
  const floorLocalU = ((u % pitch) + pitch) % pitch;
  const inColumn = floorLocalU > pitch * 0.18 && floorLocalU < pitch * 0.82;
  return inBand && inColumn;
}

function writeTrees(
  positions: Float32Array,
  colors: Uint8Array,
  startOffset: number,
  count: number,
  random: () => number,
  trees: ReadonlyArray<Tree>,
): number {
  let offset = startOffset;
  if (trees.length === 0) return offset;
  for (let i = 0; i < count; i += 1) {
    const tree = trees[Math.floor(random() * trees.length)]!;
    const isTrunk = random() < 0.12;
    let x: number;
    let y: number;
    let z: number;

    if (isTrunk) {
      const angle = random() * Math.PI * 2;
      x = tree.x + Math.cos(angle) * tree.trunkRadius;
      z = tree.z + Math.sin(angle) * tree.trunkRadius;
      y = tree.base + random() * tree.trunkHeight;
      colors[offset] = noiseByte(random, 92, 14);
      colors[offset + 1] = noiseByte(random, 68, 12);
      colors[offset + 2] = noiseByte(random, 46, 10);
    } else {
      // Rejection-sample a point inside a flattened ellipsoid canopy.
      let ux = 0;
      let uy = 0;
      let uz = 0;
      do {
        ux = random() * 2 - 1;
        uy = random() * 2 - 1;
        uz = random() * 2 - 1;
      } while (ux * ux + uy * uy + uz * uz > 1);
      x = tree.x + ux * tree.canopyRadius;
      z = tree.z + uz * tree.canopyRadius;
      y = tree.base + tree.trunkHeight + tree.canopyRadius * 0.7 + uy * tree.canopyRadius * 0.85;
      colors[offset] = noiseByte(random, tree.canopy.r, 16);
      colors[offset + 1] = noiseByte(random, tree.canopy.g, 20);
      colors[offset + 2] = noiseByte(random, tree.canopy.b, 14);
    }

    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;
    offset += 3;
  }
  return offset;
}

/** Parked cars: low boxes by the kerb, and the decoys any counting method has to ignore. */
function writeCars(
  positions: Float32Array,
  colors: Uint8Array,
  startOffset: number,
  count: number,
  random: () => number,
  cars: ReadonlyArray<Car>,
): number {
  let offset = startOffset;
  if (cars.length === 0) return offset;
  for (let i = 0; i < count; i += 1) {
    const car = cars[Math.floor(random() * cars.length)]!;
    const alongHalf = 2.2;
    const acrossHalf = 0.9;
    const along = (random() - 0.5) * 2 * alongHalf;
    const across = (random() - 0.5) * 2 * acrossHalf;
    // A roof over the middle, a bonnet at each end.
    const roof = Math.abs(along) < alongHalf * 0.45;
    const height = roof ? 1.45 : 0.95;
    positions[offset] = car.x + (car.alongX ? along : across);
    positions[offset + 1] = car.base + height + (random() - 0.5) * 0.06;
    positions[offset + 2] = car.z + (car.alongX ? across : along);
    colors[offset] = noiseByte(random, car.paint.r, 14);
    colors[offset + 1] = noiseByte(random, car.paint.g, 14);
    colors[offset + 2] = noiseByte(random, car.paint.b, 14);
    offset += 3;
  }
  return offset;
}

function writeLamps(
  positions: Float32Array,
  colors: Uint8Array,
  startOffset: number,
  count: number,
  random: () => number,
  halfDepth: number,
): number {
  let offset = startOffset;
  const poleHeight = 5.4;
  const spacing = 20;
  const poleCount = Math.max(2, Math.floor((halfDepth * 2) / spacing));
  for (let i = 0; i < count; i += 1) {
    const side = random() < 0.5 ? -1 : 1;
    const poleIndex = Math.floor(random() * poleCount);
    const x = side * (avenueX + roadHalfWidth + sidewalkWidth * 0.5);
    const z = -halfDepth + spacing * (poleIndex + 0.5);
    const base = terrainHeight(x, z);
    const head = random() < 0.12;

    positions[offset] = x + (head ? (random() - 0.5) * 0.3 : 0);
    positions[offset + 1] = base + (head ? poleHeight + (random() - 0.5) * 0.1 : random() * poleHeight);
    positions[offset + 2] = z + (head ? (random() - 0.5) * 0.3 : 0);

    if (head) {
      colors[offset] = noiseByte(random, 255, 8);
      colors[offset + 1] = noiseByte(random, 224, 10);
      colors[offset + 2] = noiseByte(random, 150, 12);
    } else {
      const shade = noiseByte(random, 42, 6);
      colors[offset] = shade;
      colors[offset + 1] = shade;
      colors[offset + 2] = clampByte(shade + 2);
    }
    offset += 3;
  }
  return offset;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
