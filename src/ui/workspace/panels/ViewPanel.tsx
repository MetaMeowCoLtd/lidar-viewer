import { Field, Segmented, Toggle } from "../../controls.js";
import { viewerConfig } from "../../../config.js";
import { colorModeChoices } from "../colour.js";
import type { Workspace } from "../use-workspace.js";

/** How the scan is drawn: what colours the points, which layers are shown, and how big the dots are. */
export function ViewPanel({ workspace }: { workspace: Workspace }) {
  const { view, analysis } = workspace;
  const terrainBuilt = analysis.terrain.status === "done";
  const counted = analysis.count.status === "done";

  return (
    <div className="panel">
      <h2 className="panel-title">View</h2>

      <Field label="Colour by">
        <Segmented
          label="Colour by"
          value={view.colorMode}
          columns={2}
          choices={colorModeChoices(view.supports).map((choice) => ({ value: choice.value, label: choice.label, disabled: choice.disabled }))}
          onChange={view.setColorMode}
        />
      </Field>

      <Field label="Layers">
        <div className="toggle-list">
          <Toggle label="Points" pressed={view.showPoints} disabled={!terrainBuilt} onChange={view.setShowPoints} />
          <Toggle label="Terrain surface" pressed={view.showSurface} disabled={!terrainBuilt} onChange={view.setShowSurface} />
          <Toggle label="Contour lines" pressed={view.showContours} disabled={!terrainBuilt} onChange={view.setShowContours} />
          <Toggle
            label="Building outlines"
            swatch="var(--building)"
            pressed={view.showBuildingOutlines}
            disabled={!counted}
            onChange={view.setShowBuildingOutlines}
          />
          <Toggle label="Tree outlines" swatch="var(--tree)" pressed={view.showTreeOutlines} disabled={!counted} onChange={view.setShowTreeOutlines} />
        </div>
      </Field>

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
    </div>
  );
}
