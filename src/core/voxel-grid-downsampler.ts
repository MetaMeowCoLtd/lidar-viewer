import { PointCloud } from "./point-cloud.js";

export interface VoxelDownsampleOptions {
  /** World-space edge length of one cubic voxel. */
  readonly voxelSize: number;
  readonly name?: string;
}

interface VoxelAccumulator {
  count: number;
  x: number;
  y: number;
  z: number;
  red: number;
  green: number;
  blue: number;
  intensity: number;
}

/**
 * Reduces a cloud to one representative point per occupied voxel. Positions and
 * optional attributes are averaged, which avoids the visual bias of retaining
 * the first source point encountered in a voxel.
 */
export class VoxelGridDownsampler {
  public downsample(source: PointCloud, options: VoxelDownsampleOptions): PointCloud {
    const { voxelSize, name = `${source.name}-voxel-${voxelSize}` } = options;
    if (!Number.isFinite(voxelSize) || voxelSize <= 0) {
      throw new Error("voxelSize must be a finite number greater than zero");
    }

    const cells = new Map<string, VoxelAccumulator>();
    const { positions, colors, intensity } = source;
    const origin = source.bounds.min;

    for (let point = 0, offset = 0; point < source.pointCount; point += 1, offset += 3) {
      const x = positions[offset]!;
      const y = positions[offset + 1]!;
      const z = positions[offset + 2]!;
      const ix = Math.floor((x - origin[0]) / voxelSize);
      const iy = Math.floor((y - origin[1]) / voxelSize);
      const iz = Math.floor((z - origin[2]) / voxelSize);
      const key = `${ix},${iy},${iz}`;
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = { count: 0, x: 0, y: 0, z: 0, red: 0, green: 0, blue: 0, intensity: 0 };
        cells.set(key, cell);
      }
      cell.count += 1;
      cell.x += x;
      cell.y += y;
      cell.z += z;
      if (colors !== undefined) {
        cell.red += colors[offset]!;
        cell.green += colors[offset + 1]!;
        cell.blue += colors[offset + 2]!;
      }
      if (intensity !== undefined) cell.intensity += intensity[point]!;
    }

    const outputCount = cells.size;
    const outputPositions = new Float32Array(outputCount * 3);
    const outputColors = colors === undefined ? undefined : new Uint8Array(outputCount * 3);
    const outputIntensity = intensity === undefined ? undefined : new Float32Array(outputCount);
    let output = 0;
    for (const cell of cells.values()) {
      const offset = output * 3;
      outputPositions[offset] = cell.x / cell.count;
      outputPositions[offset + 1] = cell.y / cell.count;
      outputPositions[offset + 2] = cell.z / cell.count;
      if (outputColors !== undefined) {
        outputColors[offset] = Math.round(cell.red / cell.count);
        outputColors[offset + 1] = Math.round(cell.green / cell.count);
        outputColors[offset + 2] = Math.round(cell.blue / cell.count);
      }
      if (outputIntensity !== undefined) outputIntensity[output] = cell.intensity / cell.count;
      output += 1;
    }

    return new PointCloud({
      positions: outputPositions,
      ...(outputColors === undefined ? {} : { colors: outputColors }),
      ...(outputIntensity === undefined ? {} : { intensity: outputIntensity }),
      name,
    });
  }
}
