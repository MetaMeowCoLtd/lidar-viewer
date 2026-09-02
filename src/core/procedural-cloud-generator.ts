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
  readonly height: number;
  readonly wall: Rgb;
  readonly glassFraction: number;
}

interface Tree {
  readonly x: number;
  readonly z: number;
  readonly trunkHeight: number;
  readonly trunkRadius: number;
  readonly canopyRadius: number;
  readonly canopy: Rgb;
}

/**
 * Generates a small, deterministic city-block scene - road, sidewalks,
 * grass, a handful of textured buildings, street trees and lamp posts -
 * each with material-accurate RGB so the default dataset exercises full
 * color rendering instead of a synthetic height gradient.
 */
export class ProceduralCloudGenerator {
  public generate(options: ProceduralCloudOptions = {}): PointCloud {
    const pointCount = options.pointCount ?? 500_000;
    const width = options.width ?? 80;
    const depth = options.depth ?? 80;
    if (!Number.isSafeInteger(pointCount) || pointCount < 1) throw new Error("pointCount must be a positive integer");
    if (width <= 0 || depth <= 0) throw new Error("width and depth must be positive");

    const random = mulberry32(options.seed ?? 0x1d4a11);
    const positions = new Float32Array(pointCount * 3);
    const colors = new Uint8Array(pointCount * 3);

    const halfWidth = width / 2;
    const halfDepth = depth / 2;
    const roadHalfWidth = Math.max(2, width * 0.05);
    const sidewalkWidth = Math.max(1, width * 0.03);
    const lotInnerX = roadHalfWidth + sidewalkWidth;

    const buildings = createBuildings(random, halfWidth, halfDepth, lotInnerX);
    const trees = createTrees(random, halfWidth, halfDepth, lotInnerX, buildings);

    // Point budget across scene elements; ground absorbs the remainder so
    // the total always matches `pointCount` exactly.
    const weighted = [
      { key: "road" as const, weight: 0.06 },
      { key: "sidewalk" as const, weight: 0.05 },
      { key: "buildings" as const, weight: 0.32 },
      { key: "trees" as const, weight: 0.14 },
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
    offset = writeGround(positions, colors, offset, counts["ground"]!, random, halfWidth, halfDepth, roadHalfWidth, sidewalkWidth, buildings);
    offset = writeRoad(positions, colors, offset, counts["road"]!, random, roadHalfWidth, halfDepth);
    offset = writeSidewalk(positions, colors, offset, counts["sidewalk"]!, random, roadHalfWidth, sidewalkWidth, halfDepth);
    offset = writeBuildings(positions, colors, offset, counts["buildings"]!, random, buildings);
    offset = writeTrees(positions, colors, offset, counts["trees"]!, random, trees);
    offset = writeLamps(positions, colors, offset, counts["lamps"]!, random, roadHalfWidth, sidewalkWidth, halfDepth);

    return new PointCloud({ positions, colors, name: options.name ?? "procedural-city-block" });
  }
}

function createBuildings(random: () => number, halfWidth: number, halfDepth: number, lotInnerX: number): Building[] {
  const materials: ReadonlyArray<{ wall: Rgb; glassFraction: number }> = [
    { wall: { r: 150, g: 72, b: 58 }, glassFraction: 0.32 }, // brick red
    { wall: { r: 196, g: 174, b: 138 }, glassFraction: 0.28 }, // sandstone
    { wall: { r: 150, g: 150, b: 148 }, glassFraction: 0.36 }, // concrete
    { wall: { r: 118, g: 138, b: 150 }, glassFraction: 0.78 }, // glass curtain wall
  ];

  const perSide = Math.max(2, Math.round(halfDepth / 12));
  const lotDepth = (halfDepth * 2) / perSide;
  const outerMargin = Math.max(2, (halfWidth - lotInnerX) * 0.12);
  const buildings: Building[] = [];

  for (const side of [-1, 1]) {
    for (let lot = 0; lot < perSide; lot += 1) {
      if (random() < 0.18) continue; // leave the occasional empty lot as a park/gap
      const lotCenterZ = -halfDepth + lotDepth * (lot + 0.5);
      const footprintDepth = lotDepth * (0.5 + random() * 0.32);
      const footprintWidth = (halfWidth - lotInnerX - outerMargin) * (0.55 + random() * 0.35);
      const centerX = side * (lotInnerX + outerMargin + footprintWidth / 2 + random() * 1.5);
      const material = materials[Math.floor(random() * materials.length)]!;
      buildings.push({
        centerX,
        centerZ: lotCenterZ + (random() - 0.5) * lotDepth * 0.15,
        halfWidth: footprintWidth / 2,
        halfDepth: footprintDepth / 2,
        height: 9 + random() * 20,
        wall: material.wall,
        glassFraction: material.glassFraction,
      });
    }
  }
  return buildings;
}

function createTrees(random: () => number, halfWidth: number, halfDepth: number, lotInnerX: number, buildings: Building[]): Tree[] {
  const canopyPalette: Rgb[] = [
    { r: 58, g: 104, b: 46 },
    { r: 70, g: 122, b: 52 },
    { r: 46, g: 88, b: 40 },
    { r: 150, g: 118, b: 40 }, // a few autumn-turned trees for variety
  ];
  const count = Math.max(10, Math.round((halfWidth * halfDepth * 4) / 250));
  const trees: Tree[] = [];
  let attempts = 0;
  while (trees.length < count && attempts < count * 8) {
    attempts += 1;
    const x = (random() - 0.5) * 2 * halfWidth * 0.94;
    const z = (random() - 0.5) * 2 * halfDepth * 0.96;
    if (Math.abs(x) < lotInnerX + 0.6) continue; // keep the road/sidewalk clear
    if (buildings.some((b) => Math.abs(x - b.centerX) < b.halfWidth + 1.2 && Math.abs(z - b.centerZ) < b.halfDepth + 1.2)) continue;
    const autumn = random() < 0.15;
    trees.push({
      x,
      z,
      trunkHeight: 2 + random() * 1.4,
      trunkRadius: 0.14 + random() * 0.1,
      canopyRadius: 1.6 + random() * 1.6,
      canopy: autumn ? canopyPalette[3]! : canopyPalette[Math.floor(random() * 3)]!,
    });
  }
  return trees;
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
  roadHalfWidth: number,
  sidewalkWidth: number,
  buildings: Building[],
): number {
  let offset = startOffset;
  const clearHalfX = roadHalfWidth + sidewalkWidth;
  for (let i = 0; i < count; i += 1) {
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      x = (random() - 0.5) * 2 * halfWidth;
      z = (random() - 0.5) * 2 * halfDepth;
      const onRoadOrSidewalk = Math.abs(x) < clearHalfX;
      const onBuilding = buildings.some((b) => Math.abs(x - b.centerX) < b.halfWidth + 0.3 && Math.abs(z - b.centerZ) < b.halfDepth + 0.3);
      if (!onRoadOrSidewalk && !onBuilding) break;
    }
    const undulation = Math.sin(x * 0.09) * 0.18 + Math.cos(z * 0.07) * 0.15;
    const y = undulation + (random() - 0.5) * 0.08;
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;

    const patch = (Math.sin(x * 0.21 + z * 0.13) + 1) / 2;
    const dirtPatch = random() < 0.04;
    if (dirtPatch) {
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
  return offset;
}

function writeRoad(positions: Float32Array, colors: Uint8Array, startOffset: number, count: number, random: () => number, roadHalfWidth: number, halfDepth: number): number {
  let offset = startOffset;
  const edgeOffset = roadHalfWidth - 0.15;
  for (let i = 0; i < count; i += 1) {
    const x = (random() - 0.5) * 2 * roadHalfWidth;
    const z = (random() - 0.5) * 2 * halfDepth;
    positions[offset] = x;
    positions[offset + 1] = -0.04 + (random() - 0.5) * 0.01;
    positions[offset + 2] = z;

    const centerLine = Math.abs(x) < 0.12 && ((z % 6) + 6) % 6 < 3;
    const edgeLine = Math.abs(Math.abs(x) - edgeOffset) < 0.08;
    if (centerLine) {
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

function writeSidewalk(positions: Float32Array, colors: Uint8Array, startOffset: number, count: number, random: () => number, roadHalfWidth: number, sidewalkWidth: number, halfDepth: number): number {
  let offset = startOffset;
  for (let i = 0; i < count; i += 1) {
    const side = random() < 0.5 ? -1 : 1;
    const x = side * (roadHalfWidth + random() * sidewalkWidth);
    const z = (random() - 0.5) * 2 * halfDepth;
    positions[offset] = x;
    positions[offset + 1] = 0.1 + (random() - 0.5) * 0.02;
    positions[offset + 2] = z;

    const joint = ((z % 3) + 3) % 3 < 0.1;
    const shade = joint ? noiseByte(random, 140, 6) : noiseByte(random, 182, 10);
    colors[offset] = shade;
    colors[offset + 1] = shade;
    colors[offset + 2] = clampByte(shade - 4);
    offset += 3;
  }
  return offset;
}

function writeBuildings(positions: Float32Array, colors: Uint8Array, startOffset: number, count: number, random: () => number, buildings: ReadonlyArray<Building>): number {
  let offset = startOffset;
  if (buildings.length === 0) return offset;
  for (let i = 0; i < count; i += 1) {
    const building = buildings[Math.floor(random() * buildings.length)]!;
    const roofArea = building.halfWidth * 2 * (building.halfDepth * 2);
    const wallAreaX = building.halfDepth * 2 * building.height;
    const wallAreaZ = building.halfWidth * 2 * building.height;
    const totalArea = roofArea + 2 * wallAreaX + 2 * wallAreaZ;
    const pick = random() * totalArea;

    let x: number;
    let y: number;
    let z: number;
    let isGlass = false;
    let localU = 0;
    let localV = 0;

    if (pick < roofArea) {
      x = building.centerX + (random() - 0.5) * 2 * building.halfWidth;
      z = building.centerZ + (random() - 0.5) * 2 * building.halfDepth;
      y = building.height + (random() - 0.5) * 0.05;
    } else {
      const wallPick = pick - roofArea;
      y = random() * building.height;
      if (wallPick < wallAreaX) {
        x = building.centerX - building.halfWidth;
        z = building.centerZ + (random() - 0.5) * 2 * building.halfDepth;
        localU = z - (building.centerZ - building.halfDepth);
      } else if (wallPick < 2 * wallAreaX) {
        x = building.centerX + building.halfWidth;
        z = building.centerZ + (random() - 0.5) * 2 * building.halfDepth;
        localU = z - (building.centerZ - building.halfDepth);
      } else if (wallPick < 2 * wallAreaX + wallAreaZ) {
        z = building.centerZ - building.halfDepth;
        x = building.centerX + (random() - 0.5) * 2 * building.halfWidth;
        localU = x - (building.centerX - building.halfWidth);
      } else {
        z = building.centerZ + building.halfDepth;
        x = building.centerX + (random() - 0.5) * 2 * building.halfWidth;
        localU = x - (building.centerX - building.halfWidth);
      }
      localV = y;
      isGlass = isWindow(localU, localV, building.glassFraction);
    }

    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;

    if (pick < roofArea) {
      colors[offset] = noiseByte(random, 58, 8);
      colors[offset + 1] = noiseByte(random, 58, 8);
      colors[offset + 2] = noiseByte(random, 62, 8);
    } else if (isGlass) {
      const lit = random() < 0.06;
      if (lit) {
        colors[offset] = noiseByte(random, 235, 12);
        colors[offset + 1] = noiseByte(random, 205, 12);
        colors[offset + 2] = noiseByte(random, 130, 12);
      } else {
        colors[offset] = noiseByte(random, 60, 12);
        colors[offset + 1] = noiseByte(random, 82, 12);
        colors[offset + 2] = noiseByte(random, 102, 14);
      }
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

function writeTrees(positions: Float32Array, colors: Uint8Array, startOffset: number, count: number, random: () => number, trees: ReadonlyArray<Tree>): number {
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
      y = random() * tree.trunkHeight;
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
      y = tree.trunkHeight + tree.canopyRadius * 0.7 + uy * tree.canopyRadius * 0.85;
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

function writeLamps(positions: Float32Array, colors: Uint8Array, startOffset: number, count: number, random: () => number, roadHalfWidth: number, sidewalkWidth: number, halfDepth: number): number {
  let offset = startOffset;
  const poleHeight = 5.2;
  const spacing = 8;
  const poleCount = Math.max(2, Math.floor((halfDepth * 2) / spacing));
  for (let i = 0; i < count; i += 1) {
    const side = random() < 0.5 ? -1 : 1;
    const poleIndex = Math.floor(random() * poleCount);
    const x = side * (roadHalfWidth + sidewalkWidth + 0.3);
    const z = -halfDepth + spacing * (poleIndex + 0.5);
    const headFraction = random() < 0.12;

    positions[offset] = x + (headFraction ? (random() - 0.5) * 0.3 : 0);
    positions[offset + 1] = headFraction ? poleHeight + (random() - 0.5) * 0.1 : random() * poleHeight;
    positions[offset + 2] = z + (headFraction ? (random() - 0.5) * 0.3 : 0);

    if (headFraction) {
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
