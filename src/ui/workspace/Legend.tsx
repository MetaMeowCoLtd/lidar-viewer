import { classificationColor, classificationName } from "../../core/point-cloud-classification.js";
import { formatRampHeight, formatShare } from "../format.js";
import type { Workspace } from "./use-workspace.js";

/**
 * The key to whatever the points are coloured by, in the corner of the scan
 * rather than in a panel: a colour is only readable next to what it colours.
 */
export function Legend({ workspace }: { workspace: Workspace }) {
  const { view, source, analysis } = workspace;
  if (source === undefined) return null;

  if (view.colorMode === "classification" && view.classHistogram.length > 0) {
    return (
      <div className="ws-legend" aria-label="Classes in this scan">
        {view.classHistogram.slice(0, 6).map(({ code, count }) => (
          <span key={code} title={`Class ${code}`}>
            <i style={{ background: classificationColor(code) }} />
            {classificationName(code)}
            <small>{formatShare(count, source.pointCount)}</small>
          </span>
        ))}
      </div>
    );
  }

  if (view.colorMode === "heightAboveGround" && view.aboveGroundTop > 0) {
    return (
      <div className="ws-legend ws-legend-ramp" aria-label="Height above ground">
        <span className="ws-ramp" />
        <span className="ws-ramp-ends">
          <small>Ground</small>
          <small>{formatRampHeight(view.aboveGroundTop)}</small>
        </span>
      </div>
    );
  }

  if (view.colorMode === "objects" && analysis.count.status === "done") {
    return (
      <div className="ws-legend" aria-label="Objects found">
        <span>
          <i style={{ background: "var(--building)" }} />
          {analysis.count.stats.buildings.toLocaleString("en-US")} buildings
        </span>
        <span>
          <i style={{ background: "var(--tree)" }} />
          {analysis.count.stats.trees.toLocaleString("en-US")} trees
        </span>
      </div>
    );
  }

  return null;
}
