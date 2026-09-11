import { describe, expect, it } from "vitest";
import {
  PointCloud,
  PointCloudLodPyramid,
  PointCloudSession,
  PointCloudTiler,
  ProceduralCloudGenerator,
  TiledPointCloudLodPyramid,
  distanceToBounds,
  VoxelGridDownsampler,
  chooseOrigin,
  calculateBounds,
} from "../src/index.js";
import { readBinaryPly } from "../src/import/binary-ply-reader.js";
import { readLasHeader, layoutForPointFormat } from "../src/import/las-header.js";
import { readLasPoints } from "../src/import/las-reader.js";
import { classificationName, classificationColor, classificationPaletteBytes } from "../src/core/point-cloud-classification.js";

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
    const tiled = TiledPointCloudLodPyramid.build(makeTwoTileCloud(), specs, { enabled: true, targetPointsPerTile: 3 });
    expect(tiled.tiles.length).toBe(2);

    const selections = tiled.selectForCameraPosition(0, 0, 0);
    const nearSelection = selections.find((s) => s.tile.bounds.min[0] < 10)!;
    const farSelection = selections.find((s) => s.tile.bounds.min[0] >= 10)!;
    expect(nearSelection.tier.id).toBe("full");
    expect(farSelection.tier.id).toBe("coarse");
  });

  it("treats tiling as a single whole-cloud tile when disabled", () => {
    const tiled = TiledPointCloudLodPyramid.build(makeTwoTileCloud(), specs, { enabled: false, targetPointsPerTile: 3 });
    expect(tiled.tiles.length).toBe(1);
    expect(tiled.totalPointCount).toBe(6);
  });

  it("distributes a point budget across tiles proportional to their share of points", () => {
    const tiled = TiledPointCloudLodPyramid.build(makeTwoTileCloud(), specs, { enabled: true, targetPointsPerTile: 3 });
    const selections = tiled.selectForPointBudget(6);
    for (const selection of selections) expect(selection.tier.id).toBe("full");
  });
});

describe("distanceToBounds", () => {
  const bounds = new PointCloud({
    positions: new Float32Array([0, 0, 0, 10, 4, 10]),
  }).bounds;

  it("is zero inside the box and the gap outside it", () => {
    expect(distanceToBounds(5, 2, 5, bounds)).toBe(0);
    expect(distanceToBounds(13, 2, 5, bounds)).toBeCloseTo(3);
  });

  it("counts camera height, so looking straight down is not treated as being on top of a tile", () => {
    expect(distanceToBounds(5, 104, 5, bounds)).toBeCloseTo(100);
  });
});

describe("tile sizing", () => {
  function grid(pointCount: number): PointCloud {
    const positions = new Float32Array(pointCount * 3);
    for (let point = 0; point < pointCount; point += 1) {
      positions[point * 3] = (point % 100) * 10;
      positions[point * 3 + 2] = Math.floor(point / 100) * 10;
    }
    return new PointCloud({ positions });
  }

  it("leaves a cloud under the target in a single tile", () => {
    const tiled = TiledPointCloudLodPyramid.build(grid(400), [{ id: "full", voxelSize: 0 }], {
      enabled: true,
      targetPointsPerTile: 1_000,
    });
    expect(tiled.tiles.length).toBe(1);
  });

  it("splits a larger cloud into roughly one tile per target and keeps every point", () => {
    const cloud = grid(10_000);
    const tiled = TiledPointCloudLodPyramid.build(cloud, [{ id: "full", voxelSize: 0 }], {
      enabled: true,
      targetPointsPerTile: 1_000,
    });
    expect(tiled.tiles.length).toBeGreaterThan(1);
    expect(tiled.totalPointCount).toBe(cloud.pointCount);
  });
});


