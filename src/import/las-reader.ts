import type { PointCloud } from "../core/point-cloud.js";
import type { ByteSource } from "./byte-source.js";
import { layoutForPointFormat, type LasHeader } from "./las-header.js";
import { LasPointBuilder, colorScaleFromSamples } from "./las-point-builder.js";
import { readLasSpatialReference } from "./las-records.js";

/** Reports how much of a scan has been read, from zero to one. */
export type ReadProgress = (fraction: number) => void;

/** Bytes of point records decoded per read; small enough to stay cheap, large enough to keep reads few. */
const blockBytes = 16 * 1024 * 1024;

/**
 * Reads uncompressed LAS point records.
 *
 * Records are fixed width, so the file is walked a block at a time: each block
 * is read, decoded straight into the destination arrays, and released before
 * the next. Memory holds the points being built and one block of the file,
 * never the file itself.
 */
export async function readLasPoints(source: ByteSource, header: LasHeader, name: string, onProgress?: ReadProgress): Promise<PointCloud> {
  const layout = layoutForPointFormat(header.pointFormat);
  if (layout === undefined) throw new Error(`Unsupported LAS point format ${header.pointFormat}`);

  const available = source.size - header.pointDataOffset;
  if (available < header.pointLength) throw new Error("The LAS file contains no readable point records");

  // A truncated download is common enough to be worth surviving: read what is
  // actually present rather than running off the end of the file.
  const readable = Math.min(header.pointCount, Math.floor(available / header.pointLength));

  const colorScale =
    layout.rgbOffset === undefined
      ? 1
      : colorScaleFromSamples(await sampleMaximumChannel(source, header, readable, layout.rgbOffset));

  const builder = new LasPointBuilder(header, name, colorScale, await readLasSpatialReference(source, header));
  const recordsPerBlock = Math.max(1, Math.floor(blockBytes / header.pointLength));
  for (let first = 0; first < readable; first += recordsPerBlock) {
    const count = Math.min(recordsPerBlock, readable - first);
    const block = await source.read(header.pointDataOffset + first * header.pointLength, count * header.pointLength);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let record = 0, base = 0; record < count; record += 1, base += header.pointLength) {
      builder.add(view, base);
    }
    onProgress?.((first + count) / readable);
  }
  return builder.finish();
}

/**
 * Finds the largest colour channel across evenly spaced runs of records, which
 * is what decides whether this file's 16-bit channels really hold 16-bit
 * values. A sample is enough because the question is only which of two ranges
 * is in use, and a file mixing both is malformed either way. Runs rather than
 * single records keep the number of reads small.
 */
async function sampleMaximumChannel(source: ByteSource, header: LasHeader, pointCount: number, rgbOffset: number): Promise<number> {
  const runs = Math.min(64, pointCount);
  const runLength = Math.min(64, Math.floor(pointCount / runs));
  let maximum = 0;
  for (let run = 0; run < runs; run += 1) {
    const first = Math.floor((run * pointCount) / runs);
    const block = await source.read(header.pointDataOffset + first * header.pointLength, runLength * header.pointLength);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let base = 0; base + header.pointLength <= block.byteLength; base += header.pointLength) {
      const rgb = base + rgbOffset;
      maximum = Math.max(maximum, view.getUint16(rgb, true), view.getUint16(rgb + 2, true), view.getUint16(rgb + 4, true));
      if (maximum > 255) return maximum;
    }
  }
  return maximum;
}
