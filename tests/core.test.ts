import { describe, expect, it } from "vitest";
import {
  PointCloud,
  PointCloudLodPyramid,
  PointCloudSession,
  PointCloudTiler,
  ProceduralCloudGenerator,
  TiledPointCloudLodPyramid,
  VoxelGridDownsampler,
} from "../src/index.js";

describe("PointCloud", () => {
  it("derives bounds and validates aligned attributes", () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 2, -1, 4, -2, 3]),
      colors: new Uint8Array([10, 20, 30, 40, 50, 60]),
    });
    expect(cloud.pointCount).toBe(2);
    expect(cloud.bounds.min).toEqual([0, -2, -1]);
    expect(cloud.bounds.max).toEqual([4, 2, 3]);
    expect(cloud.supportsColorMode("rgb")).toBe(true);
    expect(cloud.supportsColorMode("relief")).toBe(true);
  });
});

describe("VoxelGridDownsampler", () => {
  it("averages positions and attributes per occupied voxel", () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 2.1, 0, 0]),
      colors: new Uint8Array([0, 0, 0, 100, 100, 100, 255, 0, 0]),
      intensity: new Float32Array([2, 4, 8]),
    });
    const result = new VoxelGridDownsampler().downsample(cloud, { voxelSize: 1 });
    expect(result.pointCount).toBe(2);
    expect(result.positions[0]).toBeCloseTo(0.2);
    expect(result.positions[1]).toBeCloseTo(0.2);
    expect(result.positions[2]).toBeCloseTo(0.2);
    expect([...result.colors!.slice(0, 3)]).toEqual([50, 50, 50]);
    expect(result.intensity![0]).toBe(3);
  });
});

describe("PointCloudSession", () => {
  it("does not let a stale asynchronous load replace a newer cloud", async () => {
    let resolveFirst: ((cloud: PointCloud) => void) | undefined;
    const first = new Promise<PointCloud>((resolve) => { resolveFirst = resolve; });
    const second = new PointCloud({ positions: new Float32Array([4, 0, 0]), name: "newest" });
    const session = new PointCloudSession();
    const specs = [{ id: "full", voxelSize: 0 }];

    const firstLoad = session.load(first, specs);
    const secondLoad = session.load(second, specs);
    resolveFirst!(new PointCloud({ positions: new Float32Array([0, 0, 0]), name: "stale" }));
    await Promise.all([firstLoad, secondLoad]);

    expect(session.snapshot.status).toBe("ready");
    if (session.snapshot.status === "ready") {
      expect(session.snapshot.pyramid.tiers[0]!.cloud.name).toBe("newest");
    }
  });
});

describe("PointCloudLodPyramid", () => {
  it("chooses the richest tier inside a point budget", () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 0.2, 0, 0, 2, 0, 0, 4, 0, 0]),
    });
    const pyramid = PointCloudLodPyramid.build(cloud, [
      { id: "full", voxelSize: 0 },
      { id: "reduced", voxelSize: 1 },
      { id: "coarse", voxelSize: 3 },
    ]);
    expect(pyramid.selectForPointBudget(3).id).toBe("reduced");
    expect(pyramid.selectForPointBudget(1).id).toBe("coarse");
  });

  it("chooses coarser tiers as the camera moves further away", () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 0.2, 0, 0, 2, 0, 0, 4, 0, 0]),
    });
    const pyramid = PointCloudLodPyramid.build(cloud, [
      { id: "full", voxelSize: 0, minCameraDistance: 0 },
      { id: "reduced", voxelSize: 1, minCameraDistance: 10 },
      { id: "coarse", voxelSize: 3, minCameraDistance: 25 },
    ]);
    expect(pyramid.selectForCameraDistance(0).id).toBe("full");
    expect(pyramid.selectForCameraDistance(15).id).toBe("reduced");
    expect(pyramid.selectForCameraDistance(1_000).id).toBe("coarse");
  });

  it("falls back to the highest-detail tier when no tier declares a distance threshold", () => {
    const cloud = new PointCloud({ positions: new Float32Array([0, 0, 0, 4, 0, 0]) });
    const pyramid = PointCloudLodPyramid.build(cloud, [
      { id: "full", voxelSize: 0 },
      { id: "coarse", voxelSize: 3 },
    ]);
    expect(pyramid.selectForCameraDistance(500).id).toBe("full");
  });

  it("rejects negative or non-finite distances", () => {
    const cloud = new PointCloud({ positions: new Float32Array([0, 0, 0, 4, 0, 0]) });
    const pyramid = PointCloudLodPyramid.build(cloud, [{ id: "full", voxelSize: 0, minCameraDistance: 0 }]);
    expect(() => pyramid.selectForCameraDistance(-1)).toThrow();
    expect(() => pyramid.selectForCameraDistance(Number.NaN)).toThrow();
  });
});

