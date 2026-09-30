import { SampleAttribution } from "./SampleAbout.js";
import { useState, type ChangeEvent, type DragEvent } from "react";
import { Icon } from "../icons.js";
import { Menu, MenuItem, ProgressBar } from "../controls.js";
import { formatCount, formatLength, formatArea, formatVolume } from "../format.js";
import { measureBetween } from "../../core/point-inspection.js";
import { polygonAnchor } from "../../core/polygon-measure.js";
import type { ClickTool } from "./types.js";
import { supportedScanExtensions } from "../../import/scan-file-importer.js";
import { colorModeLabel, colorModeChoices } from "./colour.js";
import { Legend } from "./Legend.js";
import { Inspector } from "./Inspector.js";
import type { Workspace } from "./use-workspace.js";

/**
 * The scan itself, with everything that belongs over it: the tools that change
 * what a click does, the colour the points are drawn in, the key to that
 * colour, and whatever the last click found. A file dropped anywhere here
 * opens, which is what people try first.
 */
export function Viewport({ workspace }: { workspace: Workspace }) {
  const { canvasRef, fileInputRef, source, status, importProgress, picking, view, actions } = workspace;
  const [dragging, setDragging] = useState(false);
  const empty = source === undefined && importProgress === undefined && status !== "processing";
  const { picks } = picking;

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void actions.loadFile(file);
  };
  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) void actions.loadFile(file);
    event.target.value = "";
  };

  return (
    <div
      className={dragging ? "ws-view is-dropping" : "ws-view"}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <canvas ref={canvasRef} className="ws-canvas" />
      <input ref={fileInputRef} className="visually-hidden" type="file" accept={supportedScanExtensions.join(",")} onChange={onFileInput} />

      {source === undefined ? null : (
        <>
          <div className="ws-tools" role="group" aria-label="Click tool">
            {tools.map((tool) => (
              <button
                key={tool.value}
                type="button"
                className="icon-btn"
                aria-pressed={picking.clickTool === tool.value}
                aria-keyshortcuts={tool.key}
                title={`${tool.title} (${tool.key})`}
                onClick={() => picking.setClickTool(tool.value)}
              >
                <Icon name={tool.icon} />
              </button>
            ))}
            <span className="ws-tools-divider" />
            <button type="button" className="icon-btn" title="Undo (Ctrl+Z)" aria-keyshortcuts="Control+Z" disabled={!picking.canUndo} onClick={picking.undo}>
              <Icon name="undo" />
            </button>
            <button type="button" className="icon-btn" title="Redo (Ctrl+Shift+Z)" aria-keyshortcuts="Control+Shift+Z" disabled={!picking.canRedo} onClick={picking.redo}>
              <Icon name="redo" />
            </button>
            <span className="ws-tools-divider" />
            <button type="button" className="icon-btn" title="Frame the whole scan (F frames what is selected)" onClick={actions.resetView}>
              <Icon name="focus" />
            </button>
          </div>

          <div className="ws-colour">
            <Menu label={`Colour: ${colorModeLabel(view.colorMode)}`} align="start">
              {(close) =>
                colorModeChoices(view.supports).map((choice) => (
                  <MenuItem
                    key={choice.value}
                    label={choice.label}
                    hint={choice.hint}
                    disabled={choice.disabled}
                    onClick={() => {
                      close();
                      view.setColorMode(choice.value);
                    }}
                  />
                ))
              }
            </Menu>
          </div>

          <Legend workspace={workspace} />
          {workspace.shownSample === undefined ? null : <SampleAttribution sample={workspace.shownSample} />}
          <Inspector workspace={workspace} />
        </>
      )}

      {/* Every measurement keeps its label whichever tool is in hand, as measurements stay on the scan. */}
      <div ref={picking.measureLabelRef} className="ws-measure-labels" aria-hidden="true">
        {picks.rulers.map((ruler) =>
          ruler.to === undefined ? null : (
            <div key={`ruler-${ruler.id}`} className="ws-measure-label" data-anchor={JSON.stringify(midpoint(ruler.from.local, ruler.to.local))}>
              {picks.rulers.length > 1 ? <b>{ruler.id}</b> : null}
              {formatLength(measureBetween(ruler.from, ruler.to).distance)}
            </div>
          ),
        )}
        {picks.surfaces.map((each) => (
          <div key={`surface-${each.id}`} className="ws-measure-label ws-area-label" data-anchor={JSON.stringify(each.surface.centre)}>
            {picks.surfaces.length > 1 ? <b>{each.id}</b> : null}
            {formatArea(each.surface.planArea)}
          </div>
        ))}
        {picks.polygons.map((polygon) => {
          const result = picking.polygonResults.get(polygon.id);
          const anchor = polygon.closed ? polygonAnchor(polygon) : undefined;
          if (result === undefined || anchor === undefined || !result.valid) return null;
          // A volume earns its place on the label once there is a prism, or material standing on the base.
          const volume = polygon.height > 0 ? result.prism : result.cut >= result.planArea * 0.05 ? result.cut : undefined;
          const selected = polygon.id === picking.selectedPolygon && picking.clickTool === "polygon";
          return (
            <div
              key={`polygon-${polygon.id}`}
              className={selected ? "ws-measure-label ws-polygon-label is-selected" : "ws-measure-label ws-polygon-label"}
              data-anchor={JSON.stringify([anchor[0], picking.baseLevel(polygon) + polygon.height, anchor[2]])}
              data-place={selected ? "right" : undefined}
            >
              {picks.polygons.length > 1 ? <b>{polygon.id}</b> : null}
              {formatArea(result.planArea)}
              {volume === undefined ? null : <span>{` · ${formatVolume(volume)}`}</span>}
            </div>
          );
        })}
        <div ref={picking.previewLabelRef} className="ws-measure-label ws-preview-label" />
        {picking.entry === undefined ? null : <ValueEntryChip workspace={workspace} />}
      </div>

      {importProgress === undefined ? null : (
        <div className="ws-loading" aria-live="polite">
          <p>
            {importProgress.stage === "reading" ? "Reading the file" : importProgress.stage === "downloading" ? "Downloading the sample survey" : "Building detail levels"}
            <span>{`step ${importProgress.stage === "building" ? 2 : 1} of 2 · ${Math.round(importProgress.fraction * 100)}%`}</span>
          </p>
          <ProgressBar label="Opening the scan" fraction={importProgress.fraction} />
        </div>
      )}

      {empty ? (
        <div className="ws-empty">
          <span className="ws-empty-icon">
            <Icon name="upload" />
          </span>
          <h2>Open a LiDAR scan</h2>
          <p>Drop a LAS, LAZ or PLY file anywhere here, or start with the sample survey. Nothing is uploaded.</p>
          <div className="ws-empty-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={actions.openFilePicker}>
              <Icon name="folder" /> Choose a file
            </button>
            <button type="button" className="btn btn-lg" onClick={() => actions.loadSample()}>
              <Icon name="city" /> Load the sample survey
            </button>
          </div>
          <small>{`Up to ${formatCount(workspace.maxImportPoints)} points on this machine`}</small>
        </div>
      ) : null}

      {dragging ? <div className="ws-drop-hint">Drop to open this scan</div> : null}
    </div>
  );
}

