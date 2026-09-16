import { describe, expect, it } from "vitest";
import {
  PointCloud,
  calculateBounds,
  defaultGroundDetectionOptions,
  detectGround,
  dilate,
  erode,
  fillEmptyCells,
  gridForExtent,
  openSurface,
  PointCloudTiler,
  raiseIsolatedPits,
  upperPercentile,
  VoxelGridDownsampler,
} from "../src/index.js";

describe("square-window morphology", () => {
  const random = seeded(11);
  const cols = 23;
  const rows = 17;
  const grid = Float32Array.from({ length: cols * rows }, () => random() * 100 - 50);

  for (const radius of [1, 2, 3, 5, 8, 12, 30]) {
    it(`matches a direct scan at radius ${radius}, including windows wider than the grid`, () => {
      const eroded = new Float32Array(grid.length);
      const dilated = new Float32Array(grid.length);
      erode(grid, eroded, cols, rows, radius);
      dilate(grid, dilated, cols, rows, radius);
      expect([...eroded]).toEqual([...bruteForce(grid, cols, rows, radius, Math.min)]);
      expect([...dilated]).toEqual([...bruteForce(grid, cols, rows, radius, Math.max)]);
    });
  }
});

describe("opening a terrain surface", () => {
  it("reproduces a tilted plane exactly, right up to every edge", () => {
    const cols = 40;
    const rows = 30;
    for (const [slopeX, slopeZ] of [[0.6, 0], [-0.6, 0], [0, 0.45], [0.3, -0.5]] as const) {
      const plane = Float32Array.from({ length: cols * rows }, (_, cell) => slopeX * (cell % cols) + slopeZ * Math.floor(cell / cols));
      for (const radius of [1, 6, 18]) {
        const opened = new Float32Array(plane.length);
        openSurface(plane, opened, cols, rows, radius);
        for (let cell = 0; cell < plane.length; cell += 1) expect(opened[cell]).toBeCloseTo(plane[cell]!, 3);
      }
    }
  });

  it("removes a bump narrower than the window and never raises a cell", () => {
    const cols = 21;
    const rows = 21;
    const surface = new Float32Array(cols * rows).fill(2);
    for (let row = 9; row <= 11; row += 1) for (let column = 9; column <= 11; column += 1) surface[row * cols + column] = 14;
    const opened = new Float32Array(surface.length);
    openSurface(surface, opened, cols, rows, 2);
    expect([...opened].every((height) => height === 2)).toBe(true);

    const random = seeded(3);
    const rough = Float32Array.from({ length: cols * rows }, () => random() * 10);
    openSurface(rough, opened, cols, rows, 4);
    for (let cell = 0; cell < rough.length; cell += 1) expect(opened[cell]).toBeLessThanOrEqual(rough[cell]!);
  });
});

describe("filling empty cells", () => {
  it("fills holes without touching cells that had data", () => {
    const values = new Float32Array([1, 1, 1, Number.NaN, Number.NaN, 5, 5, Number.NaN, 5]);
    const before = [...values];
    expect(fillEmptyCells(values, 3, 3)).toBe(true);
    for (let cell = 0; cell < values.length; cell += 1) {
      expect(Number.isNaN(values[cell])).toBe(false);
      if (!Number.isNaN(before[cell]!)) expect(values[cell]).toBe(before[cell]);
    }
    // The gap between a low row and a high row lands between the two.
    expect(values[3]).toBeGreaterThan(1);
    expect(values[3]).toBeLessThan(5);
  });

  it("reports failure and changes nothing when there is no data at all", () => {
    const values = new Float32Array(4).fill(Number.NaN);
    expect(fillEmptyCells(values, 2, 2)).toBe(false);
    expect([...values].every(Number.isNaN)).toBe(true);
  });
});

