import { describe, expect, it } from "vitest";
import { PointCloud } from "../src/core/point-cloud.js";
import { defaultNoiseDetectionOptions, detectNoise, highNoiseClass, lowNoiseClass } from "../src/core/noise-detection.js";
import { withoutNoise } from "../src/export/clean.js";

/** A 40 × 40 m field sampled every 0.25 m, with whatever extra points a test adds on top. */
function field(extra: ReadonlyArray<readonly [number, number, number]>): PointCloud {
  const points: number[] = [];
  for (let x = 0; x < 40; x += 0.25) for (let z = 0; z < 40; z += 0.25) points.push(x, 0.02 * Math.sin(x + z), z);
  for (const point of extra) points.push(...point);
  return new PointCloud({ positions: new Float32Array(points) });
}

describe("detectNoise", () => {
  it("labels a bird above the ground as high noise and a multipath return below it as low noise", () => {
    const cloud = field([
      [20, 25, 20],
      [10, -3, 10],
    ]);
    const { classification, stats } = detectNoise({ positions: cloud.positions, bounds: cloud.bounds });
    const bird = cloud.pointCount - 2;
    const multipath = cloud.pointCount - 1;
    expect(classification[bird]).toBe(highNoiseClass);
    expect(classification[multipath]).toBe(lowNoiseClass);
    expect(stats.total).toBe(2);
  });

  it("keeps a sparse line of returns, like a conductor, that a statistical filter would drop", () => {
    // Points every 0.5 m along a wire 12 m up: far sparser than the ground, but never alone.
    const wire: Array<[number, number, number]> = [];
    for (let x = 2; x < 38; x += 0.5) wire.push([x, 12 - 0.004 * (x - 20) ** 2, 18]);
    const cloud = field(wire);
    const { classification } = detectNoise({ positions: cloud.positions, bounds: cloud.bounds });
    for (let index = cloud.pointCount - wire.length; index < cloud.pointCount; index += 1) expect(classification[index]).toBe(0);
  });

  it("keeps labels already in the file and counts noise already marked", () => {
    const cloud = field([[20, 25, 20]]);
    const existing = new Uint8Array(cloud.pointCount).fill(2);
    existing[5] = lowNoiseClass;
    const { classification, stats } = detectNoise({ positions: cloud.positions, bounds: cloud.bounds, classification: existing });
    expect(classification[0]).toBe(2);
    expect(classification[5]).toBe(lowNoiseClass);
    expect(stats.alreadyLabelled).toBe(1);
    expect(stats.isolatedHigh).toBe(1);
  });

  it("rejects options that cannot work", () => {
    const cloud = field([]);
    expect(() => detectNoise({ positions: cloud.positions, bounds: cloud.bounds }, { ...defaultNoiseDetectionOptions, lowThreshold: 0 })).toThrow();
  });
});

describe("withoutNoise", () => {
  it("drops exactly the noise and carries every other channel across", () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
    const cloud = new PointCloud({
      positions,
      colors: new Uint8Array([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]),
      intensity: new Float32Array([10, 20, 30, 40]),
      classification: new Uint8Array([2, highNoiseClass, 6, lowNoiseClass]),
    });
    const cleaned = withoutNoise(cloud);
    expect(cleaned.pointCount).toBe(2);
    expect(Array.from(cleaned.positions)).toEqual([0, 0, 0, 2, 2, 2]);
    expect(Array.from(cleaned.colors!)).toEqual([1, 1, 1, 3, 3, 3]);
    expect(Array.from(cleaned.intensity!)).toEqual([10, 30]);
    expect(Array.from(cleaned.classification!)).toEqual([2, 6]);
  });
});
