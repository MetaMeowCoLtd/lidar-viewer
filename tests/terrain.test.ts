import { describe, expect, it } from "vitest";
import { buildTerrainModel, calculateBounds, contourInterval, sampleSurface, traceContours, type TerrainModel } from "../src/index.js";
import { buildAerialScene, truth } from "./support/aerial-scene.js";

/** Ground points on a grid over `size` by `size`, at heights from `height`, all classed as ground. */
function groundCloud(size: number, spacing: number, height: (x: number, z: number) => number) {
  const positions: number[] = [];
  for (let z = 0; z <= size; z += spacing) {
    for (let x = 0; x <= size; x += spacing) positions.push(x, height(x, z), z);
  }
  const array = Float32Array.from(positions);
  return { positions: array, bounds: calculateBounds(array), classification: new Uint8Array(array.length / 3).fill(2) };
}

describe("terrain model", () => {
  it("rebuilds the bare ground under buildings and trees to within centimetres", () => {
    const scene = buildAerialScene({ seed: 5 });
    const model = buildTerrainModel({ positions: scene.positions, bounds: scene.bounds, classification: scene.groundClassification });

    // The scene knows each point's exact height above its terrain, so every
    // point - roof, crown or ground - gives the true ground height beneath it.
    let squared = 0;
    let samples = 0;
    for (let point = 0; point < scene.kind.length; point += 97) {
      if (scene.kind[point] === truth.noise) continue;
      const offset = point * 3;
      const trueGround = scene.positions[offset + 1]! - scene.heightAboveGround[point]!;
      const modelled = sampleSurface(model.elevations, model.grid, scene.positions[offset]!, scene.positions[offset + 2]!);
      if (modelled !== modelled) continue;
      squared += (modelled - trueGround) ** 2;
      samples += 1;
    }
    const rmse = Math.sqrt(squared / samples);
    expect(samples).toBeGreaterThan(4000);
    expect(rmse).toBeLessThan(0.25);
    expect(model.measuredCells).toBeLessThan(model.coveredCells);
  });

  it("fills ground the scan could not see, but not ground outside the scan", () => {
    const cloud = groundCloud(40, 0.5, (x) => 10 + 0.1 * x);
    // Hide the ground in a square in the middle, as a building would, but keep
    // points there so the area still counts as scanned.
    for (let point = 0; point < cloud.classification.length; point += 1) {
      const x = cloud.positions[point * 3]!;
      const z = cloud.positions[point * 3 + 2]!;
      if (x > 15 && x < 25 && z > 15 && z < 25) cloud.classification[point] = 6;
    }
    // Stretch the bounds past the data, so part of the grid has no points at all.
    const bounds = calculateBounds(Float32Array.from([...cloud.positions, 60, 10, 0]));
    const model = buildTerrainModel({ ...cloud, bounds, positions: cloud.positions }, { cellSize: 1, maxGridCells: 1_000_000 });

    const at = (x: number, z: number) => sampleSurface(model.elevations, model.grid, x, z);
    expect(at(20, 20)).toBeCloseTo(12, 0);
    expect(model.measured[20 * model.grid.cols + 20]).toBe(0);
    expect(model.measured[5 * model.grid.cols + 5]).toBe(1);
    expect(Number.isNaN(model.elevations[20 * model.grid.cols + 55]!)).toBe(true);
    expect(model.minElevation).toBeCloseTo(10, 0);
    expect(model.maxElevation).toBeCloseTo(14.1, 0);
  });

  it("refuses a scan with no ground marked", () => {
    const cloud = groundCloud(10, 1, () => 0);
    cloud.classification.fill(1);
    expect(() => buildTerrainModel(cloud)).toThrow(/Detect ground first/);
  });
});

describe("contour lines", () => {
  const model = (size: number, height: (x: number, z: number) => number): TerrainModel => {
    const cloud = groundCloud(size, 0.5, height);
    return buildTerrainModel(cloud, { cellSize: 1, maxGridCells: 1_000_000 });
  };

  it("picks a round interval from the relief, with index contours at a round multiple", () => {
    expect(contourInterval(24)).toEqual({ interval: 1, majorEvery: 5 });
    expect(contourInterval(60)).toEqual({ interval: 2.5, majorEvery: 4 });
    expect(contourInterval(3)).toEqual({ interval: 0.2, majorEvery: 5 });
    expect(contourInterval(90_000).interval).toBeGreaterThanOrEqual(3_600);
  });

  it("traces a slope as one straight line per level at round elevations of the scan", () => {
    // Local heights 0 to 10 over 100 units of x; the frame's origin is 30.25 m up.
    const slope = model(100, (x) => 0.1 * x);
    const contours = traceContours(slope, 30.25, { interval: 1, smoothingPasses: 0 });
    const levels = contours.lines.map((line) => line.level + 30.25);
    expect(levels).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    for (const line of contours.lines) {
      expect(line.closed).toBe(false);
      const xs = line.points.filter((_, index) => index % 3 === 0);
      const expectedX = (line.level * 10);
      for (const x of xs) expect(Math.abs(x - expectedX)).toBeLessThan(0.6);
      // It runs the length of the grid in z.
      const zs = line.points.filter((_, index) => index % 3 === 2);
      expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(95);
    }
    expect(contours.lines.filter((line) => line.major).map((line) => line.level + 30.25)).toEqual([35, 40]);
  });

  it("closes the rings around a hill and drops rings too small to be landforms", () => {
    const hill = model(80, (x, z) => Math.max(0, 12 - Math.hypot(x - 40, z - 40) / 3));
    const contours = traceContours(hill, 0, { interval: 2, smoothingPasses: 0 });
    const rings = contours.lines.filter((line) => line.closed);
    // Levels 2 to 10; the summit itself, at exactly 12, is a point rather than a ring.
    expect(rings.map((ring) => ring.level)).toEqual([2, 4, 6, 8, 10]);
    for (const ring of rings) {
      const radius = (12 - ring.level) * 3;
      for (let index = 0; index < ring.points.length; index += 3) {
        // A cell's height is the mean of the points in it, which sit a quarter
        // cell from its centre, so the hill appears centred at 40.25.
        expect(Math.abs(Math.hypot(ring.points[index]! - 40.25, ring.points[index + 2]! - 40.25) - radius)).toBeLessThan(0.75);
      }
    }
    // A lump in a single cell, the size of a car or a noise spike, not of a landform.
    const bump = model(40, (x, z) => (Math.hypot(x - 20.25, z - 20.25) < 0.4 ? 1 : 0));
    expect(traceContours(bump, 0, { interval: 0.5, smoothingPasses: 0 }).lines).toHaveLength(0);
  });

  it("leaves lines open where they reach the edge of the scan", () => {
    const tilted = model(60, (x, z) => 0.05 * (x + z));
    const contours = traceContours(tilted, 0, { interval: 1 });
    expect(contours.lines.length).toBeGreaterThan(3);
    expect(contours.lines.every((line) => !line.closed)).toBe(true);
  });
});