describe("ProceduralCloudGenerator", () => {
  it("is deterministic for a seed", () => {
    const generator = new ProceduralCloudGenerator();
    const first = generator.generate({ pointCount: 20, seed: 4 });
    const second = generator.generate({ pointCount: 20, seed: 4 });
    expect(first.positions).toEqual(second.positions);
    expect(first.colors).toEqual(second.colors);
  });
});

describe("PointCloudTiler", () => {
  it("partitions points into XZ grid columns without losing or duplicating any", () => {
    const cloud = new PointCloud({
      positions: new Float32Array([
        0, 0, 0, // tile (0,0)
        4, 1, 4, // tile (0,0)
        12, 2, 0, // tile (1,0)
        0, 3, 12, // tile (0,1)
        12, 4, 12, // tile (1,1)
      ]),
      colors: new Uint8Array([
        10, 10, 10,
        20, 20, 20,
        30, 30, 30,
        40, 40, 40,
        50, 50, 50,
      ]),
    });
    const tiles = new PointCloudTiler().tile(cloud, { tileSize: 10 });

    expect(tiles.length).toBe(4);
    const totalPoints = tiles.reduce((sum, tile) => sum + tile.cloud.pointCount, 0);
    expect(totalPoints).toBe(cloud.pointCount);

    const originTile = tiles.find((tile) => tile.gridX === 0 && tile.gridZ === 0);
    expect(originTile?.cloud.pointCount).toBe(2);
    expect([...originTile!.cloud.colors!]).toEqual([10, 10, 10, 20, 20, 20]);
  });

  it("rejects a non-positive tile size", () => {
    const cloud = new PointCloud({ positions: new Float32Array([0, 0, 0, 1, 0, 1]) });
    expect(() => new PointCloudTiler().tile(cloud, { tileSize: 0 })).toThrow();
    expect(() => new PointCloudTiler().tile(cloud, { tileSize: -5 })).toThrow();
  });
});

describe("TiledPointCloudLodPyramid", () => {
  const specs = [
    { id: "full", voxelSize: 0, minCameraDistance: 0 },
    { id: "coarse", voxelSize: 5, minCameraDistance: 20 },
  ];

  function makeTwoTileCloud(): PointCloud {
    return new PointCloud({
      positions: new Float32Array([
        0, 0, 0, 0.5, 0, 0, 1, 0, 0, // near tile, clustered so voxelSize=5 collapses it
        100, 0, 0, 100.5, 0, 0, 101, 0, 0, // far tile
      ]),
    });
  }

  it("gives a nearby tile full detail while a distant tile falls back to a coarser tier", () => {
    const tiled = TiledPointCloudLodPyramid.build(makeTwoTileCloud(), specs, { enabled: true, tileSize: 10 });
    expect(tiled.tiles.length).toBe(2);

    const selections = tiled.selectForCameraPosition(0, 0);
    const nearSelection = selections.find((s) => s.tile.bounds.min[0] < 10)!;
    const farSelection = selections.find((s) => s.tile.bounds.min[0] >= 10)!;
    expect(nearSelection.tier.id).toBe("full");
    expect(farSelection.tier.id).toBe("coarse");
  });

  it("treats tiling as a single whole-cloud tile when disabled", () => {
    const tiled = TiledPointCloudLodPyramid.build(makeTwoTileCloud(), specs, { enabled: false, tileSize: 10 });
    expect(tiled.tiles.length).toBe(1);
    expect(tiled.totalPointCount).toBe(6);
  });

  it("distributes a point budget across tiles proportional to their share of points", () => {
    const tiled = TiledPointCloudLodPyramid.build(makeTwoTileCloud(), specs, { enabled: true, tileSize: 10 });
    const selections = tiled.selectForPointBudget(6);
    for (const selection of selections) expect(selection.tier.id).toBe("full");
  });
});
