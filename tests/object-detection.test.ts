import { describe, expect, it } from "vitest";
import {
  defaultObjectDetectionOptions,
  detectObjects,
  heightAboveClassifiedGround,
  PointCloud,
  PointCloudTiler,
  VoxelGridDownsampler,
  planeFitRoughness,
  segmentCrowns,
  simplifyClosedPolygon,
  traceOutline,
  type DetectedObject,
  type ObjectDetectionResult,
} from "../src/index.js";
import { buildAerialScene, truth, type AerialScene } from "./support/aerial-scene.js";

describe("object ids as a point channel", () => {
  const positions = new Float32Array([0, 0, 0, 0.2, 0.2, 0.2, 0.4, 0.4, 0.4, 9, 9, 9]);

  it("takes the majority object in a voxel, never an average of ids", () => {
    const cloud = new PointCloud({ positions, objectId: new Uint32Array([7, 3, 7, 12]) });
    const decimated = new VoxelGridDownsampler().downsample(cloud, { voxelSize: 1 });
    expect(decimated.objectId).toBeInstanceOf(Uint32Array);
    expect([...decimated.objectId!]).toEqual([7, 12]);
  });

  it("survives tiling, including ids too large for a byte", () => {
    const cloud = new PointCloud({ positions, objectId: new Uint32Array([70_000, 3, 70_000, 12]) });
    const tiles = new PointCloudTiler().tile(cloud, { tileSize: 5 });
    const ids = tiles.flatMap((tile) => [...tile.cloud.objectId!]).sort((a, b) => a - b);
    expect(ids).toEqual([3, 12, 70_000, 70_000]);
  });

  it("enables the objects colour mode only on clouds that carry ids", () => {
    expect(new PointCloud({ positions, objectId: new Uint32Array(4) }).supportsColorMode("objects")).toBe(true);
    expect(new PointCloud({ positions }).supportsColorMode("objects")).toBe(false);
  });
});

describe("height above a ground the file already classified", () => {
  it("measures from the file's own ground instead of filtering again", () => {
    const scene = buildAerialScene({ seed: 5, halfSize: 60 });
    const heights = heightAboveClassifiedGround({ positions: scene.positions, bounds: scene.bounds, classification: scene.groundClassification })!;
    expect(heights).toBeDefined();
    let worst = 0;
    for (let point = 0; point < heights.length; point += 1) {
      if (scene.kind[point] === truth.building) worst = Math.max(worst, Math.abs(heights[point]! - scene.heightAboveGround[point]!));
    }
    // Under a roof there is no ground to measure from, so the surface there is
    // filled from the ground around it; on these gentle slopes that stays close.
    expect(worst).toBeLessThan(1);
  });

  it("declines when too few points are marked as ground", () => {
    const scene = buildAerialScene({ seed: 5, halfSize: 60 });
    expect(heightAboveClassifiedGround({ positions: scene.positions, bounds: scene.bounds, classification: new Uint8Array(scene.kind.length) })).toBeUndefined();
  });
});

describe("tracing a footprint outline", () => {
  const grid = (rows: string[]) => {
    const cols = rows[0]!.length;
    const labels = new Int32Array(cols * rows.length);
    rows.forEach((line, row) => [...line].forEach((mark, column) => (labels[row * cols + column] = mark === "#" ? 1 : 0)));
    return { labels, cols, rows: rows.length };
  };
  const outlineOf = (rows: string[]) => {
    const { labels, cols, rows: height } = grid(rows);
    return simplifyClosedPolygon(traceOutline(labels, cols, height, 1, 0, cols - 1, 0, height - 1), 0.5);
  };

  it("reduces a rectangle to its four corners", () => {
    const outline = outlineOf(["......", ".####.", ".####.", ".####.", "......"]);
    expect(outline.length / 2).toBe(4);
    const xs = [...outline].filter((_, index) => index % 2 === 0);
    const ys = [...outline].filter((_, index) => index % 2 === 1);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([1, 5, 1, 4]);
  });

  it("keeps the inside corner of an L-shape", () => {
    const outline = outlineOf(["#####", "#####", "##...", "##...", "##..."]);
    expect(outline.length / 2).toBe(6);
  });

  it("walks two cells that touch only at a corner as one loop", () => {
    const { labels, cols, rows } = grid(["#.", ".#"]);
    expect(traceOutline(labels, cols, rows, 1, 0, 1, 0, 1).length / 2).toBe(8);
  });

  it("straightens the staircase a diagonal wall leaves on a raster", () => {
    const staircase = Float64Array.from([0, 0, 1, 0, 1, 1, 2, 1, 2, 2, 3, 2, 3, 3, 4, 3, 4, 4, 0, 4]);
    expect(simplifyClosedPolygon(staircase, 0.75).length / 2).toBe(3);
  });
});

