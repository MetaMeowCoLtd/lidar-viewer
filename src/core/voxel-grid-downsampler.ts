import { PointCloud } from "./point-cloud.js";

export interface VoxelDownsampleOptions {
  /** World-space edge length of one cubic voxel. */
  readonly voxelSize: number;
  readonly name?: string;
}

/**
 * Reduces a cloud to one representative point per occupied voxel. Positions and
 * optional attributes are averaged, which avoids the visual bias of retaining
 * the first source point encountered in a voxel. Occupied cells live in an
 * open-addressed typed-array table keyed by the packed grid index, so no string
 * key or accumulator object is allocated per source point.
 */
export class VoxelGridDownsampler {
  public downsample(source: PointCloud, options: VoxelDownsampleOptions): PointCloud {
    const { voxelSize, name = `${source.name}-voxel-${voxelSize}` } = options;
    if (!Number.isFinite(voxelSize) || voxelSize <= 0) {
      throw new Error("voxelSize must be a finite number greater than zero");
    }

    const { positions, colors, intensity, pointCount } = source;
    const originX = source.bounds.min[0];
    const originY = source.bounds.min[1];
    const originZ = source.bounds.min[2];
    const columns = Math.floor(source.bounds.size[0] / voxelSize) + 1;
    const rows = Math.floor(source.bounds.size[1] / voxelSize) + 1;

    const colorSlot = 4;
    const intensitySlot = colors === undefined ? 4 : 7;
    const stride = 4 + (colors === undefined ? 0 : 3) + (intensity === undefined ? 0 : 1);

    let tableSize = 1 << 16;
    let mask = tableSize - 1;
    let tableKeys = new Float64Array(tableSize).fill(-1);
    let tableCells = new Int32Array(tableSize);
    let cellCapacity = 1 << 15;
    let sums = new Float64Array(cellCapacity * stride);
    let cellCount = 0;

    const growTable = (): void => {
      const previousKeys = tableKeys;
      const previousCells = tableCells;
      tableSize <<= 1;
      mask = tableSize - 1;
      tableKeys = new Float64Array(tableSize).fill(-1);
      tableCells = new Int32Array(tableSize);
      for (let slot = 0; slot < previousKeys.length; slot += 1) {
        const key = previousKeys[slot]!;
        if (key < 0) continue;
        let probe = hashCell(key) & mask;
        while (tableKeys[probe]! >= 0) probe = (probe + 1) & mask;
        tableKeys[probe] = key;
        tableCells[probe] = previousCells[slot]!;
      }
    };

    for (let point = 0, offset = 0; point < pointCount; point += 1, offset += 3) {
      const x = positions[offset]!;
      const y = positions[offset + 1]!;
      const z = positions[offset + 2]!;
      const key =
        (Math.floor((z - originZ) / voxelSize) * rows + Math.floor((y - originY) / voxelSize)) * columns +
        Math.floor((x - originX) / voxelSize);

      let probe = hashCell(key) & mask;
      let stored = tableKeys[probe]!;
      while (stored >= 0 && stored !== key) {
        probe = (probe + 1) & mask;
        stored = tableKeys[probe]!;
      }
      let cell: number;
      if (stored < 0) {
        if (cellCount === cellCapacity) {
          cellCapacity <<= 1;
          const grown = new Float64Array(cellCapacity * stride);
          grown.set(sums);
          sums = grown;
        }
        cell = cellCount;
        cellCount += 1;
        tableKeys[probe] = key;
        tableCells[probe] = cell;
        if (cellCount * 3 > tableSize * 2) growTable();
      } else {
        cell = tableCells[probe]!;
      }

      const base = cell * stride;
      sums[base] = sums[base]! + 1;
      sums[base + 1] = sums[base + 1]! + x;
      sums[base + 2] = sums[base + 2]! + y;
      sums[base + 3] = sums[base + 3]! + z;
      if (colors !== undefined) {
        sums[base + colorSlot] = sums[base + colorSlot]! + colors[offset]!;
        sums[base + colorSlot + 1] = sums[base + colorSlot + 1]! + colors[offset + 1]!;
        sums[base + colorSlot + 2] = sums[base + colorSlot + 2]! + colors[offset + 2]!;
      }
      if (intensity !== undefined) sums[base + intensitySlot] = sums[base + intensitySlot]! + intensity[point]!;
    }

    const outputPositions = new Float32Array(cellCount * 3);
    const outputColors = colors === undefined ? undefined : new Uint8Array(cellCount * 3);
    const outputIntensity = intensity === undefined ? undefined : new Float32Array(cellCount);
    for (let cell = 0; cell < cellCount; cell += 1) {
      const base = cell * stride;
      const offset = cell * 3;
      const count = sums[base]!;
      outputPositions[offset] = sums[base + 1]! / count;
      outputPositions[offset + 1] = sums[base + 2]! / count;
      outputPositions[offset + 2] = sums[base + 3]! / count;
      if (outputColors !== undefined) {
        outputColors[offset] = Math.round(sums[base + colorSlot]! / count);
        outputColors[offset + 1] = Math.round(sums[base + colorSlot + 1]! / count);
        outputColors[offset + 2] = Math.round(sums[base + colorSlot + 2]! / count);
      }
      if (outputIntensity !== undefined) outputIntensity[cell] = sums[base + intensitySlot]! / count;
    }

    return new PointCloud({
      positions: outputPositions,
      ...(outputColors === undefined ? {} : { colors: outputColors }),
      ...(outputIntensity === undefined ? {} : { intensity: outputIntensity }),
      name,
    });
  }
}

function hashCell(key: number): number {
  let hash = Math.imul(key >>> 0, 2654435761) ^ Math.imul((key / 4294967296) >>> 0, 2246822519);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 1274126177);
  return (hash ^ (hash >>> 16)) >>> 0;
}
