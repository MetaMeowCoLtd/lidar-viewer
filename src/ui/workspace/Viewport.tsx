import { useState, type ChangeEvent, type DragEvent } from "react";
import { Icon } from "../icons.js";
import { Menu, MenuItem, ProgressBar } from "../controls.js";
import { formatCount, formatLength } from "../format.js";
import { measureBetween } from "../../core/point-inspection.js";
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
  const { canvasRef, fileInputRef, measureLabelRef, source, status, importProgress, picking, view, actions } = workspace;
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
            <button
              type="button"
              className="icon-btn"
              aria-pressed={picking.clickTool === "inspect"}
              title="Inspect a point"
              onClick={() => picking.setClickTool("inspect")}
            >
              <Icon name="pointer" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-pressed={picking.clickTool === "measure"}
              title="Measure between two points"
              onClick={() => picking.setClickTool("measure")}
            >
              <Icon name="ruler" />
            </button>
            <span className="ws-tools-divider" />
            <button type="button" className="icon-btn" title="Frame the whole scan" onClick={actions.resetView}>
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
          <Inspector workspace={workspace} />
        </>
      )}

      {picking.clickTool === "measure" && picks.from !== undefined && picks.to !== undefined ? (
        <div
          ref={measureLabelRef}
          className="ws-measure-label"
          aria-hidden="true"
          data-anchor={JSON.stringify(midpoint(picks.from.local, picks.to.local))}
        >
          {formatLength(measureBetween(picks.from, picks.to).distance)}
        </div>
      ) : null}

      {importProgress === undefined ? null : (
        <div className="ws-loading" aria-live="polite">
          <p>
            {importProgress.stage === "reading" ? "Reading the file" : importProgress.stage === "simulating" ? "Simulating the survey flight" : "Building detail levels"}
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