describe("roof roughness", () => {
  it("is near zero on a pitched plane and large on a lumpy canopy", () => {
    const cols = 9;
    const rows = 9;
    const pitched = Float32Array.from({ length: cols * rows }, (_, cell) => 5 + 0.7 * (cell % cols));
    const lumpy = Float32Array.from({ length: cols * rows }, (_, cell) => 8 + Math.sin(cell * 2.3) * 0.8);
    expect(planeFitRoughness(pitched, cols, rows)[4 * cols + 4]).toBeLessThan(1e-4);
    expect(planeFitRoughness(lumpy, cols, rows)[4 * cols + 4]).toBeGreaterThan(0.3);
  });

  it("declines to judge a cell with too few neighbours", () => {
    const top = new Float32Array(9).fill(Number.NaN);
    top[4] = 5;
    top[3] = 5;
    expect(planeFitRoughness(top, 3, 3)[4]).toBe(Infinity);
  });
});

describe("crown segmentation", () => {
  it("splits two touching crowns along the valley between them", () => {
    const cols = 40;
    const rows = 20;
    const chm = new Float32Array(cols * rows);
    const canopy = new Uint8Array(cols * rows);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < cols; column += 1) {
        // Two trees 6.5 m apart with overlapping crowns, as close as real
        // neighbours of these heights grow.
        const left = 14 * Math.exp(-((column - 12) ** 2 + (row - 10) ** 2) / 90);
        const right = 11 * Math.exp(-((column - 25) ** 2 + (row - 10) ** 2) / 70);
        const height = Math.max(left, right);
        if (height > 2) {
          chm[row * cols + column] = height;
          canopy[row * cols + column] = 1;
        }
      }
    }
    const crownOfCell = new Int32Array(cols * rows);
    const crowns = segmentCrowns(
      chm,
      canopy,
      { originX: 0, originZ: 0, cellSize: 0.5, cols, rows },
      defaultObjectDetectionOptions,
      crownOfCell,
    );
    expect(crowns).toHaveLength(2);
    const leftLabel = crownOfCell[10 * cols + 12]!;
    const rightLabel = crownOfCell[10 * cols + 25]!;
    expect(leftLabel).not.toBe(0);
    expect(rightLabel).not.toBe(0);
    expect(leftLabel).not.toBe(rightLabel);
    // The domes cross between columns 19 and 20; each side of that valley keeps its own tree.
    expect(crownOfCell[10 * cols + 18]).toBe(leftLabel);
    expect(crownOfCell[10 * cols + 21]).toBe(rightLabel);
  });
});

