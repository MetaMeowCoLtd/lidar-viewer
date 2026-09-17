import { describe, expect, it } from "vitest";
import { PointCloud, describePoint, measureBetween } from "../src/index.js";

describe("point inspection", () => {
  const cloud = new PointCloud({
    positions: new Float32Array([1.5, 20.25, -3, 0, 0, 0]),
    colors: new Uint8Array([10, 20, 30, 0, 0, 0]),
    intensity: new Float32Array([812, 0]),
    classification: new Uint8Array([6, 2]),
    returnNumber: new Uint8Array([1, 2]),
    numberOfReturns: new Uint8Array([1, 3]),
    heightAboveGround: new Float32Array([18.25, 0]),
    objectId: new Uint32Array([4, 0]),
    origin: [543_000, 30, -4_179_000],
  });

  it("reports a point in map coordinates with every channel the cloud carries", () => {
    expect(describePoint(cloud, 0)).toEqual({
      local: [1.5, 20.25, -3],
      map: [543_001.5, 4_179_003, 50.25],
      classification: 6,
      heightAboveGround: 18.25,
      objectId: 4,
      intensity: 812,
      returnNumber: 1,
      numberOfReturns: 1,
      color: [10, 20, 30],
    });
  });

  it("leaves out the object for a point that belongs to none, and channels the cloud lacks", () => {
    expect(describePoint(cloud, 1).objectId).toBeUndefined();
    const bare = describePoint(new PointCloud({ positions: new Float32Array([1, 2, 3]) }), 0);
    expect(bare).toEqual({ local: [1, 2, 3], map: [1, -3, 2] });
    expect(() => describePoint(cloud, 2)).toThrow(/index/);
  });

  it("measures straight-line, horizontal and vertical distance, and slope", () => {
    const measurement = measureBetween({ map: [100, 200, 10] }, { map: [103, 204, 15] });
    expect(measurement.horizontal).toBeCloseTo(5, 10);
    expect(measurement.vertical).toBeCloseTo(5, 10);
    expect(measurement.distance).toBeCloseTo(Math.SQRT2 * 5, 10);
    expect(measurement.slopeDegrees).toBeCloseTo(45, 10);
    expect(measureBetween({ map: [0, 0, 12] }, { map: [0, 0, 2] })).toEqual({ distance: 10, horizontal: 0, vertical: -10, slopeDegrees: 90 });
    expect(measureBetween({ map: [5, 5, 5] }, { map: [5, 5, 5] }).slopeDegrees).toBe(0);
  });

  it("keeps centimetres at projected magnitude", () => {
    const measurement = measureBetween({ map: [543_210.12, 4_179_876.54, 31.2] }, { map: [543_210.15, 4_179_876.58, 31.2] });
    expect(measurement.distance).toBeCloseTo(0.05, 6);
  });
});
