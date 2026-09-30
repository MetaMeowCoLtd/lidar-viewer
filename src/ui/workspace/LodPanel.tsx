import { lodTierColors } from "../../three/lidar-viewer.js";
import { formatCount } from "../format.js";
import type { Workspace } from "./use-workspace.js";

/**
 * The level-of-detail view's key and figures: each tier in the colour its
 * tiles are tinted, the spacing of its points, and how many tiles and points
 * draw it now. It updates as the camera moves or the budget changes, so how
 * detail is spread over the scan can be read at a glance.
 */
export function LodPanel({ workspace }: { workspace: Workspace }) {
  const { detail } = workspace;
  const summary = detail.lodSummary;
  if (summary === undefined) return null;
  const share = summary.totalPointCount > 0 ? summary.drawnPointCount / summary.totalPointCount : 0;
  return (
    <section className="ws-lod" aria-label="Levels of detail">
      <header>
        <h2>Levels of detail</h2>
        <span>{detail.lodMode === "distance" ? "by distance" : `budget ${formatCount(detail.pointBudget)}`}</span>
      </header>
      <table>
        <thead>
          <tr>
            <th>Tier</th>
            <th>Spacing</th>
            <th>Tiles</th>
            <th>Points</th>
          </tr>
        </thead>
        <tbody>
          {summary.tiers.map((tier) => (
            <tr key={tier.id} className={tier.tiles === 0 ? "is-idle" : undefined}>
              <td>
                <i style={{ background: lodTierColors[tier.id] ?? "var(--text-3)" }} />
                {tier.id}
                {tier.id === summary.focusTierId ? <b title="The tier of the tile nearest the camera"> ●</b> : null}
              </td>
              <td>{tier.tiles === 0 ? "—" : spacing(tier.spacing)}</td>
              <td>{tier.tiles}</td>
              <td>{formatCount(tier.points)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {`${formatCount(summary.drawnPointCount)} of ${formatCount(summary.totalPointCount)} points drawn (${Math.round(share * 100)}%) across ${summary.tileCount} tiles`}
      </p>
    </section>
  );
}

function spacing(metres: number): string {
  return metres < 1 ? `${Math.round(metres * 100)} cm` : `${metres.toFixed(1)} m`;
}
