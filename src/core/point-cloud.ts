export type PointCloudColorMode = "height" | "rgb" | "relief";
export type PointCloudPointShape = "circle" | "square";

export interface PointCloudBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly diagonal: number;
}

export interface PointCloudAttributes {
  /** One sRGB triplet per point. */
  readonly colors?: Uint8Array;
  /** One normalized or raw scalar value per point. */
  readonly intensity?: Float32Array;
}

/**
 * Double-precision world position of a cloud's local frame. Survey data is
 * normally delivered in a projected system where an easting runs into the
 * hundreds of thousands of metres, and a `Float32` holds about seven
 * significant digits, so at that magnitude consecutive representable values
 * are centimetres apart and the cloud visibly snaps to a grid. Positions are
 * therefore stored relative to this origin and only resolved back to world
 * coordinates for display and export.
 */
export type PointCloudOrigin = readonly [number, number, number];

export const zeroOrigin: PointCloudOrigin = [0, 0, 0];

export interface PointCloudInit extends PointCloudAttributes {
  /** Local coordinates, relative to `origin`. */
  readonly positions: Float32Array;
  readonly name?: string;
  /** Supplied when bounds are already known, to skip a redundant pass over `positions`. */
  readonly bounds?: PointCloudBounds;
  /** Defaults to the world origin, which is what a non-georeferenced scan wants. */
  readonly origin?: PointCloudOrigin;
}

/**
 * An immutable, CPU-side point cloud. Every attribute is tightly packed and
 * shares its index with `positions`; this is the format handed to workers and
 * converted to GPU buffers by the rendering adapter.
 *
 * `positions` and `bounds` are both in the cloud's local frame, so every
 * consumer - tiling, decimation, distance-based LOD, the camera and the
 * shader - keeps working in small numbers and needs no knowledge of where the
 * scan sits on the planet. {@link PointCloud.origin} carries that offset in
 * double precision alongside the data.
 */
export class PointCloud {
  public readonly positions: Float32Array;
  public readonly colors: Uint8Array | undefined;
  public readonly intensity: Float32Array | undefined;
  public readonly name: string;
  public readonly pointCount: number;
  public readonly bounds: PointCloudBounds;
  public readonly origin: PointCloudOrigin;

  public constructor({ positions, colors, intensity, bounds, origin = zeroOrigin, name = "point-cloud" }: PointCloudInit) {
    if (positions.length === 0 || positions.length % 3 !== 0) {
      throw new Error("positions must contain at least one complete xyz triplet");
    }

    const pointCount = positions.length / 3;
    if (colors !== undefined && colors.length !== pointCount * 3) {
      throw new Error("colors must contain one rgb triplet per point");
    }
    if (intensity !== undefined && intensity.length !== pointCount) {
      throw new Error("intensity must contain one value per point");
    }
    if (origin.length !== 3 || !origin.every((value) => Number.isFinite(value))) {
      throw new Error("origin must be three finite numbers");
    }

    this.positions = positions;
    this.colors = colors;
    this.intensity = intensity;
    this.name = name;
    this.pointCount = pointCount;
    this.bounds = bounds ?? calculateBounds(positions);
    this.origin = origin;
  }

  public supportsColorMode(mode: PointCloudColorMode): boolean {
    return mode === "height" || (mode === "rgb" && this.colors !== undefined) ||
      mode === "relief";
  }

  /** True when this cloud carries a non-zero georeferencing offset. */
  public get isGeoreferenced(): boolean {
    return this.origin[0] !== 0 || this.origin[1] !== 0 || this.origin[2] !== 0;
  }

  /** World coordinates of one point, resolved in double precision. */
  public worldPosition(index: number): [number, number, number] {
    if (!Number.isInteger(index) || index < 0 || index >= this.pointCount) {
      throw new Error("index must address a point in this cloud");
    }
    const offset = index * 3;
    return [
      this.origin[0] + this.positions[offset]!,
      this.origin[1] + this.positions[offset + 1]!,
      this.origin[2] + this.positions[offset + 2]!,
    ];
  }

  /** The cloud's extent in world coordinates, for readouts and export headers. */
  public worldBounds(): { min: [number, number, number]; max: [number, number, number]; center: [number, number, number] } {
    const shift = (value: readonly [number, number, number]): [number, number, number] => [
      this.origin[0] + value[0],
      this.origin[1] + value[1],
      this.origin[2] + value[2],
    ];
    return { min: shift(this.bounds.min), max: shift(this.bounds.max), center: shift(this.bounds.center) };
  }
}

/**
 * Picks a local frame for a cloud whose extent in world coordinates is known.
 * The anchor is snapped down to a round multiple so it stays readable in a
 * coordinate readout and stable across reloads of the same scan; `step` is
 * chosen small enough that the snapping never pushes the data far from its
 * own frame.
 */
export function chooseOrigin(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  step = 1000,
): PointCloudOrigin {
  const snap = (low: number, high: number): number => {
    const center = (low + high) / 2;
    return Number.isFinite(center) ? Math.floor(center / step) * step : 0;
  };
  return [snap(min[0], max[0]), snap(min[1], max[1]), snap(min[2], max[2])];
}

/** Completes a bounds record from an extent a caller already tracked. */
export function boundsFromExtent(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): PointCloudBounds {
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size,
    diagonal: Math.hypot(...size),
  };
}

export function calculateBounds(positions: Float32Array): PointCloudBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index]!;
    const y = positions[index + 1]!;
    const z = positions[index + 2]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  return boundsFromExtent([minX, minY, minZ], [maxX, maxY, maxZ]);
}