describe("pit removal", () => {
  const flat = (cols: number, rows: number) => new Float32Array(cols * rows).fill(10);

  it("lifts an isolated pit and a pair of pits", () => {
    const values = flat(7, 7);
    values[2 * 7 + 2] = -5;
    values[4 * 7 + 4] = -3;
    values[4 * 7 + 5] = -4;
    expect(raiseIsolatedPits(values, 7, 7, 1)).toBe(3);
    expect([...values].every((height) => height === 10)).toBe(true);
  });

  it("leaves terrain-shaped depressions alone: a ditch, and a square hollow", () => {
    const ditch = flat(9, 9);
    for (let row = 0; row < 9; row += 1) ditch[row * 9 + 4] = 6;
    expect(raiseIsolatedPits(ditch, 9, 9, 1)).toBe(0);

    const hollow = flat(9, 9);
    for (const cell of [30, 31, 39, 40]) hollow[cell] = 6;
    expect(raiseIsolatedPits(hollow, 9, 9, 1)).toBe(0);
  });
});

describe("surface grid sizing", () => {
  it("uses the requested cell size when the grid fits", () => {
    const grid = gridForExtent(0, 0, 99, 49, 1, 10_000);
    expect(grid.cellSize).toBe(1);
    expect([grid.cols, grid.rows]).toEqual([100, 50]);
  });

  it("grows cells for an area too large to grid at full resolution", () => {
    const grid = gridForExtent(0, 0, 4000, 4000, 1, 1_000_000);
    expect(grid.cols * grid.rows).toBeLessThanOrEqual(1_000_000);
    expect(grid.cellSize).toBeGreaterThan(3.9);
    expect(grid.cellSize).toBeLessThan(4.5);
  });
});

describe("ground detection", () => {
  it("separates a building from the flat ground around it", () => {
    const scene = sceneBuilder(7);
    scene.ground(() => 0, 60, 60, 3, (x, z) => Math.abs(x) < 8 && Math.abs(z) < 8);
    scene.building(0, 0, 8, 8, 12, () => 0);
    const input = scene.input();
    const result = detectGround(input);
    const truth = scene.truth();
    expect(errorRates(result.classification, truth).typeOne).toBe(0);
    // The foot of a wall is as close to the ground as the ground is, so no
    // height-based filter can tell them apart. Everything higher must not be
    // mistaken for ground: every roof point, and every wall point above it.
    truth.forEach((label, point) => {
      if (label === "object" && input.positions[point * 3 + 1]! > 1) expect(result.classification[point]).not.toBe(2);
    });
  });

  it("keeps ground along the uphill edge of a sloping scan", () => {
    const scene = sceneBuilder(15);
    scene.ground((x, z) => 0.35 * x + 0.2 * z, 120, 120, 3);
    scene.building(10, -20, 9, 7, 10, (x, z) => 0.35 * x + 0.2 * z);
    const truth = scene.truth();
    const result = detectGround(scene.input());
    expect(errorRates(result.classification, truth).typeOne).toBeLessThan(0.002);
  });

  it("keeps a steep planar slope as ground, because the tolerance widens with slope", () => {
    const scene = sceneBuilder(8);
    scene.ground((x) => 0.6 * x, 80, 80, 3);
    const result = detectGround(scene.input());
    expect(result.stats.groundPoints / result.stats.pointCount).toBeGreaterThan(0.999);
  });

  it("labels low outliers as noise without cratering the ground around them", () => {
    const scene = sceneBuilder(9);
    scene.ground(() => 20, 60, 60, 3);
    for (const [x, z] of [[-15, -10], [4, 7], [18, -19]] as const) scene.noise(x, z, 20 - 9);
    const result = detectGround(scene.input());
    const truth = scene.truth();
    const noiseCodes = truth.flatMap((label, point) => (label === "noise" ? [result.classification[point]] : []));
    expect(noiseCodes).toEqual([7, 7, 7]);
    expect(errorRates(result.classification, truth).typeOne).toBe(0);
    expect(result.stats.pitsRaised).toBeGreaterThanOrEqual(3);
  });

  it("never overwrites a class someone else assigned", () => {
    const scene = sceneBuilder(10);
    scene.ground(() => 0, 40, 40, 2);
    const input = scene.input();
    const classification = new Uint8Array(input.positions.length / 3).fill(1);
    // A handful of ground-level points already labelled as road surface.
    for (const point of [0, 5, 17, 42]) classification[point] = 11;
    const result = detectGround({ ...input, classification });
    for (const point of [0, 5, 17, 42]) expect(result.classification[point]).toBe(11);
    expect(result.stats.preservedPoints).toBe(4);
  });

  it("keeps known noise out of the surface it builds", () => {
    const scene = sceneBuilder(12);
    scene.ground(() => 5, 40, 40, 3);
    // A dense cluster of deep outliers, too wide for pit removal on its own,
    // but already labelled as noise by whoever produced the file.
    for (let index = 0; index < 60; index += 1) scene.noise(-2 + (index % 6), -2 + Math.floor(index / 6) * 0.5, -30);
    const input = scene.input();
    const truth = scene.truth();
    const classification = Uint8Array.from(truth, (label) => (label === "noise" ? 7 : 0));
    const result = detectGround({ ...input, classification });
    expect(errorRates(result.classification, truth).typeOne).toBe(0);
  });

  it("measures height above ground", () => {
    const scene = sceneBuilder(13);
    scene.ground((x) => 0.1 * x + 3, 60, 60, 3);
    scene.point(10, 12, 0.1 * 10 + 3 + 5, "object");
    const result = detectGround(scene.input());
    const last = result.heightAboveGround.length - 1;
    expect(result.heightAboveGround[last]).toBeCloseTo(5, 0);
    expect(result.classification[last]).toBe(1);
  });

  it("rejects options that cannot describe a surface", () => {
    const scene = sceneBuilder(14);
    scene.ground(() => 0, 10, 10, 1);
    expect(() => detectGround(scene.input(), { ...defaultGroundDetectionOptions, cellSize: 0 })).toThrow(/cellSize/);
    expect(() => detectGround(scene.input(), { ...defaultGroundDetectionOptions, slope: -1 })).toThrow(/slope/);
  });

  it("classifies rolling terrain with buildings, trees and noise to within a few percent", () => {
    const scene = suburbanScene();
    const result = detectGround(scene.input());
    const rates = errorRates(result.classification, scene.truth());
    // Recorded so a change in accuracy is visible in the test output, not
    // only when it crosses a bound.
    console.info(
      `synthetic suburb, ${result.stats.pointCount} points: ` +
        `type I ${(rates.typeOne * 100).toFixed(2)}%, type II ${(rates.typeTwo * 100).toFixed(2)}%, ` +
        `total ${(rates.total * 100).toFixed(2)}%, noise found ${(rates.noiseRecall * 100).toFixed(1)}%`,
    );
    expect(rates.typeOne).toBeLessThan(0.02);
    expect(rates.typeTwo).toBeLessThan(0.02);
    expect(rates.total).toBeLessThan(0.02);
    expect(rates.noiseRecall).toBeGreaterThan(0.97);
  });
});