describe("georeferenced clouds", () => {
  it("defaults to the world origin and rejects a malformed one", () => {
    const positions = new Float32Array([0, 0, 0]);
    expect(new PointCloud({ positions }).origin).toEqual([0, 0, 0]);
    expect(new PointCloud({ positions }).isGeoreferenced).toBe(false);
    expect(() => new PointCloud({ positions, origin: [0, Number.NaN, 0] })).toThrow(/three finite numbers/);
  });

  it("resolves local positions and bounds back to world coordinates", () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 10, 4, -6]),
      origin: [543000, 0, 4179000],
    });
    expect(cloud.isGeoreferenced).toBe(true);
    expect(cloud.worldPosition(1)).toEqual([543010, 4, 4178994]);
    expect(cloud.worldBounds().min).toEqual([543000, 0, 4178994]);
    expect(cloud.worldBounds().max).toEqual([543010, 4, 4179000]);
    expect(() => cloud.worldPosition(2)).toThrow(/address a point/);
  });

  it("snaps a chosen origin down to a round step near the data centre", () => {
    expect(chooseOrigin([543200, 10, 4179100], [543400, 30, 4179300])).toEqual([543000, 0, 4179000]);
    expect(chooseOrigin([-5, -5, -5], [5, 5, 5])).toEqual([0, 0, 0]);
  });

  it("carries the frame through decimation so tiers stay aligned", () => {
    const source = new PointCloud({
      positions: new Float32Array([0, 0, 0, 0.2, 0.2, 0.2, 5, 5, 5]),
      origin: [543000, 0, 4179000],
    });
    expect(new VoxelGridDownsampler().downsample(source, { voxelSize: 1 }).origin).toEqual(source.origin);
  });

  it("carries the frame onto every tile so tiles stay comparable", () => {
    const source = new PointCloud({
      positions: new Float32Array([0, 0, 0, 9, 0, 9]),
      origin: [543000, 0, 4179000],
    });
    const tiles = new PointCloudTiler().tile(source, { tileSize: 5 });
    expect(tiles.length).toBeGreaterThan(1);
    for (const tile of tiles) expect(tile.cloud.origin).toEqual(source.origin);
  });
});

describe("binary PLY reader precision", () => {
  const eastings = [543210.001, 543210.002, 543210.003];

  it("keeps millimetre detail that Float32 world coordinates would destroy", () => {
    const cloud = readBinaryPly(buildDoublePly(eastings), "utm-scan")!;
    expect(cloud).toBeDefined();
    expect(cloud.origin).toEqual([543000, 4179000, 0]);

    // The failure this guards against: at UTM magnitude a Float32 step is
    // about 6cm, so storing these coordinates absolutely collapses all three
    // onto one value and the scan visibly snaps to a grid.
    expect(new Set(eastings.map((value) => Math.fround(value))).size).toBe(1);

    const readBack = eastings.map((_, index) => cloud.worldPosition(index)[0]);
    expect(new Set(readBack).size).toBe(3);
    for (const [index, expected] of eastings.entries()) {
      expect(readBack[index]!).toBeCloseTo(expected, 4);
    }
  });

  it("reports bounds in the local frame it established", () => {
    const cloud = readBinaryPly(buildDoublePly(eastings), "utm-scan")!;
    expect(cloud.bounds.min[0]).toBeCloseTo(210.001, 4);
    expect(cloud.bounds.max[0]).toBeCloseTo(210.003, 4);
    expect(cloud.bounds.diagonal).toBeLessThan(1);
  });
});

/** A minimal little-endian binary PLY with double xyz, at projected magnitude. */
function buildDoublePly(eastings: readonly number[]): ArrayBuffer {
  const header = `ply
format binary_little_endian 1.0
element vertex ${eastings.length}
property double x
property double y
property double z
end_header
`;
  const headerBytes = new TextEncoder().encode(header);
  const buffer = new ArrayBuffer(headerBytes.length + eastings.length * 24);
  new Uint8Array(buffer).set(headerBytes);
  const view = new DataView(buffer, headerBytes.length);
  eastings.forEach((easting, index) => {
    view.setFloat64(index * 24, easting, true);
    view.setFloat64(index * 24 + 8, 4179000.5, true);
    view.setFloat64(index * 24 + 16, 12.25, true);
  });
  return buffer;
}


