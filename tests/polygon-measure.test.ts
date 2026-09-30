import { describe, expect, it } from "vitest";
import { PointCloud } from "../src/core/point-cloud.js";
import { buildSurfaceGrid } from "../src/core/surface-area.js";
import { baseHeights, edgesCross, measurePolygon, planArea, polygonAnchor, polygonDrawing, triangulate, type Vec3 } from "../src/core/polygon-measure.js";

const volumeGrid = (cloud: PointCloud) => buildSurfaceGrid(cloud, undefined, "mean");

/** Points on a jittered 0.25 m grid over 80 by 80 m, at the height `surface` gives; `skip` leaves holes. */
function scan(surface: (x: number, z: number) => number, skip?: (x: number, z: number) => boolean): PointCloud {
  const positions: number[] = [];
  let seed = 11;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let z = 0; z < 80; z += 0.25) {
    for (let x = 0; x < 80; x += 0.25) {
      const px = x + (random() - 0.5) * 0.1;
      const pz = z + (random() - 0.5) * 0.1;
      if (skip?.(px, pz)) continue;
      positions.push(px, surface(px, pz) + (random() - 0.5) * 0.02, pz);
    }
  }
  return new PointCloud({ positions: Float32Array.from(positions) });
}

/** A ring of corners around a centre, as a user clicking around a pile would place them. */
function ring(cx: number, cz: number, radius: number, corners: number, height: (x: number, z: number) => number): Vec3[] {
  return Array.from({ length: corners }, (_, i) => {
    const angle = (i / corners) * Math.PI * 2;
    const x = cx + Math.cos(angle) * radius;
    const z = cz + Math.sin(angle) * radius;
    return [x, height(x, z), z] as const;
  });
}

describe("polygon outlines", () => {
  const ell: Vec3[] = [
    [0, 0, 0],
    [20, 0, 0],
    [20, 0, 10],
    [10, 0, 10],
    [10, 0, 30],
    [0, 0, 30],
  ];

  it("gives the plan area of a concave outline, whichever way round it runs", () => {
    expect(planArea(ell)).toBeCloseTo(20 * 10 + 10 * 20, 6);
    expect(planArea([...ell].reverse())).toBeCloseTo(400, 6);
  });

  it("splits a concave outline into triangles that cover it exactly", () => {
    const triangles = triangulate(ell);
    expect(triangles.length).toBe((ell.length - 2) * 3);
    let area = 0;
    for (let t = 0; t < triangles.length; t += 3) area += planArea([ell[triangles[t]!]!, ell[triangles[t + 1]!]!, ell[triangles[t + 2]!]!]);
    expect(area).toBeCloseTo(400, 6);
  });

  it("finds edges that cross", () => {
    const bowTie: Vec3[] = [
      [0, 0, 0],
      [10, 0, 10],
      [10, 0, 0],
      [0, 0, 10],
    ];
    expect(edgesCross(bowTie)).toBe(true);
    expect(edgesCross(ell)).toBe(false);
  });

  it("anchors its label inside an outline whose centroid falls outside it", () => {
    const u: Vec3[] = [
      [0, 0, 0],
      [30, 0, 0],
      [30, 0, 30],
      [20, 0, 30],
      [20, 0, 5],
      [10, 0, 5],
      [10, 0, 30],
      [0, 0, 30],
    ];
    const [x, , z] = polygonAnchor({ vertices: u, base: "triangulated", height: 0 })!;
    const inGap = x > 10 && x < 20 && z > 5;
    expect(inGap).toBe(false);
  });

  it("draws the prism only once it is extruded", () => {
    const square: Vec3[] = [
      [0, 1, 0],
      [4, 1, 0],
      [4, 1, 4],
      [0, 1, 4],
    ];
    const flat = polygonDrawing({ vertices: square, base: "triangulated", height: 0 }, true);
    expect(flat.outline.length).toBe(4 * 6);
    expect(flat.base.length).toBe(2 * 9);
    expect(flat.prismFaces.length).toBe(0);
    const extruded = polygonDrawing({ vertices: square, base: "triangulated", height: 3 }, true);
    expect(extruded.prismFaces.length).toBe((4 * 2 + 2) * 9);
    expect(Math.max(...extruded.prismEdges.filter((_, index) => index % 3 === 1))).toBeCloseTo(4, 6);
  });

  it("puts a level base under every corner", () => {
    const corners: Vec3[] = [
      [0, 1, 0],
      [4, 3, 0],
      [4, 2, 4],
    ];
    expect(baseHeights({ vertices: corners, base: "lowest", height: 0 })).toEqual([1, 1, 1]);
    expect(baseHeights({ vertices: corners, base: "highest", height: 0 })).toEqual([3, 3, 3]);
    expect(baseHeights({ vertices: corners, base: "custom", customBase: 7, height: 0 })).toEqual([7, 7, 7]);
    expect(baseHeights({ vertices: corners, base: "triangulated", height: 0 })).toEqual([1, 3, 2]);
  });
});

