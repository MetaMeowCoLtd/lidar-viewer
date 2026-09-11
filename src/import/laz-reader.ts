import type { LazPerf as LazPerfModule } from "laz-perf";
import type { PointCloud } from "../core/point-cloud.js";
import { layoutForPointFormat, type LasHeader } from "./las-header.js";
import { LasPointBuilder, colorScaleFromSamples } from "./las-point-builder.js";

let modulePromise: Promise<LazPerfModule> | undefined;

/**
 * The decompressor is a WebAssembly module plus its loader glue, a few hundred
 * kilobytes together. Both are pulled in dynamically on the first LAZ file, so
 * a session that only ever opens LAS or PLY never downloads either, and the
 * instantiated module is cached because building it again would be pure waste.
 */
function loadLazPerf(): Promise<LazPerfModule> {
  const pending =
    modulePromise ??
    (async () => {
      const [{ createLazPerf }, wasm] = await Promise.all([
        import("laz-perf"),
        import("laz-perf/lib/laz-perf.wasm?url"),
      ]);
      return createLazPerf({ locateFile: () => wasm.default });
    })();
  modulePromise = pending;
  return pending;
}

/**
 * Reads a LAZ file by streaming it through laz-perf.
 *
 * Decompression is sequential: laz-perf hands back one record at a time into
 * a scratch slot in its own heap, and each record is decoded in place by the
 * shared builder. Nothing accumulates between the compressed input and the
 * destination buffers.
 */
export async function readLazPoints(buffer: ArrayBuffer, header: LasHeader, name: string): Promise<PointCloud> {
  const layout = layoutForPointFormat(header.pointFormat);
  if (layout === undefined) throw new Error(`Unsupported LAS point format ${header.pointFormat}`);

  const lazPerf = await loadLazPerf();
  const bytes = new Uint8Array(buffer);

  // laz-perf reads from its own heap, so the compressed file has to be copied
  // across the WebAssembly boundary once. It is freed as soon as the last
  // record is out.
  const filePointer = lazPerf._malloc(bytes.byteLength);
  let recordPointer = 0;
  try {
    lazPerf.HEAPU8.set(bytes, filePointer);

    const colorScale =
      layout.rgbOffset === undefined
        ? 1
        : colorScaleFromSamples(sampleMaximumChannel(lazPerf, filePointer, bytes.byteLength, layout.rgbOffset));

    const reader = new lazPerf.LASZip();
    try {
      reader.open(filePointer, bytes.byteLength);
      const recordLength = reader.getPointLength();
      const pointCount = Math.min(header.pointCount, reader.getCount());
      if (pointCount < 1) throw new Error("The LAZ file contains no readable point records");

      recordPointer = lazPerf._malloc(recordLength);
      const builder = new LasPointBuilder(header, name, colorScale);
      const scratch = new Uint8Array(recordLength);
      const record = new DataView(scratch.buffer);
      for (let point = 0; point < pointCount; point += 1) {
        reader.getPoint(recordPointer);
        copyRecord(lazPerf, recordPointer, scratch);
        builder.add(record, 0);
      }
      return builder.finish();
    } finally {
      reader.delete();
    }
  } finally {
    if (recordPointer !== 0) lazPerf._free(recordPointer);
    lazPerf._free(filePointer);
  }
}

/**
 * Decompresses a short prefix to decide whether this file's 16-bit colour
 * channels really hold 16-bit values. The stream only runs forwards, so this
 * opens its own reader and throws it away rather than disturbing the one that
 * does the real pass.
 */
function sampleMaximumChannel(
  lazPerf: LazPerfModule,
  filePointer: number,
  fileLength: number,
  rgbOffset: number,
): number {
  const reader = new lazPerf.LASZip();
  let recordPointer = 0;
  try {
    reader.open(filePointer, fileLength);
    const recordLength = reader.getPointLength();
    const sampleCount = Math.min(reader.getCount(), 4096);
    if (sampleCount < 1) return 0;

    recordPointer = lazPerf._malloc(recordLength);
    const scratch = new Uint8Array(recordLength);
    const record = new DataView(scratch.buffer);
    let maximum = 0;
    for (let point = 0; point < sampleCount; point += 1) {
      reader.getPoint(recordPointer);
      copyRecord(lazPerf, recordPointer, scratch);
      maximum = Math.max(
        maximum,
        record.getUint16(rgbOffset, true),
        record.getUint16(rgbOffset + 2, true),
        record.getUint16(rgbOffset + 4, true),
      );
      if (maximum > 255) return maximum;
    }
    return maximum;
  } finally {
    if (recordPointer !== 0) lazPerf._free(recordPointer);
    reader.delete();
  }
}

/**
 * Copies one decompressed record out of the WebAssembly heap.
 *
 * A view held directly over that heap cannot be reused across calls: laz-perf
 * allocates while it decodes, and any growth reallocates the module's memory
 * and detaches every view onto the old buffer. Reading `HEAPU8` fresh each
 * time and copying the record - a few dozen bytes - into a JavaScript-side
 * buffer is both safe and cheaper than rebuilding a view per point.
 */
function copyRecord(lazPerf: LazPerfModule, recordPointer: number, scratch: Uint8Array): void {
  scratch.set(lazPerf.HEAPU8.subarray(recordPointer, recordPointer + scratch.length));
}
