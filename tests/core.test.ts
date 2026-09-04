import { describe, expect, it } from "vitest";
import {
  PointCloud,
  PointCloudLodPyramid,
  PointCloudSession,
  ProceduralCloudGenerator,
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