describe("LAS header", () => {
  it("reads scale, offset, extent and record geometry", () => {
    const header = readLasHeader(buildLas())!;
    expect(header).toBeDefined();
    expect([header.versionMajor, header.versionMinor]).toEqual([1, 2]);
    expect(header.pointFormat).toBe(2);
    expect(header.pointLength).toBe(26);
    expect(header.pointCount).toBe(2);
    expect(header.isCompressed).toBe(false);
    expect(header.scale).toEqual([0.001, 0.001, 0.001]);
    expect(header.offset).toEqual([543000, 4179000, 0]);
    expect(header.min).toEqual([543010.5, 4178900.25, 20.5]);
    expect(header.max).toEqual([543210.5, 4179100.75, 35.25]);
  });

  it("recognises the LAZ compression flag without changing the format id", () => {
    const header = readLasHeader(buildLas({ compressed: true }))!;
    expect(header.isCompressed).toBe(true);
    expect(header.pointFormat).toBe(2);
  });

  it("declines anything it cannot walk", () => {
    expect(readLasHeader(new ArrayBuffer(8))).toBeUndefined();
    expect(readLasHeader(buildLas({ signature: "PLYX" }))).toBeUndefined();
    expect(readLasHeader(buildLas({ scale: 0 }))).toBeUndefined();
    expect(readLasHeader(buildLas({ pointFormat: 99 }))).toBeUndefined();
  });

  it("knows the standard record length of every point format", () => {
    const lengths = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
    lengths.forEach((length, format) => {
      expect(layoutForPointFormat(format)!.standardLength).toBe(length);
    });
    expect(layoutForPointFormat(11)).toBeUndefined();
  });
});

describe("LAS point reading", () => {
  it("rebuilds world coordinates from scaled integers without a Float32 round trip", () => {
    const cloud = readLasPoints(buildLas(), readLasHeader(buildLas())!, "scan");
    expect(cloud.pointCount).toBe(2);
    expect(cloud.origin).toEqual([543000, 0, -4179000]);
    expect(cloud.worldPosition(0)).toEqual([543010.5, 20.5, -4178900.25]);
    expect(cloud.worldPosition(1)).toEqual([543210.5, 35.25, -4179100.75]);
  });

  it("moves elevation onto the viewer's up axis and keeps the frame right-handed", () => {
    const cloud = readLasPoints(buildLas(), readLasHeader(buildLas())!, "scan");
    // Elevation spans 14.75m against 200m east and 200.5m north, so the short
    // span landing on y is what proves the axes were not simply relabelled.
    expect(cloud.bounds.min).toEqual([10.5, 20.5, -100.75]);
    expect(cloud.bounds.max).toEqual([210.5, 35.25, 99.75]);
    // North is negated rather than dropped: the northern point sits at -z.
    expect(cloud.positions[5]).toBeLessThan(cloud.positions[2]!);
  });

  it("carries intensity through unscaled", () => {
    const cloud = readLasPoints(buildLas(), readLasHeader(buildLas())!, "scan");
    expect([...cloud.intensity!]).toEqual([1234, 5678]);
  });

  it("normalises colour whether the file stores 16-bit or 8-bit channels", () => {
    for (const colorMultiplier of [257, 1]) {
      const buffer = buildLas({ colorMultiplier });
      const cloud = readLasPoints(buffer, readLasHeader(buffer)!, "scan");
      expect([...cloud.colors!]).toEqual([10, 20, 30, 40, 50, 60]);
    }
  });

  it("reads the records that are present when a file is truncated", () => {
    const full = buildLas();
    const cut = full.slice(0, full.byteLength - 26);
    const cloud = readLasPoints(cut, readLasHeader(cut)!, "scan");
    expect(cloud.pointCount).toBe(1);
    expect(cloud.worldPosition(0)).toEqual([543010.5, 20.5, -4178900.25]);
  });
});

interface LasFixtureOptions {
  readonly compressed?: boolean;
  readonly signature?: string;
  readonly scale?: number;
  readonly pointFormat?: number;
  readonly colorMultiplier?: number;
}

/**
 * A minimal LAS 1.2 file with two point-format-2 records, in LAS axes
 * (east, north, up) at projected magnitude.
 */