describe("building and tree detection", () => {
  const withReturns = buildAerialScene({ seed: 7 });
  const detect = (scene: AerialScene, overrides: Partial<Parameters<typeof detectObjects>[0]> = {}) =>
    detectObjects({
      positions: scene.positions,
      bounds: scene.bounds,
      heightAboveGround: scene.heightAboveGround,
      classification: scene.groundClassification,
      numberOfReturns: scene.numberOfReturns,
      ...overrides,
    });

  const result = detect(withReturns);
  const score = scoreScene(withReturns, result);
  console.info(describeScore("aerial neighbourhood, with returns", withReturns, result, score));

  it("counts every building, treating a shared-wall terrace as one", () => {
    expect(result.stats.buildings).toBe(score.truthBuildingGroups);
    expect(score.buildingRecall).toBe(1);
  });

  it("finds nearly every tree, including overlapping crowns", () => {
    expect(score.treeRecall).toBeGreaterThanOrEqual(0.9);
    expect(score.treePrecision).toBeGreaterThanOrEqual(0.9);
  });

  it("does not count a shed, hedges, a garden wall, lamp posts or cars", () => {
    expect(score.otherPointsTaken).toBeLessThan(0.02);
  });

  it("labels building and tree points with the right classes", () => {
    expect(score.buildingPointsLabelled).toBeGreaterThan(0.95);
    expect(score.treePointsLabelled).toBeGreaterThan(0.9);
    expect(score.groundPointsTaken).toBe(0);
  });

  it("measures footprints and heights close to the truth", () => {
    for (const { truthBuilding, detected } of score.buildingMatches) {
      if (detected?.kind !== "building" || truthBuilding.group !== truthBuilding.id) continue;
      expect(Math.abs(detected.footprintArea - truthBuilding.footprintArea) / truthBuilding.footprintArea).toBeLessThan(0.12);
      expect(Math.abs(detected.height - truthBuilding.roofTop)).toBeLessThan(0.8);
    }
  });

  it("still separates buildings from trees when the file records no returns", () => {
    const blind = detect(withReturns, { numberOfReturns: undefined });
    const blindScore = scoreScene(withReturns, blind);
    console.info(describeScore("aerial neighbourhood, no returns", withReturns, blind, blindScore));
    expect(blind.stats.buildings).toBe(blindScore.truthBuildingGroups);
    expect(blindScore.treeRecall).toBeGreaterThanOrEqual(0.85);
    expect(blindScore.treePrecision).toBeGreaterThanOrEqual(0.85);
  });

  it("uses classes a file already carries, and never overwrites them", () => {
    const classification = Uint8Array.from(withReturns.kind, (kind) =>
      kind === truth.ground ? 2 : kind === truth.building ? 6 : kind === truth.tree ? 5 : kind === truth.noise ? 7 : 11,
    );
    const labelled = detect(withReturns, { classification });
    expect([...labelled.classification]).toEqual([...classification]);
    const labelledScore = scoreScene(withReturns, labelled);
    expect(labelled.stats.buildings).toBe(labelledScore.truthBuildingGroups);
    expect(labelledScore.treeRecall).toBeGreaterThanOrEqual(0.9);
  });

  it("stays accurate on differently randomised scenes and a denser scan", () => {
    for (const [seed, density] of [[11, 6], [23, 6], [23, 12]] as const) {
      const scene = buildAerialScene({ seed, density });
      const other = detect(scene);
      const otherScore = scoreScene(scene, other);
      console.info(describeScore(`aerial neighbourhood, seed ${seed}, ${density} pulses per m2`, scene, other, otherScore));
      expect(other.stats.buildings).toBe(otherScore.truthBuildingGroups);
      expect(Math.abs(other.stats.trees - scene.trees.length)).toBeLessThanOrEqual(2);
      expect(otherScore.treeRecall).toBeGreaterThanOrEqual(0.9);
      expect(otherScore.treePrecision).toBeGreaterThanOrEqual(0.9);
      for (const { truthBuilding, detected } of otherScore.buildingMatches) {
        if (detected?.kind !== "building" || truthBuilding.group !== truthBuilding.id) continue;
        expect(Math.abs(detected.footprintArea - truthBuilding.footprintArea) / truthBuilding.footprintArea).toBeLessThan(0.12);
      }
    }
  }, 60_000);

  it("counts a tower with a rough top as a building, not a stand of trees", () => {
    const scene = buildAerialScene({ seed: 7, tower: true });
    const towered = detect(scene);
    const toweredScore = scoreScene(scene, towered);
    const trees = towered.objects.filter((object) => object.kind === "tree");
    expect(towered.stats.buildings).toBe(toweredScore.truthBuildingGroups);
    expect(toweredScore.buildingRecall).toBe(1);
    expect(Math.max(...trees.map((tree) => tree.height))).toBeLessThan(defaultObjectDetectionOptions.maxTreeHeight);
    expect(toweredScore.treePrecision).toBeGreaterThanOrEqual(0.9);
  });

  it("gives every labelled point the id of an object it reports", () => {
    const ids = new Set(result.objects.map((object) => object.id));
    for (const id of result.objectId) if (id !== 0) expect(ids.has(id)).toBe(true);
    expect(result.objects.filter((object) => object.kind === "building")).toHaveLength(result.stats.buildings);
    expect(result.objects.filter((object) => object.kind === "tree")).toHaveLength(result.stats.trees);
  });

  it("rejects options that cannot describe the scene", () => {
    expect(() => detectObjects({ ...inputOf(withReturns) }, { ...defaultObjectDetectionOptions, minBuildingArea: 0 })).toThrow(/minBuildingArea/);
    expect(() => detectObjects({ ...inputOf(withReturns) }, { ...defaultObjectDetectionOptions, crownFraction: 2 })).toThrow(/crownFraction/);
  });
});

function inputOf(scene: AerialScene) {
  return {
    positions: scene.positions,
    bounds: scene.bounds,
    heightAboveGround: scene.heightAboveGround,
    classification: scene.groundClassification,
  };
}

interface SceneScore {
  truthBuildingGroups: number;
  buildingRecall: number;
  buildingMatches: { truthBuilding: AerialScene["buildings"][number]; detected: DetectedObject | undefined }[];
  treeRecall: number;
  treePrecision: number;
  buildingPointsLabelled: number;
  treePointsLabelled: number;
  otherPointsTaken: number;
  groundPointsTaken: number;
}

/**
 * Matches detected objects to the truth by the points they share. A pair
 * matches when the points they have in common are at least half of the points
 * either holds between them - intersection over union - and each object
 * matches at most once, best pairs first.
 */