describe("height above ground as a point channel", () => {
  const positions = new Float32Array([0, 0, 0, 0.2, 0.2, 0.2, 0.4, 0.4, 0.4, 9, 9, 9]);
  const heightAboveGround = new Float32Array([1, 2, 3, 40]);

  it("is averaged when a tier is decimated, since it is a measurement rather than a label", () => {
    const decimated = new VoxelGridDownsampler().downsample(new PointCloud({ positions, heightAboveGround }), { voxelSize: 1 });
    expect(decimated.pointCount).toBe(2);
    expect([...decimated.heightAboveGround!]).toEqual([2, 40]);
  });

  it("keeps its values and its precision when split across tiles", () => {
    const tiles = new PointCloudTiler().tile(new PointCloud({ positions, heightAboveGround }), { tileSize: 5 });
    const values = tiles.flatMap((tile) => [...tile.cloud.heightAboveGround!]).sort((a, b) => a - b);
    expect(values).toEqual([1, 2, 3, 40]);
    for (const tile of tiles) expect(tile.cloud.heightAboveGround).toBeInstanceOf(Float32Array);
  });

  it("enables its colour mode only on clouds that carry it", () => {
    expect(new PointCloud({ positions, heightAboveGround }).supportsColorMode("heightAboveGround")).toBe(true);
    expect(new PointCloud({ positions }).supportsColorMode("heightAboveGround")).toBe(false);
    expect(() => new PointCloud({ positions, heightAboveGround: new Float32Array(3) })).toThrow(/heightAboveGround must contain one value per point/);
  });

  it("scales its colour ramp to the bulk of the scan, not its tallest outlier", () => {
    const heights = Float32Array.from({ length: 1000 }, (_, index) => (index < 990 ? index / 99 : 500));
    expect(upperPercentile(heights, 0.98)).toBeLessThan(11);
    expect(upperPercentile(new Float32Array(0), 0.98)).toBe(0);
  });
});

