import { viewerConfig } from "../config.js";
import type { LodTierSpec } from "../core/lod-pyramid.js";

/** Tier ids, finest first: full resolution, then each level down. */
export const fullTierId = "full";
export const levelTierId = (level: number) => `lod${level}`;

/**
 * The detail levels built for a scan: full resolution, then levels that each
 * keep about a quarter of the points of the one above, as an octree's levels
 * do. The levels are measured on every tile's own points rather than set from
 * the scan's size, so they step down evenly on a forest and a city alike, and
 * the step from one to the next is small enough to read as a gradient.
 */
export function createLodSpecs(): LodTierSpec[] {
  const { count, pointFraction } = viewerConfig().lodLevels;
  return [
    { id: fullTierId, voxelSize: 0 },
    ...Array.from({ length: count }, (_, index) => ({ id: levelTierId(index + 1), voxelSize: 0, pointFraction })),
  ];
}