describe("volumes", () => {
  it("measures a building's volume from its footprint drawn on the ground around it", () => {
    // A 20 by 10 m block 10 m tall on flat ground.
    const grid = volumeGrid(scan((x, z) => (x >= 30 && x < 50 && z >= 30 && z < 40 ? 10 : 0)));
    const around: Vec3[] = [
      [25, 0, 25],
      [55, 0, 25],
      [55, 0, 45],
      [25, 0, 45],
    ];
    const result = measurePolygon(grid, { vertices: around, base: "triangulated", height: 0 });
    expect(result.valid).toBe(true);
    expect(result.planArea).toBeCloseTo(600, 6);
    expect(result.perimeter).toBeCloseTo(100, 6);
    // The block's walls fall inside grid cells, whose mean heights count each side in proportion.
    expect(result.cut).toBeGreaterThan(2000 * 0.98);
    expect(result.cut).toBeLessThan(2000 * 1.02);
    expect(result.fill).toBeLessThan(5);
  });

  it("measures volumes from a surface of mean heights, not the highest points a roof click wants", () => {
    // On a slope the highest point in a cell sits half a cell's rise above its middle, which adds up over a pile.
    const pile = (x: number, z: number) => Math.max(0, 5 * (1 - Math.hypot(x - 40, z - 40) / 10));
    const cloud = scan(pile);
    const outline = ring(40, 40, 11, 16, () => 0);
    const cone = (Math.PI * 10 * 10 * 5) / 3;
    const highest = measurePolygon(buildSurfaceGrid(cloud), { vertices: outline, base: "triangulated", height: 0 });
    const mean = measurePolygon(volumeGrid(cloud), { vertices: outline, base: "triangulated", height: 0 });
    expect(highest.cut / cone).toBeGreaterThan(1.05);
    expect(Math.abs(mean.cut / cone - 1)).toBeLessThan(0.02);
  });

  it("measures a stockpile on sloping ground against the ground its outline follows", () => {
    // A cone 5 m high and 10 m across its foot, on ground rising 1 in 10 to the east.
    const ground = (x: number) => x * 0.1;
    const pile = (x: number, z: number) => ground(x) + Math.max(0, 5 * (1 - Math.hypot(x - 40, z - 40) / 10));
    const grid = volumeGrid(scan(pile));
    const outline = ring(40, 40, 11, 16, (x) => ground(x));
    const cone = (Math.PI * 10 * 10 * 5) / 3;
    const triangulated = measurePolygon(grid, { vertices: outline, base: "triangulated", height: 0 });
    expect(triangulated.cut).toBeGreaterThan(cone * 0.98);
    expect(triangulated.cut).toBeLessThan(cone * 1.02);
    // On a slope, a level base at the lowest corner counts the ground rising above it too.
    const lowest = measurePolygon(grid, { vertices: outline, base: "lowest", height: 0 });
    expect(lowest.cut).toBeGreaterThan(cone * 1.5);
    // A plane fitted to the corners is the ground itself here.
    const fitted = measurePolygon(grid, { vertices: outline, base: "fit", height: 0 });
    expect(fitted.cut).toBeCloseTo(triangulated.cut, -1);
  });

  it("reports cut and fill against a design level", () => {
    // A 1 m deep pit 10 by 10 m in flat ground at 2 m.
    const grid = volumeGrid(scan((x, z) => (x >= 30 && x < 40 && z >= 30 && z < 40 ? 1 : 2)));
    const square: Vec3[] = [
      [20, 2, 20],
      [50, 2, 20],
      [50, 2, 50],
      [20, 2, 50],
    ];
    const atGround = measurePolygon(grid, { vertices: square, base: "triangulated", height: 0 });
    expect(atGround.fill).toBeGreaterThan(100 * 0.97);
    expect(atGround.fill).toBeLessThan(100 * 1.03);
    expect(atGround.cut).toBeLessThan(2);
    // Levelling the whole square at 1.5 m cuts half a metre off the ground around the pit and fills half of the pit.
    const levelled = measurePolygon(grid, { vertices: square, base: "custom", customBase: 1.5, height: 0 });
    expect(levelled.cut).toBeGreaterThan((900 - 100) * 0.5 * 0.97);
    expect(levelled.cut).toBeLessThan((900 - 100) * 0.5 * 1.03);
    expect(levelled.fill).toBeGreaterThan(100 * 0.5 * 0.9);
    expect(levelled.fill).toBeLessThan(100 * 0.5 * 1.1);
  });

  it("extrudes a polygon into a prism and says how much of it the scan fills", () => {
    const grid = volumeGrid(scan((x, z) => (x >= 30 && x < 50 && z >= 30 && z < 40 ? 10 : 0)));
    const around: Vec3[] = [
      [25, 0, 25],
      [55, 0, 25],
      [55, 0, 45],
      [25, 0, 45],
    ];
    const result = measurePolygon(grid, { vertices: around, base: "triangulated", height: 4 });
    expect(result.prism).toBeCloseTo(600 * 4, 6);
    // The block fills its footprint up to the prism's 4 m top. A cell on its wall averages to half the wall's
    // height, which the prism's top then cuts off whole rather than in proportion, so the rim counts a little high.
    expect(result.filled).toBeGreaterThan(800 * 0.98);
    expect(result.filled).toBeLessThan(800 * 1.06);
  });

  it("gives the area along a sloped surface", () => {
    const pitch = Math.tan((30 * Math.PI) / 180);
    const grid = volumeGrid(scan((x) => x * pitch));
    const square: Vec3[] = [
      [20, 20 * pitch, 20],
      [50, 50 * pitch, 20],
      [50, 50 * pitch, 50],
      [20, 20 * pitch, 50],
    ];
    const result = measurePolygon(grid, { vertices: square, base: "triangulated", height: 0 });
    expect(result.surfaceArea / result.planArea).toBeCloseTo(1 / Math.cos((30 * Math.PI) / 180), 2);
    expect(result.edgeLength).toBeGreaterThan(result.perimeter);
  });

  it("fills a gap in the scan from around it and says how much of the area it was", () => {
    // Flat ground at 3 m with no points in a 6 by 6 m patch, as under a puddle.
    const grid = volumeGrid(scan(() => 3, (x, z) => x >= 37 && x < 43 && z >= 37 && z < 43));
    const square: Vec3[] = [
      [30, 2, 30],
      [50, 2, 30],
      [50, 2, 50],
      [30, 2, 50],
    ];
    const result = measurePolygon(grid, { vertices: square, base: "triangulated", height: 0 });
    // Filling speckles eats a cell or two into the gap's rim; the rest is reported.
    expect(result.unmeasured).toBeGreaterThan(0.02);
    expect(result.unmeasured).toBeLessThan((36 / 400) * 1.1);
    // The gap takes the height around it, so the volume above a base 1 m down is the whole square's.
    expect(result.cut).toBeCloseTo(400, -1);
  });

  it("measures nothing for an outline whose edges cross", () => {
    const grid = volumeGrid(scan(() => 0));
    const bowTie: Vec3[] = [
      [10, 0, 10],
      [30, 0, 30],
      [30, 0, 10],
      [10, 0, 30],
    ];
    expect(measurePolygon(grid, { vertices: bowTie, base: "triangulated", height: 0 }).valid).toBe(false);
  });
});
