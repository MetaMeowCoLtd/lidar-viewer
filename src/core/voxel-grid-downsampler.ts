import { PointCloud } from "./point-cloud.js";

export interface VoxelDownsampleOptions {
  /** World-space edge length of one cubic voxel. */
  readonly voxelSize: number;
  readonly name?: string;
}

/**
 * Reduces a cloud to one representative point per occupied voxel. Occupied
 * cells live in an open-addressed typed-array table keyed by the packed grid
 * index, so no string key or accumulator object is allocated per source point.
 *
 * Continuous channels - position, colour, intensity, height above ground -
 * are averaged, which
 * avoids the visual bias of retaining the first source point encountered in a
 * voxel.
 *
 * Categorical channels cannot be averaged. A voxel holding ground and building
 * points has no meaningful mean class, and rounding one would invent a code
 * that describes neither. Those channels instead take a streaming majority
 * vote, which keeps two numbers per voxel and always returns a value that was
 * actually present in it.
 */
export class VoxelGridDownsampler {
  public downsample(source: PointCloud, options: VoxelDownsampleOptions): PointCloud {
    const { voxelSize, name = `${source.name}-voxel-${voxelSize}` } = options;
    if (!Number.isFinite(voxelSize) || voxelSize <= 0) {
      throw new Error("voxelSize must be a finite number greater than zero");
    }

    const { positions, colors, intensity, classification, returnNumber, numberOfReturns, heightAboveGround, pointCount } = source;
    const originX = source.bounds.min[0];
    const originY = source.bounds.min[1];
    const originZ = source.bounds.min[2];
    const columns = Math.floor(source.bounds.size[0] / voxelSize) + 1;
    const rows = Math.floor(source.bounds.size[1] / voxelSize) + 1;

    // Slot layout per occupied voxel: a point count and three coordinate sums,
    // then one slot per averaged channel and two per voted channel.
    let stride = 4;
    const colorSlot = stride;
    if (colors !== undefined) stride += 3;
    const intensitySlot = stride;
    if (intensity !== undefined) stride += 1;
    const heightAboveGroundSlot = stride;
    if (heightAboveGround !== undefined) stride += 1;
    const classificationSlot = stride;
    if (classification !== undefined) stride += 2;
    const returnNumberSlot = stride;
    if (returnNumber !== undefined) stride += 2;
    const numberOfReturnsSlot = stride;
    if (numberOfReturns !== undefined) stride += 2;

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
      if (heightAboveGround !== undefined) {
        sums[base + heightAboveGroundSlot] = sums[base + heightAboveGroundSlot]! + heightAboveGround[point]!;
      }
      if (classification !== undefined) castVote(sums, base + classificationSlot, classification[point]!);
      if (returnNumber !== undefined) castVote(sums, base + returnNumberSlot, returnNumber[point]!);
      if (numberOfReturns !== undefined) castVote(sums, base + numberOfReturnsSlot, numberOfReturns[point]!);
    }

    const outputPositions = new Float32Array(cellCount * 3);
    const outputColors = colors === undefined ? undefined : new Uint8Array(cellCount * 3);
    const outputIntensity = intensity === undefined ? undefined : new Float32Array(cellCount);
    const outputHeightAboveGround = heightAboveGround === undefined ? undefined : new Float32Array(cellCount);
    const outputClassification = classification === undefined ? undefined : new Uint8Array(cellCount);
    const outputReturnNumber = returnNumber === undefined ? undefined : new Uint8Array(cellCount);
    const outputNumberOfReturns = numberOfReturns === undefined ? undefined : new Uint8Array(cellCount);
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
      if (outputHeightAboveGround !== undefined) outputHeightAboveGround[cell] = sums[base + heightAboveGroundSlot]! / count;
      if (outputClassification !== undefined) outputClassification[cell] = sums[base + classificationSlot]!;
      if (outputReturnNumber !== undefined) outputReturnNumber[cell] = sums[base + returnNumberSlot]!;
      if (outputNumberOfReturns !== undefined) outputNumberOfReturns[cell] = sums[base + numberOfReturnsSlot]!;
    }

    return new PointCloud({
      positions: outputPositions,
      ...(outputColors === undefined ? {} : { colors: outputColors }),
      ...(outputIntensity === undefined ? {} : { intensity: outputIntensity }),
      ...(outputHeightAboveGround === undefined ? {} : { heightAboveGround: outputHeightAboveGround }),
      ...(outputClassification === undefined ? {} : { classification: outputClassification }),
      ...(outputReturnNumber === undefined ? {} : { returnNumber: outputReturnNumber }),
      ...(outputNumberOfReturns === undefined ? {} : { numberOfReturns: outputNumberOfReturns }),
      origin: source.origin,
      name,
    });
  }
}

/**
 * One step of a Boyer-Moore majority vote, held in two slots: the current
 * candidate and its lead over everything else seen so far.
 *
 * A class that holds an outright majority of a voxel always wins, which is the
 * case that matters because a voxel is a few centimetres of one surface. Where
 * no class has a majority the survivor is simply one of the contenders - never
 * an average, and never a code that was not in the voxel.
 */
function castVote(sums: Float64Array, slot: number, value: number): void {
  const lead = sums[slot + 1]!;
  if (lead === 0) {
    sums[slot] = value;
    sums[slot + 1] = 1;
  } else if (sums[slot] === value) {
    sums[slot + 1] = lead + 1;
  } else {
    sums[slot + 1] = lead - 1;
  }
}

function hashCell(key: number): number {
  let hash = Math.imul(key >>> 0, 2654435761) ^ Math.imul((key / 4294967296) >>> 0, 2246822519);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 1274126177);
  return (hash ^ (hash >>> 16)) >>> 0;
}
