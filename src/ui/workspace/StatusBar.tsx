import { formatCount, formatOrigin } from "../format.js";
import type { Workspace } from "./use-workspace.js";

/**
 * One line along the bottom: what the app is doing, what it has found, and
 * where the scan sits on the map. The render statistics that used to live here
 * are engineering detail and moved into the settings panel.
 */
export function StatusBar({ workspace }: { workspace: Workspace }) {
  const { status, statusText, source, analysis, importProgress } = workspace;
  const busy = importProgress !== undefined || analysis.analysing || status === "processing";

  let message = statusText;
  if (importProgress !== undefined) {
    const label = importProgress.stage === "reading" ? "Reading the file" : "Building detail levels";
    message = `${label} · ${Math.round(importProgress.fraction * 100)}%`;
  } else if (analysis.ground.status === "running") message = `${analysis.ground.stage}…`;
  else if (analysis.terrain.status === "running") message = `${analysis.terrain.stage}…`;
  else if (analysis.count.status === "running") message = `${analysis.count.stage}…`;

  const found: string[] = [];
  if (analysis.count.status === "done") {
    found.push(`${analysis.count.stats.buildings.toLocaleString("en-US")} buildings`, `${analysis.count.stats.trees.toLocaleString("en-US")} trees`);
  }
  if (analysis.terrain.status === "done") found.push(`terrain on a ${analysis.terrain.result.model.grid.cellSize} m grid`);

  return (
    <footer className="ws-status">
      <span className={`ws-dot ws-dot-${status === "error" ? "error" : busy ? "busy" : "ready"}`} />
      <span className="ws-status-message">{message}</span>
      {found.length > 0 ? <span className="ws-status-found">{found.join(" · ")}</span> : null}
      <span className="ws-status-right">
        {source === undefined ? null : (
          <>
            <span>{formatCount(source.pointCount)} points</span>
            <span>{source.spatialReference?.epsg === undefined ? formatOrigin(source) : `EPSG:${source.spatialReference.epsg}`}</span>
          </>
        )}
      </span>
    </footer>
  );
}