function buildLas(options: LasFixtureOptions = {}): ArrayBuffer {
  const { compressed = false, signature = "LASF", scale = 0.001, pointFormat = 2, colorMultiplier = 257 } = options;
  const headerSize = 227;
  const recordLength = 26;
  const points = [
    { east: 543010.5, north: 4178900.25, up: 20.5, rgb: [10, 20, 30], intensity: 1234, classification: 2, returnNumber: 1, numberOfReturns: 1 },
    { east: 543210.5, north: 4179100.75, up: 35.25, rgb: [40, 50, 60], intensity: 5678, classification: 6, returnNumber: 2, numberOfReturns: 3 },
  ];
  const offsets = [543000, 4179000, 0];

  const buffer = new ArrayBuffer(headerSize + points.length * recordLength);
  const view = new DataView(buffer);
  for (let index = 0; index < 4; index += 1) view.setUint8(index, signature.charCodeAt(index));
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint8(104, compressed ? pointFormat | 0x80 : pointFormat);
  view.setUint16(105, recordLength, true);
  view.setUint32(107, points.length, true);
  for (let axis = 0; axis < 3; axis += 1) {
    view.setFloat64(131 + axis * 8, scale, true);
    view.setFloat64(155 + axis * 8, offsets[axis]!, true);
  }
  const easts = points.map((point) => point.east);
  const norths = points.map((point) => point.north);
  const ups = points.map((point) => point.up);
  const extent = [[easts, 179, 187], [norths, 195, 203], [ups, 211, 219]] as const;
  for (const [values, maxAt, minAt] of extent) {
    view.setFloat64(maxAt, Math.max(...values), true);
    view.setFloat64(minAt, Math.min(...values), true);
  }

  points.forEach((point, index) => {
    const base = headerSize + index * recordLength;
    const safeScale = scale === 0 ? 1 : scale;
    view.setInt32(base, Math.round((point.east - offsets[0]!) / safeScale), true);
    view.setInt32(base + 4, Math.round((point.north - offsets[1]!) / safeScale), true);
    view.setInt32(base + 8, Math.round((point.up - offsets[2]!) / safeScale), true);
    view.setUint16(base + 12, point.intensity, true);
    view.setUint8(base + 14, point.returnNumber | (point.numberOfReturns << 3));
    // Top three bits are the synthetic, key-point and withheld flags in this
    // format family; setting them proves the reader masks them off.
    view.setUint8(base + 15, point.classification | 0xe0);
    point.rgb.forEach((channel, axis) => {
      view.setUint16(base + 20 + axis * 2, channel * colorMultiplier, true);
    });
  });
  return buffer;
}


describe("classification and return fields", () => {
  it("unpacks the class from a legacy record without its flag bits", () => {
    const buffer = buildLas();
    const cloud = readLasPoints(buffer, readLasHeader(buffer)!, "scan");
    expect([...cloud.classification!]).toEqual([2, 6]);
  });

  it("unpacks return number and return count from the byte they share", () => {
    const buffer = buildLas();
    const cloud = readLasPoints(buffer, readLasHeader(buffer)!, "scan");
    expect([...cloud.returnNumber!]).toEqual([1, 2]);
    expect([...cloud.numberOfReturns!]).toEqual([1, 3]);
  });

  it("gives formats 6 and up the whole classification byte and a wider return field", () => {
    expect(layoutForPointFormat(3)!.classificationMask).toBe(0x1f);
    expect(layoutForPointFormat(3)!.returnBits).toBe(3);
    expect(layoutForPointFormat(7)!.classificationOffset).toBe(16);
    expect(layoutForPointFormat(7)!.classificationMask).toBe(0xff);
    expect(layoutForPointFormat(7)!.returnBits).toBe(4);
  });

  it("counts points per class, most populated first", () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      classification: new Uint8Array([6, 2, 6, 6]),
    });
    expect(cloud.classificationHistogram()).toEqual([
      { code: 6, count: 3 },
      { code: 2, count: 1 },
    ]);
    expect(cloud.supportsColorMode("classification")).toBe(true);
    expect(new PointCloud({ positions: new Float32Array([0, 0, 0]) }).supportsColorMode("classification")).toBe(false);
  });

  it("rejects a class channel that does not match the point count", () => {
    expect(
      () => new PointCloud({ positions: new Float32Array([0, 0, 0, 1, 1, 1]), classification: new Uint8Array([2]) }),
    ).toThrow(/classification must contain one value per point/);
  });

  it("names the standard classes and falls back for vendor codes", () => {
    expect(classificationName(2)).toBe("Ground");
    expect(classificationName(6)).toBe("Building");
    expect(classificationName(14)).toBe("Wire, conductor");
    expect(classificationName(200)).toBe("Class 200");
    expect(classificationColor(200)).toBe(classificationColor(201));
    expect(classificationPaletteBytes()).toHaveLength(256 * 3);
  });
});

