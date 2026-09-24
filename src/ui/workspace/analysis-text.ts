import { formatCount, formatRampHeight, formatShare } from "../format.js";
import type { CountState, GroundState, NoiseState, TerrainState } from "./types.js";

/** A short progress or timing figure for an analysis: its percentage while running, its duration once done. */
export function progressHeadline(state: NoiseState | GroundState | TerrainState | CountState): string {
  if (state.status === "running") return `${Math.round(state.fraction * 100)}%`;
  if (state.status === "done") return `${state.seconds.toFixed(1)} s`;
  return "";
}

export function noiseSummary(noise: NoiseState): string {
  if (noise.status === "failed") return noise.message;
  if (noise.status !== "done") {
    return "Finds stray returns - birds and dust above the scan, multipath below it - and labels them as noise so the other steps and your exports leave them out.";
  }
  const { stats, seconds } = noise;
  if (stats.total === 0) return `No noise found: every point has neighbours within ${stats.radius.toFixed(1)} m and none sits far below its surroundings.`;
  const parts: string[] = [];
  if (stats.isolatedHigh > 0) parts.push(`${formatCount(stats.isolatedHigh)} stray above the surface`);
  if (stats.isolatedLow > 0) parts.push(`${formatCount(stats.isolatedLow)} stray at or below it`);
  if (stats.lowOutliers > 0) parts.push(`${formatCount(stats.lowOutliers)} far below the ground`);
  if (stats.alreadyLabelled > 0) parts.push(`${formatCount(stats.alreadyLabelled)} already labelled in the file`);
  return `${formatCount(stats.total)} points are noise (${formatShare(stats.total, stats.pointCount)}): ${parts.join(", ")}. They are hidden; highlight them in View to check. Found in ${seconds.toFixed(1)} s.`;
}

export function groundSummary(ground: GroundState): string {
  if (ground.status === "failed") return ground.message;
  if (ground.status !== "done") {
    return "Finds the terrain under buildings and trees, and measures how high everything stands above it.";
  }
  const { stats, seconds } = ground;
  const parts = [`${formatShare(stats.groundPoints, stats.pointCount)} of points are ground`];
  if (stats.lowNoisePoints > 0) parts.push(`${formatCount(stats.lowNoisePoints)} flagged as low noise`);
  if (stats.preservedPoints > 0) parts.push(`existing classes kept on ${formatCount(stats.preservedPoints)}`);
  const cell = stats.cellSize < 10 ? stats.cellSize.toFixed(1) : String(Math.round(stats.cellSize));
  return `${parts.join(", ")}. Surface built on a ${cell} m grid in ${seconds.toFixed(1)} s.`;
}

export function terrainSummary(terrain: TerrainState, hasGround: boolean, originY: number): string {
  if (terrain.status === "failed") return terrain.message;
  if (terrain.status !== "done") {
    return hasGround
      ? "Turns the ground points into a 3D terrain surface with contour lines, ready to export for GIS and CAD."
      : "Needs ground points. Detect ground first, or load a scan whose file already marks its ground.";
  }
  const { model, contours } = terrain.result;
  const cell = model.grid.cellSize < 10 ? model.grid.cellSize.toFixed(1) : String(Math.round(model.grid.cellSize));
  const low = formatRampHeight(originY + model.minElevation);
  const high = formatRampHeight(originY + model.maxElevation);
  const measured = formatShare(model.measuredCells, model.coveredCells);
  return `Ground from ${low} to ${high} on a ${cell} m grid; ${measured} measured, the rest filled in under buildings and trees. Contours every ${contours.interval} m, bold every ${contours.majorInterval} m.`;
}

export function countSummary(count: CountState): string {
  if (count.status === "failed") return count.message;
  if (count.status !== "done") {
    return "Finds each building and tree standing on the ground, outlines it and counts it. Detects ground first when the scan needs it.";
  }
  const { stats, tallestBuilding, treeHeights } = count;
  const buildings =
    stats.buildings === 0
      ? "No buildings found."
      : `Footprints cover ${Math.round(stats.footprintArea).toLocaleString("en-US")} m², the tallest building rising ${formatRampHeight(tallestBuilding)}.`;
  const trees =
    stats.trees === 0
      ? "No trees found."
      : stats.trees === 1
        ? `The tree stands ${formatRampHeight(treeHeights[1])} tall.`
        : `Trees stand ${formatRampHeight(treeHeights[0])} to ${formatRampHeight(treeHeights[1])} tall.`;
  return `${buildings} ${trees}`;
}
