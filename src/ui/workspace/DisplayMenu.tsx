import { Field, Menu, Note, Segmented } from "../controls.js";
import { formatCount } from "../format.js";
import { viewerConfig } from "../../config.js";
import type { Workspace } from "./use-workspace.js";

const budgetStep = 10_000;

/**
 * How the scan is drawn, kept out of the way in one popover: dot size and
 * shape, how much detail is drawn, and the controls for moving around. None of
 * it changes what the analyses find.
 */
export function DisplayMenu({ workspace }: { workspace: Workspace }) {
  const { view, detail } = workspace;
  const sliderMax = Math.max(budgetStep, Math.ceil(detail.budgetMaximum / budgetStep) * budgetStep);

  return (
    <Menu label="Display" icon="sliders">
      {() => (
        <div className="display-menu">
          <Field label="Point size" value={`${view.pointSize.toFixed(1)} px`}>
            <input
              aria-label="Point size"
              type="range"
              min={viewerConfig().pointSize.min}
              max={viewerConfig().pointSize.max}
              step="0.1"
              value={view.pointSize}
              onChange={(event) => view.setPointSize(Number(event.target.value))}
            />
          </Field>

          <Field label="Point shape">
            <Segmented
              label="Point shape"
              value={view.pointShape}
              choices={[
                { value: "circle", label: "Circle" },
                { value: "square", label: "Square" },
              ]}
              onChange={view.setPointShape}
            />
          </Field>

          <Field label="Detail" value={detail.lodSummary === undefined ? undefined : `${formatCount(detail.lodSummary.drawnPointCount)} drawn`}>
            <Segmented
              label="Level of detail"
              value={detail.lodMode}
              choices={[
                { value: "manual", label: "Fixed budget" },
                { value: "distance", label: "By distance" },
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
            <Note>Detail follows the camera: full resolution up close, lighter far away.</Note>
          )}

          <Field label="Moving around">
            <dl className="stat-list">
              <div>
                <dt>Turn</dt>
                <dd>Drag</dd>
              </div>
              <div>
                <dt>Pan</dt>
                <dd>Right- or middle-drag, Shift-drag</dd>
              </div>
              <div>
                <dt>Zoom to cursor</dt>
                <dd>Scroll, pinch</dd>
              </div>
              <div>
                <dt>Fly to a point</dt>
                <dd>Double-click</dd>
              </div>
              <div>
                <dt>Move</dt>
                <dd>W A S D or arrows</dd>
              </div>
              <div>
                <dt>Down · up</dt>
                <dd>Q · E, Shift for faster</dd>
              </div>
              <div>
                <dt>Hide the panels</dt>
                <dd>H</dd>
              </div>
            </dl>
          </Field>
          <Note>The view turns and zooms around whatever is under the cursor; keys steer it once you have clicked the scan.</Note>
        </div>
      )}
    </Menu>
  );
}