describe("decimating categorical channels", () => {
  const positions = new Float32Array([0, 0, 0, 0.2, 0.2, 0.2, 0.4, 0.4, 0.4, 5, 5, 5]);

  it("takes the majority class in a voxel instead of averaging codes", () => {
    const cloud = new PointCloud({
      positions,
      // Averaging 2, 6 and 6 would give 4.67, rounding to Medium vegetation:
      // a class that describes none of the three source points.
      classification: new Uint8Array([2, 6, 6, 9]),
    });
    const decimated = new VoxelGridDownsampler().downsample(cloud, { voxelSize: 1 });
    expect(decimated.pointCount).toBe(2);
    expect([...decimated.classification!]).toEqual([6, 9]);
  });

  it("only ever emits a code that was present in the voxel", () => {
    const cloud = new PointCloud({ positions, classification: new Uint8Array([2, 6, 9, 11]) });
    const decimated = new VoxelGridDownsampler().downsample(cloud, { voxelSize: 1 });
    for (const code of decimated.classification!) expect([2, 6, 9, 11]).toContain(code);
  });

  it("votes on the return fields too, and still averages the continuous ones", () => {
    const cloud = new PointCloud({
      positions,
      intensity: new Float32Array([10, 20, 30, 99]),
      returnNumber: new Uint8Array([1, 1, 2, 4]),
      numberOfReturns: new Uint8Array([3, 3, 3, 4]),
    });
    const decimated = new VoxelGridDownsampler().downsample(cloud, { voxelSize: 1 });
    expect([...decimated.returnNumber!]).toEqual([1, 4]);
    expect([...decimated.numberOfReturns!]).toEqual([3, 4]);
    expect(decimated.intensity![0]).toBeCloseTo(20, 6);
  });

  it("leaves a cloud without those channels without them", () => {
    const cloud = new PointCloud({ positions });
    const decimated = new VoxelGridDownsampler().downsample(cloud, { voxelSize: 1 });
    expect(decimated.classification).toBeUndefined();
    expect(decimated.returnNumber).toBeUndefined();
  });

  it("partitions the channels across tiles without losing a point", () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 9, 0, 9, 1, 0, 1, 8, 0, 8]),
      classification: new Uint8Array([2, 6, 2, 6]),
      returnNumber: new Uint8Array([1, 2, 3, 4]),
    });
    const tiles = new PointCloudTiler().tile(cloud, { tileSize: 5 });
    const classes: number[] = [];
    const returns: number[] = [];
    for (const tile of tiles) {
      expect(tile.cloud.classification).toBeDefined();
      classes.push(...tile.cloud.classification!);
      returns.push(...tile.cloud.returnNumber!);
    }
    expect(classes.sort()).toEqual([2, 2, 6, 6]);
    expect(returns.sort()).toEqual([1, 2, 3, 4]);
  });
});


describe("bounds bracket their own points", () => {
  it("measures the stored Float32, so no point falls outside a LAS cloud's bounds", () => {
    const buffer = buildLas();
    const cloud = readLasPoints(buffer, readLasHeader(buffer)!, "scan");
    expectEveryPointInsideBounds(cloud);
  });

  it("does the same for the binary PLY path", () => {
    const cloud = readBinaryPly(buildDoublePly([543210.001, 543210.002, 543210.003]), "scan")!;
    expectEveryPointInsideBounds(cloud);
  });

  it("keeps every point when one sits fractionally outside the declared bounds", () => {
    // A cloud whose bounds under-report its own extent, which is what
    // narrowing to Float32 can produce. The partition must still be total.
    const positions = new Float32Array([0, 0, 0, 4, 0, 4, 9, 0, 9]);
    const honest = calculateBounds(positions);
    const shrunk = {
      ...honest,
      min: [honest.min[0] + 0.001, honest.min[1], honest.min[2] + 0.001] as [number, number, number],
    };
    const cloud = new PointCloud({ positions, bounds: shrunk });
    const tiles = new PointCloudTiler().tile(cloud, { tileSize: 5 });
    expect(tiles.reduce((sum, tile) => sum + tile.cloud.pointCount, 0)).toBe(3);
  });
});

function expectEveryPointInsideBounds(cloud: PointCloud): void {
  for (let point = 0; point < cloud.pointCount; point += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = cloud.positions[point * 3 + axis]!;
      expect(value).toBeGreaterThanOrEqual(cloud.bounds.min[axis]!);
      expect(value).toBeLessThanOrEqual(cloud.bounds.max[axis]!);
    }
  }
}
