import { describe, expect, it } from "vitest";
import { PointCloud, writeLas } from "../src/index.js";
import { blobSource, type ByteSource } from "../src/import/byte-source.js";
import { importScan } from "../src/import/scan-file-importer.js";
import { keepEveryFor, keptCount } from "../src/import/read-options.js";

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
    const { cloud: back, sourcePointCount } = await importScan(measured.source, "streamed", { onProgress: (fraction) => progress.push(fraction) });
    expect(sourcePointCount).toBe(pointCount);

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

  it("thins a scan over the point limit evenly, keeping every n-th point", async () => {
    const pointCount = 70_000;
    const positions = new Float32Array(pointCount * 3).map((_, index) => (index % 3 === 0 ? Math.floor(index / 3) * 0.01 : 0));
    const cloud = new PointCloud({ positions });
    const file = new Blob(writeLas(cloud, { chunkPoints: 9_999 }) as BlobPart[]);

    const { cloud: thinned, sourcePointCount } = await importScan(blobSource(file), "thinned", { maxPoints: 10_000 });
    expect(sourcePointCount).toBe(pointCount);
    expect(thinned.pointCount).toBe(10_000);
    for (const kept of [0, 1, 5_000, 9_999]) {
      expect(thinned.worldPosition(kept)[0]).toBeCloseTo(kept * 7 * 0.01, 2);
    }
  });

  it("thins binary PLY the same way", async () => {
    const vertexCount = 50;
    const header = `ply
format binary_little_endian 1.0
element vertex ${vertexCount}
property float x
property float y
property float z
property float intensity
end_header
`;
    const body = new Float32Array(vertexCount * 4);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) body.set([vertex, 0, 0, vertex * 10], vertex * 4);
    const file = new Blob([header, body]);

    const { cloud, sourcePointCount } = await importScan(blobSource(file), "ply", { maxPoints: 10 });
    expect(sourcePointCount).toBe(50);
    expect(cloud.pointCount).toBe(10);
    expect([...cloud.intensity!]).toEqual([0, 50, 100, 150, 200, 250, 300, 350, 400, 450]);
  });

  it("works out the stride from the limit", () => {
    expect(keepEveryFor(100, undefined)).toBe(1);
    expect(keepEveryFor(100, 100)).toBe(1);
    expect(keepEveryFor(101, 100)).toBe(2);
    expect(keepEveryFor(60_000_001, 20_000_000)).toBe(4);
    expect(keptCount(101, 2)).toBe(51);
  });

  it("rejects bytes that are no known scan format", async () => {
    const source = blobSource(new Blob([new Uint8Array(512).fill(7)]));
    await expect(importScan(source, "noise")).rejects.toThrow(/not a readable LAS, LAZ or PLY/);
  });
});
