import { toMapCoordinates, type PointCloud } from "./point-cloud.js";

/**
 * Everything the viewer knows about one point, in the terms a user reads:
 * where it is on the map, and what the file and the analyses say about it.
 * Channels a cloud does not carry are simply absent.
 */
export interface PointDetails {
  /** Position in the viewer's local frame, for drawing a marker. */
  readonly local: readonly [number, number, number];
  /** East, north and elevation in the scan's own coordinate system. */
  readonly map: readonly [east: number, north: number, elevation: number];
  readonly classification?: number;
  readonly heightAboveGround?: number;
  /** The building or tree the point belongs to; absent when it belongs to none. */
  readonly objectId?: number;
  readonly intensity?: number;
  readonly returnNumber?: number;
  readonly numberOfReturns?: number;
  readonly color?: readonly [number, number, number];
}

export function describePoint(cloud: PointCloud, index: number): PointDetails {
  if (!Number.isInteger(index) || index < 0 || index >= cloud.pointCount) {
    throw new Error("index must address a point in this cloud");
  }
  const offset = index * 3;
  const local: [number, number, number] = [cloud.positions[offset]!, cloud.positions[offset + 1]!, cloud.positions[offset + 2]!];
  const objectId = cloud.objectId?.[index];
  return {
    local,
    map: toMapCoordinates(cloud.origin, ...local),
    ...(cloud.classification === undefined ? {} : { classification: cloud.classification[index]! }),
    ...(cloud.heightAboveGround === undefined ? {} : { heightAboveGround: cloud.heightAboveGround[index]! }),
    ...(objectId === undefined || objectId === 0 ? {} : { objectId }),
    ...(cloud.intensity === undefined ? {} : { intensity: cloud.intensity[index]! }),
    ...(cloud.returnNumber === undefined ? {} : { returnNumber: cloud.returnNumber[index]! }),
    ...(cloud.numberOfReturns === undefined ? {} : { numberOfReturns: cloud.numberOfReturns[index]! }),
    ...(cloud.colors === undefined
      ? {}
      : { color: [cloud.colors[offset]!, cloud.colors[offset + 1]!, cloud.colors[offset + 2]!] as const }),
  };
}

export interface Measurement {
  /** Straight-line distance between the two points. */
  readonly distance: number;
  /** Distance along the ground, ignoring the difference in elevation. */
  readonly horizontal: number;
  /** How far the second point is above the first; negative when it is below. */
  readonly vertical: number;
  /** Steepness of the line between them, in degrees from horizontal. */
  readonly slopeDegrees: number;
}

/**
 * Measures from one point to another in map coordinates, where "vertical"
 * means elevation. In the viewer's axes that is y, but working from east,
 * north and elevation keeps the arithmetic in the frame the numbers are
 * reported in.
 */
export function measureBetween(from: Pick<PointDetails, "map">, to: Pick<PointDetails, "map">): Measurement {
  const east = to.map[0] - from.map[0];
  const north = to.map[1] - from.map[1];
  const vertical = to.map[2] - from.map[2];
  const horizontal = Math.hypot(east, north);
  return {
    distance: Math.hypot(horizontal, vertical),
    horizontal,
    vertical,
    slopeDegrees: horizontal === 0 && vertical === 0 ? 0 : (Math.atan2(Math.abs(vertical), horizontal) * 180) / Math.PI,
  };
}
