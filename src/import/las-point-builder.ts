import { PointCloud, boundsFromExtent, chooseOrigin, type PointCloudOrigin } from "../core/point-cloud.js";
import {
  intensityOffset,
  returnByteOffset,
  hasUsableExtent,
  layoutForPointFormat,
  type LasHeader,
} from "./las-header.js";

/**
 * Turns LAS point records into the core's point-cloud contract.
 *
 * Both the plain LAS reader and the LAZ reader feed this, so the record
 * layout, the coordinate maths and the axis convention are written once. The
 * only difference between them is where the bytes come from: a contiguous
 * view over the file, or one decompressed record at a time.
 *
 * Two conversions happen here.
 *
 * Coordinates are stored in a LAS file as 32-bit integers plus a
 * double-precision scale and offset, so the real coordinate only exists once
 * `value * scale + offset` has been evaluated - in doubles, at projected
 * magnitude. Narrowing that to Float32 is exactly the precision loss the
 * viewer's local frame exists to avoid, so the frame's origin is subtracted
 * inside the same double-precision expression.
 *
 * Axes are swapped from the LAS convention (x east, y north, z up) to the
 * viewer's (x east, y up, z south). Negating north rather than simply
 * relabelling the axes keeps the frame right-handed, so a scan does not come
 * out mirrored.
 *
 * Classification and the two return fields are read out of their bit packing
 * here as well. Return structure is the strongest single cue for telling
 * vegetation from a roof - a pulse passes through a canopy and comes back
 * several times, and bounces off a roof once - so it is worth carrying even
 * though nothing consumes it yet.
 */
export class LasPointBuilder {
  public readonly origin: PointCloudOrigin;

  private readonly positions: Float32Array;
  private readonly colors: Uint8Array | undefined;
  private readonly intensity: Float32Array;
  private readonly classification: Uint8Array;
  private readonly returnNumber: Uint8Array;
  private readonly numberOfReturns: Uint8Array;
  private readonly rgbOffset: number | undefined;
  private readonly classificationOffset: number;
  private readonly classificationMask: number;
  private readonly returnMask: number;
  private readonly returnBits: number;
  private readonly colorScale: number;
  private readonly scale: readonly [number, number, number];
  private readonly bias: readonly [number, number, number];
  private readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  private readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  private written = 0;

  public constructor(
    private readonly header: LasHeader,
    private readonly name: string,
    /** Divisor that brings this file's colour channels into the 0-255 range. */
    colorScale: number,
  ) {
    const layout = layoutForPointFormat(header.pointFormat);
    if (layout === undefined) throw new Error(`Unsupported LAS point format ${header.pointFormat}`);
    if (header.pointLength < layout.standardLength) {
      throw new Error("The LAS header declares a point record shorter than its own format");
    }

    this.origin = chooseLocalFrame(header);
    this.rgbOffset = layout.rgbOffset;
    this.classificationOffset = layout.classificationOffset;
    this.classificationMask = layout.classificationMask;
    this.returnBits = layout.returnBits;
    this.returnMask = (1 << layout.returnBits) - 1;
    this.colorScale = colorScale;

    const [scaleX, scaleY, scaleZ] = header.scale;
    const [offsetX, offsetY, offsetZ] = header.offset;
    this.scale = [scaleX, scaleZ, -scaleY];
    this.bias = [
      offsetX - this.origin[0],
      offsetZ - this.origin[1],
      -offsetY - this.origin[2],
    ];

    this.positions = new Float32Array(header.pointCount * 3);
    this.colors = layout.rgbOffset === undefined ? undefined : new Uint8Array(header.pointCount * 3);
    this.intensity = new Float32Array(header.pointCount);
    this.classification = new Uint8Array(header.pointCount);
    this.returnNumber = new Uint8Array(header.pointCount);
    this.numberOfReturns = new Uint8Array(header.pointCount);
  }

  /** Reads one record starting at `base` within `view`. */
  public add(view: DataView, base: number): void {
    if (this.written >= this.header.pointCount) return;
    const target = this.written * 3;

    this.positions[target] = view.getInt32(base, true) * this.scale[0] + this.bias[0];
    this.positions[target + 1] = view.getInt32(base + 8, true) * this.scale[1] + this.bias[1];
    this.positions[target + 2] = view.getInt32(base + 4, true) * this.scale[2] + this.bias[2];

    // Read the coordinates back out rather than measuring the doubles that
    // went in. Storing rounds to the nearest Float32, which can land a hair
    // outside the double's own value, and bounds that do not bracket their own
    // points put a point in a tile that was never counted.
    const x = this.positions[target]!;
    const y = this.positions[target + 1]!;
    const z = this.positions[target + 2]!;
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;

    this.intensity[this.written] = view.getUint16(base + intensityOffset, true);
    this.classification[this.written] = view.getUint8(base + this.classificationOffset) & this.classificationMask;
    const returns = view.getUint8(base + returnByteOffset);
    this.returnNumber[this.written] = returns & this.returnMask;
    this.numberOfReturns[this.written] = (returns >> this.returnBits) & this.returnMask;

    if (this.colors !== undefined && this.rgbOffset !== undefined) {
      const rgb = base + this.rgbOffset;
      this.colors[target] = view.getUint16(rgb, true) / this.colorScale;
      this.colors[target + 1] = view.getUint16(rgb + 2, true) / this.colorScale;
      this.colors[target + 2] = view.getUint16(rgb + 4, true) / this.colorScale;
    }

    this.written += 1;
  }

  public get pointsWritten(): number {
    return this.written;
  }

  public finish(): PointCloud {
    if (this.written === 0) throw new Error("The LAS file declared points but none could be read");
    const truncate = this.written < this.header.pointCount;
    return new PointCloud({
      positions: truncate ? this.positions.subarray(0, this.written * 3) : this.positions,
      ...(this.colors === undefined
        ? {}
        : { colors: truncate ? this.colors.subarray(0, this.written * 3) : this.colors }),
      intensity: truncate ? this.intensity.subarray(0, this.written) : this.intensity,
      classification: truncate ? this.classification.subarray(0, this.written) : this.classification,
      returnNumber: truncate ? this.returnNumber.subarray(0, this.written) : this.returnNumber,
      numberOfReturns: truncate ? this.numberOfReturns.subarray(0, this.written) : this.numberOfReturns,
      bounds: boundsFromExtent(this.min, this.max),
      origin: this.origin,
      name: this.name,
    });
  }
}

/**
 * Places the local frame from the header's declared extent, converted to
 * viewer axes. The anchor only has to land near the cloud, so a header whose
 * extent is missing or inverted falls back to the coordinate offset, which
 * every valid file carries and which sits near the data by construction.
 */
function chooseLocalFrame(header: LasHeader): PointCloudOrigin {
  const [min, max] = hasUsableExtent(header)
    ? [header.min, header.max]
    : [header.offset, header.offset];
  const anchor = chooseOrigin(min, max);
  return [anchor[0], anchor[2], -anchor[1]];
}

/**
 * LAS stores colour in 16-bit channels, but plenty of writers put plain 8-bit
 * values in them. Sampling tells the two apart; guessing wrong either crushes
 * a file to near-black or saturates it to white.
 */
export function colorScaleFromSamples(maximumChannelValue: number): number {
  return maximumChannelValue > 255 ? 257 : 1;
}
