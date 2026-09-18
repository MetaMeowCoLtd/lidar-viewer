import { viewerConfig } from "../config.js";
import type { LodTierSpec } from "../core/lod-pyramid.js";

/** The detail levels built for a scan, scaled to its size: full resolution, then three voxel grids of coarser steps. */
export function createLodSpecs(diagonal: number): LodTierSpec[] {
  const scale = Math.max(diagonal, 1);
  const { fine, balanced, lean } = viewerConfig().lodDivisors;
  const distance = viewerConfig().distanceLod.distanceMultipliers;
  return [
    { id: "full", voxelSize: 0, minCameraDistance: scale * distance.full },
    { id: "fine", voxelSize: scale / fine, minCameraDistance: scale * distance.fine },
    { id: "balanced", voxelSize: scale / balanced, minCameraDistance: scale * distance.balanced },
    { id: "lean", voxelSize: scale / lean, minCameraDistance: scale * distance.lean },
  ];
}
