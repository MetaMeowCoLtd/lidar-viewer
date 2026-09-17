import { describe, expect, it } from "vitest";
import { buildTerrainModel, calculateBounds, sampleSurface } from "../src/index.js";
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
