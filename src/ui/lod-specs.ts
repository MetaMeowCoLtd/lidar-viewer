import { viewerConfig } from "../config.js";
import type { LodTierSpec } from "../core/lod-pyramid.js";

/**
 * The detail levels built for a scan, scaled to its size: full resolution,
 * then three voxel grids of coarser steps. Which one a tile draws by distance
 * is decided on screen, from each tier's measured spacing; see
 * `TiledPointCloudLodPyramid.selectForScreenSpace`.
 */
export function createLodSpecs(diagonal: number): LodTierSpec[] {
  const scale = Math.max(diagonal, 1);
  const { fine, balanced, lean } = viewerConfig().lodDivisors;
  return [
    { id: "full", voxelSize: 0 },
    { id: "fine", voxelSize: scale / fine },
    { id: "balanced", voxelSize: scale / balanced },
    { id: "lean", voxelSize: scale / lean },
  ];
}
