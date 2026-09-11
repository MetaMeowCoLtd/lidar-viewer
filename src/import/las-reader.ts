import type { PointCloud } from "../core/point-cloud.js";
import { layoutForPointFormat, type LasHeader } from "./las-header.js";
import { LasPointBuilder, colorScaleFromSamples } from "./las-point-builder.js";

/**
 * Reads uncompressed LAS point records. Records are fixed width and the file
 * is already in memory, so this is a single linear walk with no intermediate
 * allocation beyond the destination buffers.
 */
export function readLasPoints(buffer: ArrayBuffer, header: LasHeader, name: string): PointCloud {
  const layout = layoutForPointFormat(header.pointFormat);
  if (layout === undefined) throw new Error(`Unsupported LAS point format ${header.pointFormat}`);

  const available = buffer.byteLength - header.pointDataOffset;
  if (available < header.pointLength) throw new Error("The LAS file contains no readable point records");

  // A truncated download is common enough to be worth surviving: read what is
  // actually present rather than running off the end of the buffer.
  const readable = Math.min(header.pointCount, Math.floor(available / header.pointLength));
  const view = new DataView(buffer, header.pointDataOffset);

  const colorScale =
    layout.rgbOffset === undefined
      ? 1
      : colorScaleFromSamples(sampleMaximumChannel(view, header.pointLength, readable, layout.rgbOffset));

  const builder = new LasPointBuilder(header, name, colorScale);
  for (let point = 0, base = 0; point < readable; point += 1, base += header.pointLength) {
    builder.add(view, base);
  }
  return builder.finish();
}

/**
 * Finds the largest colour channel across an evenly spaced sample, which is
 * what decides whether this file's 16-bit channels really hold 16-bit values.
 * A sample is enough because the question is only which of two ranges is in
 * use, and a file mixing both is malformed either way.
 */
function sampleMaximumChannel(view: DataView, stride: number, pointCount: number, rgbOffset: number): number {
  const step = Math.max(1, Math.floor(pointCount / 4096));
  let maximum = 0;
  for (let point = 0; point < pointCount; point += step) {
    const rgb = point * stride + rgbOffset;
    maximum = Math.max(
      maximum,
      view.getUint16(rgb, true),
      view.getUint16(rgb + 2, true),
      view.getUint16(rgb + 4, true),
    );
    if (maximum > 255) return maximum;
  }
  return maximum;
}
