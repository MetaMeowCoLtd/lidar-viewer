/**
 * LAS public header block and point record layout.
 *
 * Only the fields this viewer consumes are surfaced. The header is identical
 * in LAZ, which is why a LAZ file can be recognised and sized before any
 * decompression work starts.
 */
export interface LasHeader {
  readonly versionMajor: number;
  readonly versionMinor: number;
  /** Byte offset of the first point record. */
  readonly pointDataOffset: number;
  /** Format id with the compression flag stripped; 0 through 10. */
  readonly pointFormat: number;
  /**
   * Record stride declared by the header. A writer may append extra bytes
   * beyond the standard layout, so this is the stride to walk with, while
   * {@link LasPointLayout} only supplies field positions.
   */
  readonly pointLength: number;
  readonly pointCount: number;
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  /** Extent in LAS axes, taken from the header rather than the records. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly isCompressed: boolean;
}

export interface LasPointLayout {
  /** Length of the standard record, before any writer-specific extra bytes. */
  readonly standardLength: number;
  /** Byte position of the red channel, when the format carries colour. */
  readonly rgbOffset: number | undefined;
}

/**
 * Intensity sits immediately after the scaled xyz triple in every point
 * format, so it never needs a per-format entry.
 */
export const intensityOffset = 12;

const layouts: readonly (LasPointLayout | undefined)[] = [
  { standardLength: 20, rgbOffset: undefined },
  { standardLength: 28, rgbOffset: undefined },
  { standardLength: 26, rgbOffset: 20 },
  { standardLength: 34, rgbOffset: 28 },
  { standardLength: 57, rgbOffset: undefined },
  { standardLength: 63, rgbOffset: 28 },
  { standardLength: 30, rgbOffset: undefined },
  { standardLength: 36, rgbOffset: 30 },
  { standardLength: 38, rgbOffset: 30 },
  { standardLength: 59, rgbOffset: undefined },
  { standardLength: 67, rgbOffset: 30 },
];

export function layoutForPointFormat(pointFormat: number): LasPointLayout | undefined {
  return layouts[pointFormat];
}

/** Smallest prefix that can contain a complete LAS 1.0 public header block. */
export const minimumLasHeaderSize = 227;

/**
 * Parses the public header block. Returns undefined when the buffer is not
 * LAS at all, or declares something this reader cannot walk, so the caller can
 * report a useful error rather than producing a malformed cloud.
 */
export function readLasHeader(buffer: ArrayBuffer): LasHeader | undefined {
  if (buffer.byteLength < minimumLasHeaderSize) return undefined;
  const view = new DataView(buffer);
  const signature = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (signature !== "LASF") return undefined;

  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  const pointDataOffset = view.getUint32(96, true);
  if (headerSize < minimumLasHeaderSize || pointDataOffset < headerSize) return undefined;

  // LAZ sets the high bit of the point data format id and keeps everything
  // else about the header identical to LAS.
  const rawPointFormat = view.getUint8(104);
  const isCompressed = (rawPointFormat & 0x80) !== 0;
  const pointFormat = rawPointFormat & 0x3f;
  if (layoutForPointFormat(pointFormat) === undefined) return undefined;

  const pointLength = view.getUint16(105, true);
  const legacyPointCount = view.getUint32(107, true);

  // 1.4 moved the count to a 64-bit field and leaves the legacy one at zero
  // whenever the true count does not fit, or simply whenever the writer felt
  // like it, so prefer the wide field when the header is long enough to hold it.
  let pointCount = legacyPointCount;
  if (versionMajor >= 1 && versionMinor >= 4 && headerSize >= 375 && buffer.byteLength >= 255) {
    const widePointCount = Number(view.getBigUint64(247, true));
    if (widePointCount > 0) pointCount = widePointCount;
  }
  if (!Number.isSafeInteger(pointCount) || pointCount < 1) return undefined;

  const scale: [number, number, number] = [
    view.getFloat64(131, true),
    view.getFloat64(139, true),
    view.getFloat64(147, true),
  ];
  if (!scale.every((value) => Number.isFinite(value) && value !== 0)) return undefined;

  const offset: [number, number, number] = [
    view.getFloat64(155, true),
    view.getFloat64(163, true),
    view.getFloat64(171, true),
  ];
  if (!offset.every((value) => Number.isFinite(value))) return undefined;

  // The header stores each axis as max then min, which is the opposite of the
  // order almost every other format uses.
  const max: [number, number, number] = [
    view.getFloat64(179, true),
    view.getFloat64(195, true),
    view.getFloat64(211, true),
  ];
  const min: [number, number, number] = [
    view.getFloat64(187, true),
    view.getFloat64(203, true),
    view.getFloat64(219, true),
  ];

  return {
    versionMajor,
    versionMinor,
    pointDataOffset,
    pointFormat,
    pointLength,
    pointCount,
    scale,
    offset,
    min,
    max,
    isCompressed,
  };
}

/**
 * True when the header's own extent looks usable. Writers do get this wrong,
 * and it is only ever used to place the local frame, so a bad extent falls
 * back to the header offset rather than failing the load.
 */
export function hasUsableExtent(header: LasHeader): boolean {
  return header.min.every((value, axis) => Number.isFinite(value) && Number.isFinite(header.max[axis]!) && value <= header.max[axis]!);
}
