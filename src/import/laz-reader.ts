import type { LazPerf as LazPerfModule } from "laz-perf";
import type { PointCloud } from "../core/point-cloud.js";
import { layoutForPointFormat, type LasHeader } from "./las-header.js";
import { LasPointBuilder, colorScaleFromSamples } from "./las-point-builder.js";
import { readLasSpatialReference } from "./las-records.js";
import type { ByteSource } from "./byte-source.js";
import { keptCount, type ReadOptions } from "./read-options.js";

/**
 * laz-perf's WebAssembly memory is capped at 2 GB, and the compressed file has
 * to fit inside it alongside the decoder's own state.
 */
export const maxLazBytes = 1.9 * 1024 * 1024 * 1024;
const copyBlockBytes = 64 * 1024 * 1024;
const progressInterval = 1 << 16;

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
export async function readLazPoints(source: ByteSource, header: LasHeader, name: string, options: ReadOptions = {}): Promise<PointCloud> {
  const { onProgress, keepEvery = 1 } = options;
  const layout = layoutForPointFormat(header.pointFormat);
  if (layout === undefined) throw new Error(`Unsupported LAS point format ${header.pointFormat}`);
  if (source.size > maxLazBytes) {
    throw new Error(
      `This LAZ file is ${formatGigabytes(source.size)}; the browser's LAZ decoder can hold up to ${formatGigabytes(maxLazBytes)}. ` +
        "Split it into tiles, or convert it to LAS, which has no such limit.",
    );
  }

  const lazPerf = await loadLazPerf();
  const spatialReference = await readLasSpatialReference(source, header);

  // laz-perf reads from its own heap, so the compressed file has to be copied
  // across the WebAssembly boundary once. It goes in a block at a time, so the
  // whole file never also sits in JavaScript memory. It is freed as soon as
  // the last record is out.
  const filePointer = lazPerf._malloc(source.size);
  if (filePointer === 0) throw new Error("There is not enough memory to decompress this LAZ file");
  let recordPointer = 0;
  try {
    for (let offset = 0; offset < source.size; offset += copyBlockBytes) {
      const block = await source.read(offset, copyBlockBytes);
      // Looked up after every await: growing the heap replaces this view.
      lazPerf.HEAPU8.set(block, filePointer + offset);
    }

    const colorScale =
      layout.rgbOffset === undefined
        ? 1
        : colorScaleFromSamples(sampleMaximumChannel(lazPerf, filePointer, source.size, layout.rgbOffset));

    const reader = new lazPerf.LASZip();
    try {
      reader.open(filePointer, source.size);
      const recordLength = reader.getPointLength();
      const pointCount = Math.min(header.pointCount, reader.getCount());
      if (pointCount < 1) throw new Error("The LAZ file contains no readable point records");

      recordPointer = lazPerf._malloc(recordLength);
      const builder = new LasPointBuilder(header, name, colorScale, spatialReference, keptCount(pointCount, keepEvery));
      const scratch = new Uint8Array(recordLength);
      const record = new DataView(scratch.buffer);
      for (let point = 0; point < pointCount; point += 1) {
        // Compressed records only decode in order, so thinning still decodes
        // every one and keeps a stride of them.
        reader.getPoint(recordPointer);
        if (point % keepEvery === 0) {
          copyRecord(lazPerf, recordPointer, scratch);
          builder.add(record, 0);
        }
        if ((point + 1) % progressInterval === 0) onProgress?.((point + 1) / pointCount);
      }
      onProgress?.(1);
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

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
