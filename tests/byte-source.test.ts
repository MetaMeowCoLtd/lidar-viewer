import { describe, expect, it } from "vitest";
import { blobSource, bufferSource } from "../src/import/byte-source.js";

describe("byte sources", () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);

  for (const [label, source] of [
    ["buffer", bufferSource(bytes.slice().buffer)],
    ["blob", blobSource(new Blob([bytes]))],
  ] as const) {
    it(`reads slices of a ${label}, clipped to its end`, async () => {
      expect(source.size).toBe(100);
      expect([...(await source.read(10, 4))]).toEqual([10, 11, 12, 13]);
      expect([...(await source.read(97, 10))]).toEqual([97, 98, 99]);
      expect((await source.read(150, 10)).byteLength).toBe(0);
      expect([...(await source.read(-5, 7))]).toEqual([0, 1]);
    });
  }
});
