import { describe, expect, it } from "vitest";
import { PointCloud } from "../src/core/point-cloud.js";
import { buildSurfaceGrid, selectSurface } from "../src/core/surface-area.js";

/**
 * A block of ground 60 by 60 m at height 0 with two buildings on it: a flat
 * roof 10 m up over 20 by 10 m, and a roof pitched at 30 degrees over another
 * 10 by 10 m. Points fall on a jittered 0.2 m grid, as a dense scan's would.
 */
function roofs(): PointCloud {
  const positions: number[] = [];
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const pitch = Math.tan((30 * Math.PI) / 180);
  for (let z = 0; z < 60; z += 0.2) {
    for (let x = 0; x < 60; x += 0.2) {
      const px = x + (random() - 0.5) * 0.1;
      const pz = z + (random() - 0.5) * 0.1;
      let y = 0;
      if (px >= 10 && px < 30 && pz >= 10 && pz < 20) y = 10;
      else if (px >= 40 && px < 50 && pz >= 30 && pz < 40) y = 6 + (px - 40) * pitch;
      positions.push(px, y + (random() - 0.5) * 0.04, pz);
    }
  }
  return new PointCloud({ positions: Float32Array.from(positions) });
}

describe("surface area", () => {
  const cloud = roofs();
  const grid = buildSurfaceGrid(cloud);

  it("measures a flat roof from one click on it", () => {
    const roof = selectSurface(grid, 20, 15)!;
    // The roof's edges fall inside grid cells, so the count is good to about a cell's width around it.
    expect(roof.planArea).toBeGreaterThan(200 * 0.93);
    expect(roof.planArea).toBeLessThan(200 * 1.07);
    expect(roof.slopeDegrees).toBeLessThan(1);
    expect(roof.meanHeight).toBeCloseTo(10, 1);
  });

  it("gives a pitched roof's true area and pitch as well as its plan area", () => {
    const roof = selectSurface(grid, 45, 35)!;
    expect(roof.planArea).toBeGreaterThan(100 * 0.9);
    expect(roof.planArea).toBeLessThan(100 * 1.1);
    expect(roof.slopeDegrees).toBeCloseTo(30, 0);
    expect(roof.surfaceArea / roof.planArea).toBeCloseTo(1 / Math.cos((30 * Math.PI) / 180), 2);
  });

  it("stops at the walls: the ground around the buildings is its own surface", () => {
    const ground = selectSurface(grid, 5, 5)!;
    // Everything but the two footprints, give or take the cells along their walls.
    const expected = 60 * 60 - 200 - 100;
    expect(ground.planArea).toBeGreaterThan(expected * 0.95);
    expect(ground.planArea).toBeLessThan(expected * 1.03);
  });

  it("draws an outline around what it measured", () => {
    const roof = selectSurface(grid, 20, 15)!;
    expect(roof.outline.length % 6).toBe(0);
    // The perimeter of a 20 by 10 m roof is 60 m; its outline is made of cell edges adding up to about that.
    let length = 0;
    for (let index = 0; index < roof.outline.length; index += 6) {
      length += Math.hypot(roof.outline[index + 3]! - roof.outline[index]!, roof.outline[index + 5]! - roof.outline[index + 2]!);
    }
    expect(length).toBeGreaterThan(55);
    expect(length).toBeLessThan(70);
  });
});
