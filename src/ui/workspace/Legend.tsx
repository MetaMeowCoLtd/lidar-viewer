import { classificationColor, classificationName } from "../../core/point-cloud-classification.js";
import { flightLineCss } from "../../core/flight-line-colour.js";
import { formatRampHeight, formatShare } from "../format.js";
import type { Workspace } from "./use-workspace.js";

/** Past this many, flight lines are summed up rather than listed; the colours still tell them apart. */
const maxFlightLines = 16;

/**
 * The key to whatever the points are coloured by, in the corner of the scan
 * rather than in a panel: a colour is only readable next to what it colours.
 */
export function Legend({ workspace }: { workspace: Workspace }) {
  const { view, source, analysis } = workspace;
  if (source === undefined) return null;

  if (view.noiseDisplay === "highlighted" && view.noisePoints > 0) {
    return (
      <div className="ws-legend" aria-label="Noise highlighted">
        <span>
          <i style={{ background: "#ff2999" }} />
          {`Noise · ${view.noisePoints.toLocaleString("en-US")} points`}
        </span>
      </div>
    );
  }

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

  if (view.colorMode === "flightLine" && view.flightLines.length > 1) {
    const more = view.flightLines.length - maxFlightLines;
    const hiddenCount = view.hiddenLines.size;
    return (
      <div className="ws-legend ws-legend-lines" aria-label="Flight lines in this scan">
        <span
          className="ws-legend-title"
          title="A flight line is one straight pass of the aircraft; the scanner sweeps a strip of ground under it, and neighbouring strips overlap"
        >
          {hiddenCount === 0
            ? `${view.flightLines.length} flight lines · click to hide, Alt+click to show one alone`
            : `${view.flightLines.length - hiddenCount} of ${view.flightLines.length} flight lines shown`}
          {hiddenCount === 0 ? null : (
            <button type="button" className="link-btn" onClick={view.showAllLines}>
              Show all
            </button>
          )}
        </span>
        {view.flightLines.slice(0, maxFlightLines).map(({ id, count }) => {
          const hidden = view.hiddenLines.has(id);
          return (
            <button
              type="button"
              key={id}
              className="ws-legend-line"
              aria-pressed={!hidden}
              title={`Point source ID ${id}. Click to ${hidden ? "show" : "hide"} it; Alt+click to show it alone.`}
              onClick={(event) => view.toggleLine(id, event.altKey)}
            >
              <i style={{ background: flightLineCss(id) }} />
              {`Line ${id}`}
              <small>{formatShare(count, source.pointCount)}</small>
            </button>
          );
        })}
        {more > 0 ? <span>{`+${more} more`}</span> : null}
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