function scoreScene(scene: AerialScene, result: ObjectDetectionResult): SceneScore {
  const groupOf = new Map(scene.buildings.map((building) => [building.id, building.group]));
  const objectsById = new Map(result.objects.map((object) => [object.id, object]));

  const match = (kind: number, key: (instance: number) => number, detectedKind: DetectedObject["kind"]) => {
    const truthTotals = new Map<number, number>();
    const detectedTotals = new Map<number, number>();
    const shared = new Map<string, number>();
    for (let point = 0; point < scene.kind.length; point += 1) {
      const id = result.objectId[point]!;
      const detected = id !== 0 && objectsById.get(id)?.kind === detectedKind ? id : 0;
      if (detected !== 0) detectedTotals.set(detected, (detectedTotals.get(detected) ?? 0) + 1);
      if (scene.kind[point] !== kind) continue;
      const truthKey = key(scene.instance[point]!);
      truthTotals.set(truthKey, (truthTotals.get(truthKey) ?? 0) + 1);
      if (detected !== 0) shared.set(`${truthKey}:${detected}`, (shared.get(`${truthKey}:${detected}`) ?? 0) + 1);
    }
    const pairs = [...shared.entries()]
      .map(([pair, count]) => {
        const [truthKey, detected] = pair.split(":").map(Number) as [number, number];
        return { truthKey, detected, iou: count / (truthTotals.get(truthKey)! + detectedTotals.get(detected)! - count) };
      })
      .filter((pair) => pair.iou >= 0.5)
      .sort((a, b) => b.iou - a.iou);
    const matchedTruth = new Map<number, number>();
    const matchedDetected = new Set<number>();
    for (const pair of pairs) {
      if (matchedTruth.has(pair.truthKey) || matchedDetected.has(pair.detected)) continue;
      matchedTruth.set(pair.truthKey, pair.detected);
      matchedDetected.add(pair.detected);
    }
    return { matchedTruth, truthCount: truthTotals.size, detectedCount: detectedTotals.size };
  };

  const buildings = match(truth.building, (instance) => groupOf.get(instance)!, "building");
  const trees = match(truth.tree, (instance) => instance, "tree");

  let buildingPoints = 0, buildingLabelled = 0, treePoints = 0, treeLabelled = 0, otherPoints = 0, otherTaken = 0, groundTaken = 0;
  for (let point = 0; point < scene.kind.length; point += 1) {
    const code = result.classification[point]!;
    switch (scene.kind[point]) {
      case truth.building:
        buildingPoints += 1;
        if (code === 6) buildingLabelled += 1;
        break;
      case truth.tree:
        // Only points high enough to be counted can be expected to be labelled.
        if (scene.heightAboveGround[point]! < 2) break;
        treePoints += 1;
        if (code === 5) treeLabelled += 1;
        break;
      case truth.other:
        otherPoints += 1;
        if (result.objectId[point] !== 0) otherTaken += 1;
        break;
      case truth.ground:
        if (result.objectId[point] !== 0) groundTaken += 1;
        break;
    }
  }

  return {
    truthBuildingGroups: buildings.truthCount,
    buildingRecall: buildings.matchedTruth.size / buildings.truthCount,
    buildingMatches: scene.buildings.map((building) => ({
      truthBuilding: building,
      detected: objectsById.get(buildings.matchedTruth.get(building.group) ?? -1),
    })),
    treeRecall: trees.matchedTruth.size / trees.truthCount,
    treePrecision: trees.detectedCount === 0 ? 0 : trees.matchedTruth.size / trees.detectedCount,
    buildingPointsLabelled: buildingLabelled / buildingPoints,
    treePointsLabelled: treeLabelled / treePoints,
    otherPointsTaken: otherPoints === 0 ? 0 : otherTaken / otherPoints,
    groundPointsTaken: groundTaken,
  };
}

function describeScore(label: string, scene: AerialScene, result: ObjectDetectionResult, score: SceneScore): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  return (
    `${label}: ${scene.positions.length / 3} points, cells ${result.stats.cellSize.toFixed(2)} m\n` +
    `  buildings ${result.stats.buildings} of ${score.truthBuildingGroups}, recall ${percent(score.buildingRecall)}, points labelled ${percent(score.buildingPointsLabelled)}\n` +
    `  trees ${result.stats.trees} of ${scene.trees.length}, recall ${percent(score.treeRecall)}, precision ${percent(score.treePrecision)}, points labelled ${percent(score.treePointsLabelled)}\n` +
    `  decoy points taken ${percent(score.otherPointsTaken)}, ground points taken ${score.groundPointsTaken}`
  );
}
