import { Field, Menu, Note, Segmented } from "../controls.js";
import { formatCount } from "../format.js";
import { viewerConfig } from "../../config.js";
import { benchmarkHref } from "../router.js";
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

          <Field label="Processing">
            <Segmented
              label="Processing"
              value={workspace.compute.useGpu ? "gpu" : "cpu"}
              choices={[
                { value: "gpu", label: "GPU (WebGPU)", disabled: !workspace.compute.gpuSupported },
                { value: "cpu", label: "CPU" },
              ]}
              onChange={(value) => workspace.compute.setUseGpu(value === "gpu")}
            />
          </Field>
          <Note>
            {workspace.compute.gpuSupported
              ? "Noise and ground detection run their heaviest stage as GPU compute shaders, with the CPU as fallback. "
              : "This browser has no WebGPU, so everything runs on the CPU. "}
            <a className="link-btn" href={benchmarkHref}>
              Compare CPU and GPU
            </a>
          </Note>

          <Field label="Moving around · Unreal Engine style">
            <dl className="stat-list">
              <div>
                <dt>Walk and turn</dt>
                <dd>Left-drag</dd>
              </div>
              <div>
                <dt>Look around</dt>
                <dd>Right-drag</dd>
              </div>
              <div>
                <dt>Fly while looking</dt>
                <dd>Right-drag + W A S D, Q E</dd>
              </div>
              <div>
                <dt>Fly speed</dt>
                <dd>Right-drag + scroll</dd>
              </div>
              <div>
                <dt>Pan</dt>
                <dd>Middle-drag, or left + right</dd>
              </div>
              <div>
                <dt>Orbit a point</dt>
                <dd>Alt + left-drag</dd>
              </div>
              <div>
                <dt>Dolly</dt>
                <dd>Alt + right-drag</dd>
              </div>
              <div>
                <dt>Zoom to cursor</dt>
                <dd>Scroll</dd>
              </div>
              <div>
                <dt>Fly to a point</dt>
                <dd>Double-click</dd>
              </div>
              <div>
                <dt>Hide the panels</dt>
                <dd>H</dd>
              </div>
            </dl>
          </Field>
          <Note>The same mouse layout as the Unreal Engine viewport. W A S D, the arrows, Q and E also work without a button held once you have clicked the scan; Shift is faster.</Note>
        </div>
      )}
    </Menu>
  );
}
