import { Field, Note, Segmented } from "../../controls.js";
import { formatCount } from "../../format.js";
import type { Workspace } from "../use-workspace.js";

const budgetStep = 10_000;

/** How much detail is drawn, and what the renderer is doing with it. */
export function SettingsPanel({ workspace }: { workspace: Workspace }) {
  const { detail, source } = workspace;
  const sliderMax = Math.max(budgetStep, Math.ceil(detail.budgetMaximum / budgetStep) * budgetStep);

  return (
    <div className="panel">
      <h2 className="panel-title">Settings</h2>

      <Field label="Level of detail">
        <Segmented
          label="Level of detail"
          value={detail.lodMode}
          choices={[
            { value: "distance", label: "By distance" },
            { value: "manual", label: "Fixed budget" },
          ]}
          onChange={detail.setLodMode}
        />
      </Field>

      {detail.lodMode === "manual" ? (
        <Field label="Point budget" value={formatCount(detail.pointBudget)}>
          <input
            aria-label="Point budget"
            type="range"
            min={budgetStep}
            max={sliderMax}
            step={budgetStep}
            value={Math.min(detail.pointBudget, sliderMax)}
            onChange={(event) => detail.setPointBudget(Number(event.target.value))}
          />
        </Field>
      ) : (
        <Note>Detail follows the camera: zoom in for full resolution, pull back to save GPU work.</Note>
      )}

      <Field label="Rendering now">
        <dl className="stat-list">
          <div>
            <dt>Level of detail</dt>
            <dd>{detail.lodSummary?.focusTierId ?? "—"}</dd>
          </div>
          <div>
            <dt>Points drawn</dt>
            <dd>{detail.lodSummary === undefined ? "—" : formatCount(detail.lodSummary.drawnPointCount)}</dd>
          </div>
          <div>
            <dt>Tiles</dt>
            <dd>{detail.lodSummary === undefined ? "—" : String(detail.lodSummary.tileCount)}</dd>
          </div>
          <div>
            <dt>Scan origin</dt>
            <dd>{source === undefined ? "—" : source.isGeoreferenced ? source.origin.map((value) => Math.round(value)).join(" / ") : "Local"}</dd>
          </div>
        </dl>
      </Field>

      <Field label="Navigation">
        <dl className="stat-list">
          <div>
            <dt>Turn</dt>
            <dd>Drag</dd>
          </div>
          <div>
            <dt>Pan</dt>
            <dd>Right- or middle-drag · Shift-drag</dd>
          </div>
          <div>
            <dt>Zoom to cursor</dt>
            <dd>Scroll · pinch</dd>
          </div>
          <div>
            <dt>Fly to a point</dt>
            <dd>Double-click (Inspect tool)</dd>
          </div>
          <div>
            <dt>Move across</dt>
            <dd>W A S D or arrows</dd>
          </div>
          <div>
            <dt>Move down · up</dt>
            <dd>Q · E, Shift for faster</dd>
          </div>
        </dl>
      </Field>

      <Note>The view turns and zooms around whatever is under the cursor. The keys steer it once you have clicked the scan. Press H to hide the panels and give the whole window to the scan.</Note>
    </div>
  );
}
