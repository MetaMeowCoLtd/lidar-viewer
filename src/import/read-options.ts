import type { PointCloud } from "../core/point-cloud.js";

/** Reports how much of a scan has been read, from zero to one. */
export type ReadProgress = (fraction: number) => void;

export interface ReadOptions {
  readonly onProgress?: ReadProgress | undefined;
  /** Keep one point in this many, evenly through the file. Defaults to every point. */
  readonly keepEvery?: number | undefined;
}

export interface ImportedScan {
  readonly cloud: PointCloud;
  /** Points in the file; more than the cloud holds when the scan was thinned to fit. */
  readonly sourcePointCount: number;
}

/**
 * How many points to step over per point kept, so a scan of `pointCount`
 * points fits within `maxPoints`.
 *
 * Thinning by a fixed stride through the file keeps coverage even: LAS, LAZ
 * and PLY writers store points in acquisition or spatial order, so every
 * n-th point is spread across the whole scan rather than clipped to part of
 * it, the way stopping at the limit would be.
 */
export function keepEveryFor(pointCount: number, maxPoints: number | undefined): number {
  if (maxPoints === undefined || !(maxPoints >= 1) || pointCount <= maxPoints) return 1;
  return Math.ceil(pointCount / maxPoints);
}

/** Points kept from `pointCount` when keeping one in `keepEvery`. */
export function keptCount(pointCount: number, keepEvery: number): number {
  return Math.ceil(pointCount / keepEvery);
}