type TruthLabel = "ground" | "object" | "noise";

/**
 * ISPRS-style error rates. Type I is ground rejected as an object, type II is
 * an object accepted as ground, and total counts both over every point.
 * Noise counts as not-ground for the totals, and separately for how much of it
 * was labelled as noise.
 */
function errorRates(classification: Uint8Array, truth: readonly TruthLabel[]) {
  let ground = 0;
  let groundMissed = 0;
  let notGround = 0;
  let acceptedAsGround = 0;
  let noise = 0;
  let noiseFound = 0;
  truth.forEach((label, point) => {
    const code = classification[point]!;
    if (label === "ground") {
      ground += 1;
      if (code !== 2) groundMissed += 1;
      return;
    }
    notGround += 1;
    if (code === 2) acceptedAsGround += 1;
    if (label === "noise") {
      noise += 1;
      if (code === 7) noiseFound += 1;
    }
  });
  return {
    typeOne: ground === 0 ? 0 : groundMissed / ground,
    typeTwo: notGround === 0 ? 0 : acceptedAsGround / notGround,
    total: (groundMissed + acceptedAsGround) / truth.length,
    noiseRecall: noise === 0 ? 1 : noiseFound / noise,
  };
}

/**
 * Builds labelled point sets in viewer axes (y up), at roughly the density of
 * an aerial survey.
 */
function sceneBuilder(seed: number) {
  const random = seeded(seed);
  const positions: number[] = [];
  const labels: TruthLabel[] = [];

  const point = (x: number, z: number, y: number, label: TruthLabel) => {
    positions.push(x, y, z);
    labels.push(label);
  };

  return {
    point,
    ground(height: (x: number, z: number) => number, width: number, depth: number, density: number, exclude?: (x: number, z: number) => boolean) {
      const count = Math.round(width * depth * density);
      for (let index = 0; index < count; index += 1) {
        const x = (random() - 0.5) * width;
        const z = (random() - 0.5) * depth;
        if (exclude?.(x, z)) continue;
        point(x, z, height(x, z) + (random() - 0.5) * 0.06, "ground");
      }
    },
    building(centerX: number, centerZ: number, halfWidth: number, halfDepth: number, height: number, terrain: (x: number, z: number) => number) {
      let base = -Infinity;
      for (let u = -1; u <= 1; u += 0.25) {
        for (let v = -1; v <= 1; v += 0.25) base = Math.max(base, terrain(centerX + u * halfWidth, centerZ + v * halfDepth));
      }
      const roof = base + height;
      const roofPoints = Math.round(halfWidth * halfDepth * 4 * 4);
      for (let index = 0; index < roofPoints; index += 1) {
        point(centerX + (random() - 0.5) * 2 * halfWidth, centerZ + (random() - 0.5) * 2 * halfDepth, roof + (random() - 0.5) * 0.05, "object");
      }
      // Walls are sparse from the air: a scanner looking down sees little of them.
      const perimeter = 4 * (halfWidth + halfDepth);
      const wallPoints = Math.round(perimeter * height * 0.3);
      for (let index = 0; index < wallPoints; index += 1) {
        const along = random() * perimeter;
        let x: number;
        let z: number;
        if (along < 2 * halfWidth) [x, z] = [centerX - halfWidth + along, centerZ - halfDepth];
        else if (along < 2 * halfWidth + 2 * halfDepth) [x, z] = [centerX + halfWidth, centerZ - halfDepth + (along - 2 * halfWidth)];
        else if (along < 4 * halfWidth + 2 * halfDepth) [x, z] = [centerX + halfWidth - (along - 2 * halfWidth - 2 * halfDepth), centerZ + halfDepth];
        else [x, z] = [centerX - halfWidth, centerZ + halfDepth - (along - 4 * halfWidth - 2 * halfDepth)];
        const foot = terrain(x, z);
        point(x, z, foot + random() * (roof - foot), "object");
      }
    },
    tree(x: number, z: number, crownRadius: number, crownBase: number, crownTop: number, terrain: (x: number, z: number) => number) {
      const foot = terrain(x, z);
      const crownPoints = Math.round(Math.PI * crownRadius * crownRadius * 6);
      for (let index = 0; index < crownPoints; index += 1) {
        let u: number;
        let v: number;
        let w: number;
        do {
          u = random() * 2 - 1;
          v = random() * 2 - 1;
          w = random() * 2 - 1;
        } while (u * u + v * v + w * w > 1);
        point(x + u * crownRadius, z + v * crownRadius, foot + crownBase + ((w + 1) / 2) * (crownTop - crownBase), "object");
      }
    },
    noise(x: number, z: number, y: number) {
      point(x, z, y, "noise");
    },
    input() {
      const array = Float32Array.from(positions);
      return { positions: array, bounds: calculateBounds(array) };
    },
    truth(): readonly TruthLabel[] {
      return labels;
    },
    cloud() {
      return new PointCloud({ positions: Float32Array.from(positions) });
    },
  };
}