function midpoint(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

const tools: ReadonlyArray<{ value: ClickTool; key: string; title: string; icon: "pointer" | "ruler" | "area" | "polygon" }> = [
  { value: "inspect", key: "I", title: "Inspect a point", icon: "pointer" },
  { value: "measure", key: "M", title: "Measure between two points", icon: "ruler" },
  { value: "polygon", key: "P", title: "Area and volume: draw a polygon on the scan", icon: "polygon" },
  { value: "area", key: "R", title: "Pick a surface: click a roof, a yard or a road", icon: "area" },
];

/** The number being typed for a polygon's height or base, beside its arrow until Enter applies it. */
function ValueEntryChip({ workspace }: { workspace: Workspace }) {
  const { picking } = workspace;
  const entry = picking.entry;
  const polygon = picking.picks.polygons.find((each) => each.id === entry?.polygon);
  const anchor = polygon === undefined ? undefined : polygonAnchor(polygon);
  if (entry === undefined || polygon === undefined || anchor === undefined) return null;
  const base = picking.baseLevel(polygon);
  const y = entry.target === "height" ? base + polygon.height : base;
  return (
    <div className="ws-measure-label ws-entry-label" data-anchor={JSON.stringify([anchor[0], y, anchor[2]])} data-place="left">
      {entry.target === "height" ? "Height " : "Base elevation "}
      <strong>{entry.text}</strong>
      <i className="ws-caret" />
      {" m"}
      <small>Enter · Tab switches · Esc</small>
    </div>
  );
}
