import { describe, expect, it } from "vitest";
import { PointCloud, writeLas } from "../src/index.js";
import { blobSource, type ByteSource } from "../src/import/byte-source.js";
import { importScan } from "../src/import/scan-file-importer.js";

/** A source that records the largest single read made from it. */
function measuredSource(source: ByteSource) {
  let largestRead = 0;
  let reads = 0;
  return {
    source: {
      size: source.size,
      read: (offset: number, length: number) => {
        largestRead = Math.max(largestRead, Math.min(length, source.size - offset));
        reads += 1;
        return source.read(offset, length);
      },
    } satisfies ByteSource,
    largestRead: () => largestRead,
    reads: () => reads,
  };
}

describe("streaming import", () => {
  it("reads a LAS file larger than one block without ever reading it whole", async () => {
    const pointCount = 700_000;
    const positions = new Float32Array(pointCount * 3);
    const classification = new Uint8Array(pointCount);
    for (let point = 0; point < pointCount; point += 1) {
      positions[point * 3] = (point % 1000) * 0.25;
      positions[point * 3 + 1] = (point % 97) * 0.5;
      positions[point * 3 + 2] = -Math.floor(point / 1000) * 0.25;
      classification[point] = point % 7;
    }
    const cloud = new PointCloud({ positions, classification, origin: [312_000, 0, -4_100_000] });
    const file = new Blob(writeLas(cloud) as BlobPart[]);
    expect(file.size).toBeGreaterThan(20 * 1024 * 1024);

    const measured = measuredSource(blobSource(file));
    const progress: number[] = [];
    const back = await importScan(measured.source, "streamed", (fraction) => progress.push(fraction));

    expect(back.pointCount).toBe(pointCount);
    expect(measured.largestRead()).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(measured.reads()).toBeGreaterThan(2);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(1);
    for (const point of [0, 1, 345_678, pointCount - 1]) {
      const expected = cloud.worldPosition(point);
      const actual = back.worldPosition(point);
      for (let axis = 0; axis < 3; axis += 1) expect(actual[axis]).toBeCloseTo(expected[axis]!, 3);
      expect(back.classification![point]).toBe(point % 7);
    }
  });

  it("rejects bytes that are no known scan format", async () => {
    const source = blobSource(new Blob([new Uint8Array(512).fill(7)]));
    await expect(importScan(source, "noise")).rejects.toThrow(/not a readable LAS, LAZ or PLY/);
  });
});
