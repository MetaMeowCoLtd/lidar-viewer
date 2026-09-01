export type PointCloudColorMode = "height" | "rgb" | "intensity";

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

export interface PointCloudInit extends PointCloudAttributes {
  readonly positions: Float32Array;
  readonly name?: string;
}

/**
 * An immutable, CPU-side point cloud. Every attribute is tightly packed and
 * shares its index with `positions`; this is the format handed to workers and
 * converted to GPU buffers by the rendering adapter.
 */
export class PointCloud {
  public readonly positions: Float32Array;
  public readonly colors: Uint8Array | undefined;
  public readonly intensity: Float32Array | undefined;
  public readonly name: string;
  public readonly pointCount: number;
  public readonly bounds: PointCloudBounds;

  public constructor({ positions, colors, intensity, name = "point-cloud" }: PointCloudInit) {
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

    this.positions = positions;
    this.colors = colors;
    this.intensity = intensity;
    this.name = name;
    this.pointCount = pointCount;
    this.bounds = calculateBounds(positions);
  }

  public supportsColorMode(mode: PointCloudColorMode): boolean {
    return mode === "height" || (mode === "rgb" && this.colors !== undefined) ||
      (mode === "intensity" && this.intensity !== undefined);
  }
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

  const size: [number, number, number] = [maxX - minX, maxY - minY, maxZ - minZ];
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    size,
    diagonal: Math.hypot(...size),
  };
}
