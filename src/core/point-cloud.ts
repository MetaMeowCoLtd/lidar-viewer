import type { SpatialReference } from "./spatial-reference.js";

export type PointCloudColorMode = "height" | "rgb" | "intensity" | "relief" | "classification" | "heightAboveGround" | "objects" | "flightLine";
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
  /** ASPRS class code per point; see {@link classificationName}. */
  readonly classification?: Uint8Array;
  /** Which return of its laser pulse a point came from, counting from one. */
  readonly returnNumber?: Uint8Array;
  /** How many returns that pulse produced in total. */
  readonly numberOfReturns?: Uint8Array;
  /** Height of each point above the ground beneath it, in the scan's units. */
  readonly heightAboveGround?: Float32Array;
  /** The building or tree each point belongs to, numbered from one; zero for none. */
  readonly objectId?: Uint32Array;
  /** LAS point source ID: which flight line (strip) a point was captured on. */
  readonly pointSourceId?: Uint16Array;
}

/**
 * Every optional per-point channel, in one place. Code that forwards a cloud
 * across a boundary - tiling, the worker protocol, the GPU adapter - walks
 * this list instead of naming each channel again, so adding a channel does not
 * mean hunting for the places that quietly drop it.
 */
export const pointCloudChannelNames = [
  "colors",
  "intensity",
  "classification",
  "returnNumber",
  "numberOfReturns",
  "heightAboveGround",
  "objectId",
  "pointSourceId",
] as const;

export type PointCloudChannelName = (typeof pointCloudChannelNames)[number];

/**
 * A cloud, a worker message, or anything else holding the optional channels.
 * Each is allowed to be explicitly undefined, which is how a class field that
 * is always present but sometimes empty is typed.
 */
export type PointCloudChannelSource = {
  readonly [Name in PointCloudChannelName]?: PointCloudAttributes[Name] | undefined;
};