/**
 * A 240 by 240 metre suburb on rolling terrain with a regional tilt: eighteen
 * buildings, seventy trees and a scattering of deep low outliers, at aerial
 * density. Canopy lets some pulses through, so there is ground under trees but
 * not under roofs.
 */
function suburbanScene() {
  const random = seeded(2024);
  const scene = sceneBuilder(99);
  const terrain = (x: number, z: number) =>
    5 * Math.sin(x / 40) + 4 * Math.cos(z / 33) + 0.08 * x + 1.5 * Math.sin((x + z) / 23);

  const buildings: { x: number; z: number; hw: number; hd: number }[] = [];
  while (buildings.length < 18) {
    const hw = 6 + random() * 11;
    const hd = 6 + random() * 11;
    const x = (random() - 0.5) * (240 - 2 * hw - 20);
    const z = (random() - 0.5) * (240 - 2 * hd - 20);
    if (buildings.some((b) => Math.abs(b.x - x) < b.hw + hw + 8 && Math.abs(b.z - z) < b.hd + hd + 8)) continue;
    buildings.push({ x, z, hw, hd });
  }
  const underRoof = (x: number, z: number) => buildings.some((b) => Math.abs(x - b.x) <= b.hw && Math.abs(z - b.z) <= b.hd);

  scene.ground(terrain, 240, 240, 3, underRoof);
  for (const b of buildings) scene.building(b.x, b.z, b.hw, b.hd, 4 + random() * 18, terrain);

  let trees = 0;
  while (trees < 70) {
    const x = (random() - 0.5) * 220;
    const z = (random() - 0.5) * 220;
    const radius = 2 + random() * 3.5;
    if (buildings.some((b) => Math.abs(x - b.x) < b.hw + radius + 2 && Math.abs(z - b.z) < b.hd + radius + 2)) continue;
    const base = 2 + random() * 3;
    scene.tree(x, z, radius, base, base + 4 + random() * 9, terrain);
    trees += 1;
  }

  for (let index = 0; index < 150; index += 1) {
    const x = (random() - 0.5) * 230;
    const z = (random() - 0.5) * 230;
    if (underRoof(x, z)) continue;
    scene.noise(x, z, terrain(x, z) - 3 - random() * 9);
  }
  return scene;
}

function bruteForce(grid: Float32Array, cols: number, rows: number, radius: number, pick: (...values: number[]) => number): Float32Array {
  const out = new Float32Array(grid.length);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const window: number[] = [];
      for (let r = Math.max(0, row - radius); r <= Math.min(rows - 1, row + radius); r += 1) {
        for (let c = Math.max(0, column - radius); c <= Math.min(cols - 1, column + radius); c += 1) window.push(grid[r * cols + c]!);
      }
      out[row * cols + column] = pick(...window);
    }
  }
  return out;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