/** The channels a source actually carries, ready to spread into a `PointCloudInit`. */
export function definedChannels(source: PointCloudChannelSource): PointCloudAttributes {
  const channels: Record<string, unknown> = {};
  for (const name of pointCloudChannelNames) {
    const channel = source[name];
    if (channel !== undefined) channels[name] = channel;
  }
  return channels as PointCloudAttributes;
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
  /** The coordinate system the scan's world coordinates are in, when its file declared one. */
  readonly spatialReference?: SpatialReference | undefined;
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
  public readonly classification: Uint8Array | undefined;
  public readonly returnNumber: Uint8Array | undefined;
  public readonly numberOfReturns: Uint8Array | undefined;
  public readonly heightAboveGround: Float32Array | undefined;
  public readonly objectId: Uint32Array | undefined;
  public readonly pointSourceId: Uint16Array | undefined;
  public readonly name: string;
  public readonly pointCount: number;
  public readonly bounds: PointCloudBounds;
  public readonly origin: PointCloudOrigin;
  public readonly spatialReference: SpatialReference | undefined;

  public constructor({
    positions,
    colors,
    intensity,
    classification,
    returnNumber,
    numberOfReturns,
    heightAboveGround,
    objectId,
    pointSourceId,
    bounds,
    origin = zeroOrigin,
    spatialReference,
    name = "point-cloud",
  }: PointCloudInit) {
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
    for (const [label, channel] of [
      ["classification", classification],
      ["returnNumber", returnNumber],
      ["numberOfReturns", numberOfReturns],
      ["heightAboveGround", heightAboveGround],
      ["objectId", objectId],
      ["pointSourceId", pointSourceId],
    ] as const) {
      if (channel !== undefined && channel.length !== pointCount) {
        throw new Error(`${label} must contain one value per point`);
      }
    }
    if (origin.length !== 3 || !origin.every((value) => Number.isFinite(value))) {
      throw new Error("origin must be three finite numbers");
    }

    this.positions = positions;
    this.colors = colors;
    this.intensity = intensity;
    this.classification = classification;
    this.returnNumber = returnNumber;
    this.numberOfReturns = numberOfReturns;
    this.heightAboveGround = heightAboveGround;
    this.objectId = objectId;
    this.pointSourceId = pointSourceId;
    this.name = name;
    this.pointCount = pointCount;
    this.bounds = bounds ?? calculateBounds(positions);
    this.origin = origin;
    this.spatialReference = spatialReference;
    // The per-point arrays stay ordinary fields but are left out of key
    // enumeration. Anything that walks an object's keys would otherwise visit
    // every entry of a scan's millions: React's development build does exactly
    // that when it diffs changed props for the browser's performance panel, and
    // a four-million-point scan froze the page in the commit that showed it.
    for (const name of ["positions", ...pointCloudChannelNames] as const) {
      Object.defineProperty(this, name, { enumerable: false });
    }
  }

  public supportsColorMode(mode: PointCloudColorMode): boolean {
    if (mode === "rgb") return this.colors !== undefined;
    if (mode === "intensity") return this.intensity !== undefined;
    if (mode === "classification") return this.classification !== undefined;
    if (mode === "heightAboveGround") return this.heightAboveGround !== undefined;
    if (mode === "objects") return this.objectId !== undefined;
    if (mode === "flightLine") return this.pointSourceId !== undefined;
    return mode === "height" || mode === "relief";
  }

  /**
   * Counts points per ASPRS class, for a readout or an export summary. Returned
   * in descending order of population so the classes that dominate a scan come
   * first.
   */
  /**
   * Counts points per flight line (LAS point source ID), in the order the
   * lines were numbered.
   */
  public flightLineHistogram(): { id: number; count: number }[] {
    if (this.pointSourceId === undefined) return [];
    const counts = new Int32Array(65536);
    for (let point = 0; point < this.pointCount; point += 1) {
      const id = this.pointSourceId[point]!;
      counts[id] = counts[id]! + 1;
    }
    const histogram: { id: number; count: number }[] = [];
    for (let id = 0; id < counts.length; id += 1) {
      if (counts[id]! > 0) histogram.push({ id, count: counts[id]! });
    }
    return histogram;
  }

  public classificationHistogram(): { code: number; count: number }[] {
    if (this.classification === undefined) return [];
    const counts = new Int32Array(256);
    for (let point = 0; point < this.pointCount; point += 1) {
      const code = this.classification[point]!;
      counts[code] = counts[code]! + 1;
    }
    const histogram: { code: number; count: number }[] = [];
    for (let code = 0; code < counts.length; code += 1) {
      if (counts[code]! > 0) histogram.push({ code, count: counts[code]! });
    }
    return histogram.sort((a, b) => b.count - a.count);
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
 * A local position in viewer axes (x east, y up, z south) as map coordinates:
 * east, north and elevation in the scan's own coordinate system, resolved in
 * double precision. This is the order LAS, GIS tools and surveyors use.
 */
export function toMapCoordinates(
  origin: PointCloudOrigin,
  x: number,
  y: number,
  z: number,
): [east: number, north: number, elevation: number] {
  // Adding zero folds the negative zero that negating zero produces.
  return [origin[0] + x, -(origin[2] + z) + 0, origin[1] + y];
}

/**
 * Picks a local frame for a cloud whose extent in world coordinates is known.
 * The anchor is the nearest round multiple of `step` to the centre, so it stays
 * readable in a coordinate readout and stable across reloads of the same scan,
 * and no point starts more than half a step further from it than from the
 * centre itself.
 *
 * Rounding to the nearest multiple, not down, matters for scans that are
 * already local. A cloud centred a few metres below zero would otherwise be
 * anchored a whole step away and reported as georeferenced when it is not.
 */
export function chooseOrigin(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  step = 1000,
): PointCloudOrigin {
  const snap = (low: number, high: number): number => {
    const center = (low + high) / 2;
    // Adding zero folds a negative zero into zero, so it reads as unshifted.
    return Number.isFinite(center) ? Math.round(center / step) * step + 0 : 0;
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
