import { useState } from "react";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import { supportedScanExtensions } from "./import/scan-file-importer.js";
import { classificationColor, classificationName } from "./core/point-cloud-classification.js";
import type { DetectedObject } from "./core/object-detection.js";
import { measureBetween, type PointDetails } from "./core/point-inspection.js";
import { viewerConfig } from "./config.js";
import { formatCoordinate, formatCount, formatLength, formatNumber, formatOrigin, formatRampHeight, formatShare, ordinalSuffix } from "./ui/format.js";
import { countSummary, groundSummary, progressHeadline, terrainSummary } from "./ui/workspace/analysis-text.js";
import type { ImportProgress } from "./ui/workspace/types.js";
import { useWorkspace } from "./ui/workspace/use-workspace.js";

const budgetStep = 10_000;

export function App() {
  const workspace = useWorkspace({ loadSampleOnStart: true });
  const { canvasRef, fileInputRef, measureLabelRef, status, statusText, source, sourceLabel, sampling, importProgress, uiHidden } = workspace;
  const { colorMode, setColorMode, pointSize, setPointSize, pointShape, setPointShape, classHistogram, aboveGroundTop } = workspace.view;
  const { showBuildingOutlines, setShowBuildingOutlines, showTreeOutlines, setShowTreeOutlines, showSurface, setShowSurface, showContours, setShowContours, showPoints, setShowPoints } = workspace.view;
  const supportsRgb = workspace.view.supports.rgb;
  const supportsClassification = workspace.view.supports.classification;
  const supportsHeightAboveGround = workspace.view.supports.heightAboveGround;
  const supportsObjects = workspace.view.supports.objects;
  const { lodMode, setLodMode, pointBudget: effectivePointBudget, setPointBudget, budgetMaximum, lodSummary } = workspace.detail;
  const { analysing, hasGround, ground, detectGround, terrain, buildTerrain, count, countObjects } = workspace.analysis;
  const { clickTool, setClickTool, picks } = workspace.picking;
  const setPicks = (update: (current: typeof picks) => typeof picks) => {
    const next = update(picks);
    if (next.inspected === undefined && picks.inspected !== undefined) workspace.picking.clearInspected();
    if (next.from === undefined && picks.from !== undefined) workspace.picking.clearMeasurement();
  };
  const { exporting, exportError, exportBlocked, counted, exportScan } = workspace.exports;
  const loadProcedural = () => workspace.actions.loadSample();
  const loadFile = workspace.actions.loadFile;
  const [isDragging, setIsDragging] = useState(false);
  const budgetSliderMax = Math.max(budgetStep, Math.ceil(budgetMaximum / budgetStep) * budgetStep);
  const showsPickCard = (clickTool === "inspect" && picks.inspected !== undefined) || (clickTool === "measure" && picks.from !== undefined);
  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) void loadFile(file);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void loadFile(file);
  };

  return (
    <main className={["app-shell", uiHidden ? "ui-hidden" : "", showsPickCard ? "has-pick-card" : ""].filter(Boolean).join(" ")}>
      <section className="viewer-shell" aria-label="Interactive point cloud viewer">
        <canvas ref={canvasRef} className="point-cloud-canvas" />
        <div className="atmosphere atmosphere-one" />
        <div className="atmosphere atmosphere-two" />

        <header className="topbar">
          <a className="brand" href="#top" aria-label="Vertex LiDAR home">
            <span className="brand-mark"><i /><i /><i /></span>
            <span>VERTEX<span className="brand-slash">/</span>LIDAR</span>
          </a>
          <div className="topbar-center"><span className="live-dot" /> WEBGL 2 <span className="topbar-divider" /> POINT CLOUD LAB</div>
          <button className="subtle-button" type="button" onClick={() => loadProcedural()}>
            <Icon name="spark" /> Regenerate scene
          </button>
        </header>

        <div className="view-copy" id="top">
          <p className="eyebrow">REAL-TIME SPATIAL DATA</p>
          <h1>See the signal<br />inside the scan.</h1>
          <p className="lead">A performant, single-cloud LiDAR viewer built to make spatial data tangible.</p>
        </div>

        <div className="orbit-hint"><Icon name="orbit" /><span>DRAG TO ORBIT</span><span className="hint-separator">·</span><span>SCROLL TO ZOOM</span><span className="hint-separator">·</span><span>H TO HIDE UI</span></div>

        {clickTool === "inspect" && picks.inspected !== undefined && source !== undefined ? (
          <PointCard
            point={picks.inspected}
            georeferenced={source.isGeoreferenced}
            object={count.status === "done" ? count.objects.find((object) => object.id === picks.inspected?.objectId) : undefined}
            onClose={() => setPicks((current) => ({ from: current.from, to: current.to }))}
          />
        ) : null}
        {clickTool === "measure" && picks.from !== undefined ? (
          <MeasureCard from={picks.from} to={picks.to} onClose={() => setPicks((current) => ({ inspected: current.inspected }))} />
        ) : null}
        {clickTool === "measure" && picks.from !== undefined && picks.to !== undefined ? (
          <div
            ref={measureLabelRef}
            className="measure-label"
            aria-hidden="true"
            data-anchor={JSON.stringify(midpoint(picks.from.local, picks.to.local))}
          >
            {formatLength(measureBetween(picks.from, picks.to).distance)}
          </div>
        ) : null}

        <aside className="command-panel" aria-label="Point cloud controls">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">RENDER CONTROLS</p>
              <h2>Point cloud</h2>
            </div>
            <span className={`status-pill status-${status}`}><i />{status === "ready" ? "LIVE" : status === "error" ? "CHECK" : "SYNCING"}</span>
          </div>

          <div className="source-card">
            <span className="source-icon"><Icon name="layers" /></span>
            <div>
              <p>ACTIVE DATASET</p>
              <strong title={sourceLabel}>{sourceLabel}</strong>
              <small>{statusText}</small>
            </div>
          </div>
          {sampling === undefined ? null : (
            <p className="panel-footnote sampling-note">
              {`This scan has ${formatCount(sampling.total)} points, more than this build loads, so every ${Math.ceil(sampling.total / sampling.loaded)}${ordinalSuffix(Math.ceil(sampling.total / sampling.loaded))} point is shown: ${formatCount(sampling.loaded)} in all, spread evenly. Raise maxImportPoints in viewer-config.json on a machine with memory to spare.`}
            </p>
          )}

          <div className="control-block">
            <div className="control-label"><span>Click the scan to</span></div>
            <div className="segmented-control" role="group" aria-label="Click tool">
              <ModeButton active={clickTool === "inspect"} onClick={() => setClickTool("inspect")}>Inspect a point</ModeButton>
              <ModeButton active={clickTool === "measure"} onClick={() => setClickTool("measure")}>Measure</ModeButton>
            </div>
            <p className="panel-footnote">
              {clickTool === "inspect"
                ? "Click any point to see where it is, its class and its height. Esc clears."
                : "Click two points to measure the distance and height between them. Esc clears."}
            </p>
          </div>

          <div className="control-block">
            <div className="control-label"><span>LOD mode</span></div>
            <div className="segmented-control" role="group" aria-label="LOD mode">
              <ModeButton active={lodMode === "manual"} onClick={() => setLodMode("manual")}>Manual budget</ModeButton>
              <ModeButton active={lodMode === "distance"} onClick={() => setLodMode("distance")}>Camera distance</ModeButton>
            </div>
          </div>

          {lodMode === "manual" ? (
            <ControlRow label="Point budget" value={formatCount(effectivePointBudget)}>
              <input
                aria-label="Point budget"
                type="range"
                min={budgetStep}
                max={budgetSliderMax}
                step={budgetStep}
                value={Math.min(effectivePointBudget, budgetSliderMax)}
                onChange={(event) => setPointBudget(Number(event.target.value))}
              />
              <div className="range-ends"><span>10K</span><span>{formatCount(budgetMaximum)}</span></div>
            </ControlRow>
          ) : (
            <p className="panel-footnote">Detail now follows how far the camera is from the scan — zoom in for full resolution, pull back to save GPU work.</p>
          )}

          <ControlRow label="Point size" value={`${pointSize.toFixed(1)} px`}>
            <input aria-label="Point size" type="range" min={viewerConfig().pointSize.min} max={viewerConfig().pointSize.max} step="0.1" value={pointSize} onChange={(event) => setPointSize(Number(event.target.value))} />
            <div className="range-ends"><span>FINE</span><span>BOLD</span></div>
          </ControlRow>

          <div className="control-block color-control">
            <div className="control-label"><span>Point shape</span></div>
            <div className="segmented-control" role="group" aria-label="Point shape">
              <ModeButton active={pointShape === "circle"} onClick={() => setPointShape("circle")}>Circle</ModeButton>
              <ModeButton active={pointShape === "square"} onClick={() => setPointShape("square")}>Square</ModeButton>
            </div>
          </div>

          <div className="control-block color-control">
            <div className="control-label"><span>Color treatment</span></div>
            <div className="segmented-control segmented-control-wrap" role="group" aria-label="Color treatment">
              <ModeButton active={colorMode === "height"} onClick={() => setColorMode("height")}>Height</ModeButton>
              <ModeButton active={colorMode === "rgb"} disabled={!supportsRgb} onClick={() => setColorMode("rgb")}>RGB</ModeButton>
              <ModeButton active={colorMode === "relief"} onClick={() => setColorMode("relief")}>Relief</ModeButton>
              <ModeButton active={colorMode === "classification"} disabled={!supportsClassification} onClick={() => setColorMode("classification")}>Classes</ModeButton>
              <ModeButton active={colorMode === "heightAboveGround"} disabled={!supportsHeightAboveGround} onClick={() => setColorMode("heightAboveGround")}>Above ground</ModeButton>
              <ModeButton active={colorMode === "objects"} disabled={!supportsObjects} onClick={() => setColorMode("objects")}>Objects</ModeButton>
            </div>
          </div>

          {colorMode === "heightAboveGround" && supportsHeightAboveGround ? (
            <div className="control-block">
              <div className="control-label"><span>Height above ground</span><strong>0 to {aboveGroundTop} m</strong></div>
              <div className="height-ramp" aria-hidden="true" />
              <div className="height-ramp-labels">
                <span style={{ left: "9%" }}>Ground</span>
                <span style={{ left: "56%" }}>{formatRampHeight(aboveGroundTop / 4)}</span>
                <span style={{ left: "100%" }}>{formatRampHeight(aboveGroundTop)}</span>
              </div>
            </div>
          ) : null}

          {colorMode === "classification" && classHistogram.length > 0 ? (
            <div className="control-block">
              <div className="control-label"><span>Classes in scan</span><strong>{classHistogram.length}</strong></div>
              <ul className="class-legend">
                {classHistogram.slice(0, 8).map(({ code, count }) => (
                  <li key={code}>
                    <span className="class-swatch" style={{ background: classificationColor(code) }} />
                    <span className="class-name" title={`Code ${code}`}>{classificationName(code)}</span>
                    <span className="class-share">{formatShare(count, source?.pointCount ?? 1)}</span>
                  </li>
                ))}
              </ul>
              {classHistogram.length > 8 ? <p className="panel-footnote">{classHistogram.length - 8} more classes not shown.</p> : null}
            </div>
          ) : null}

          <div className="control-block">
            <div className="control-label">
              <span>Ground detection</span>
              <strong>{progressHeadline(ground) || "\u2014"}</strong>
            </div>
            <button
              className="analysis-button"
              type="button"
              disabled={source === undefined || status !== "ready" || analysing}
              onClick={() => void detectGround()}
            >
              {ground.status === "running" ? `${ground.stage}\u2026` : ground.status === "done" ? "Detect ground again" : "Detect ground"}
            </button>
            {ground.status === "running" ? (
              <div className="analysis-progress" role="progressbar" aria-label="Ground detection progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ground.fraction * 100)}>
                <i style={{ width: `${Math.round(ground.fraction * 100)}%` }} />
              </div>
            ) : null}
            <p className={ground.status === "failed" ? "panel-footnote analysis-error" : "panel-footnote"}>{groundSummary(ground)}</p>
          </div>

          <div className="control-block">
            <div className="control-label">
              <span>Terrain</span>
              <strong>{progressHeadline(terrain) || "\u2014"}</strong>
            </div>
            <button
              className="analysis-button"
              type="button"
              disabled={source === undefined || status !== "ready" || analysing || !hasGround}
              onClick={() => void buildTerrain()}
            >
              {terrain.status === "running" ? `${terrain.stage}\u2026` : terrain.status === "done" ? "Build terrain again" : "Build terrain"}
            </button>
            {terrain.status === "running" ? (
              <div className="analysis-progress" role="progressbar" aria-label="Terrain progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(terrain.fraction * 100)}>
                <i style={{ width: `${Math.round(terrain.fraction * 100)}%` }} />
              </div>
            ) : null}
            <p className={terrain.status === "failed" ? "panel-footnote analysis-error" : "panel-footnote"}>{terrainSummary(terrain, hasGround, source?.origin[1] ?? 0)}</p>
            {terrain.status === "done" ? (
              <div className="segmented-control outline-toggles" role="group" aria-label="Terrain layers">
                <ToggleButton pressed={showSurface} onClick={() => setShowSurface((shown) => !shown)}>Surface</ToggleButton>
                <ToggleButton pressed={showContours} onClick={() => setShowContours((shown) => !shown)}>Contours</ToggleButton>
                <ToggleButton pressed={showPoints} onClick={() => setShowPoints((shown) => !shown)}>Points</ToggleButton>
              </div>
            ) : null}
          </div>

          <div className="control-block">
            <div className="control-label">
              <span>Buildings and trees</span>
              <strong>{progressHeadline(count) || "\u2014"}</strong>
            </div>
            <button
              className="analysis-button"
              type="button"
              disabled={source === undefined || status !== "ready" || analysing}
              onClick={() => void countObjects()}
            >
              {count.status === "running" ? `${count.stage}\u2026` : count.status === "done" ? "Count again" : "Count buildings and trees"}
            </button>
            {count.status === "running" ? (
              <div className="analysis-progress" role="progressbar" aria-label="Counting progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(count.fraction * 100)}>
                <i style={{ width: `${Math.round(count.fraction * 100)}%` }} />
              </div>
            ) : null}
            {count.status === "done" ? (
              <div className="object-tally">
                <div className="object-tally-buildings">
                  <strong>{count.stats.buildings.toLocaleString("en-US")}</strong>
                  <span>{count.stats.buildings === 1 ? "Building" : "Buildings"}</span>
                </div>
                <div className="object-tally-trees">
                  <strong>{count.stats.trees.toLocaleString("en-US")}</strong>
                  <span>{count.stats.trees === 1 ? "Tree" : "Trees"}</span>
                </div>
              </div>
            ) : null}
            <p className={count.status === "failed" ? "panel-footnote analysis-error" : "panel-footnote"}>{countSummary(count)}</p>
            {count.status === "done" ? (
              <div className="segmented-control outline-toggles" role="group" aria-label="Outlines">
                <ToggleButton pressed={showBuildingOutlines} onClick={() => setShowBuildingOutlines((shown) => !shown)}>Building outlines</ToggleButton>
                <ToggleButton pressed={showTreeOutlines} onClick={() => setShowTreeOutlines((shown) => !shown)}>Tree outlines</ToggleButton>
              </div>
            ) : null}
          </div>

          <div className="control-block">
            <div className="control-label">
              <span>Export</span>
              <strong>{source?.spatialReference?.epsg === undefined ? (source?.isGeoreferenced ? "WORLD COORDS" : "LOCAL COORDS") : `EPSG:${source.spatialReference.epsg}`}</strong>
            </div>
            <div className="export-grid">
              <ExportButton label="Inventory" format="CSV" busy={exporting === "inventory"} disabled={exportBlocked || !counted} onClick={() => void exportScan("inventory")} />
              <ExportButton label="Map layer" format="GeoJSON" busy={exporting === "geojson"} disabled={exportBlocked || !counted} onClick={() => void exportScan("geojson")} />
              <ExportButton label="Classified points" format="LAS" busy={exporting === "las"} disabled={exportBlocked || !supportsClassification} onClick={() => void exportScan("las")} />
              <ExportButton label="Class summary" format="CSV" busy={exporting === "classes"} disabled={exportBlocked || !supportsClassification} onClick={() => void exportScan("classes")} />
              <ExportButton label="Terrain elevation" format="GeoTIFF" busy={exporting === "elevation"} disabled={exportBlocked || terrain.status !== "done"} onClick={() => void exportScan("elevation")} />
              <ExportButton label="Contour lines" format="GeoJSON" busy={exporting === "contours"} disabled={exportBlocked || terrain.status !== "done"} onClick={() => void exportScan("contours")} />
            </div>
            <p className={exportError === undefined ? "panel-footnote" : "panel-footnote analysis-error"}>
              {exportError ?? exportFootnote(counted, supportsClassification)}
            </p>
          </div>

          <button
            className={`drop-zone${isDragging ? " is-dragging" : ""}`}
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <span className="drop-icon"><Icon name="upload" /></span>
            <span><strong>Import a LiDAR scan</strong><small>Drop a .LAS, .LAZ or .PLY file or browse your device</small></span>
            <Icon name="arrow" />
          </button>
          {importProgress === undefined ? null : <ImportProgressBar progress={importProgress} />}
          <input ref={fileInputRef} className="visually-hidden" type="file" accept={supportedScanExtensions.join(",")} onChange={handleFileInput} />

          <p className="panel-footnote">Everything stays local in your browser. No scan data is uploaded.</p>
        </aside>

        <footer className="telemetry-bar">
          <Telemetry label="SOURCE POINTS" value={source === undefined ? "—" : formatCount(source.pointCount)} />
          <Telemetry label="GEOREF ORIGIN" value={source === undefined ? "—" : formatOrigin(source)} />
          {count.status === "done" ? <Telemetry label="BUILDINGS" value={count.stats.buildings.toLocaleString("en-US")} /> : null}
          {count.status === "done" ? <Telemetry label="TREES" value={count.stats.trees.toLocaleString("en-US")} /> : null}
          <Telemetry label="ACTIVE LOD" value={lodSummary?.focusTierId?.toUpperCase() ?? "—"} />
          <Telemetry label="DRAW BUDGET" value={lodSummary === undefined ? "—" : formatCount(lodSummary.drawnPointCount)} />
          <Telemetry label="TILES" value={lodSummary === undefined ? "—" : String(lodSummary.tileCount)} />
          <Telemetry label="LOD SOURCE" value={lodMode === "distance" ? "CAMERA DIST." : "MANUAL"} />
          <div className="telemetry-note"><span className="pulse-ring" />EDGE-READY RENDER PATH</div>
        </footer>
      </section>
    </main>
  );
}

function ControlRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return <div className="control-block"><div className="control-label"><span>{label}</span><strong>{value}</strong></div>{children}</div>;
}

/** A button that stays pressed or released, for switches that are not mutually exclusive. */
function ToggleButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={pressed ? "active" : ""} aria-pressed={pressed} onClick={onClick}>{children}</button>;
}

function PointCard({ point, georeferenced, object, onClose }: { point: PointDetails; georeferenced: boolean; object: DetectedObject | undefined; onClose: () => void }) {
  const rows: [string, string][] = [
    ["East", formatCoordinate(point.map[0])],
    ["North", formatCoordinate(point.map[1])],
    ["Elevation", formatLength(point.map[2])],
  ];
  if (point.classification !== undefined) rows.push(["Class", `${classificationName(point.classification)} (${point.classification})`]);
  if (point.heightAboveGround !== undefined) rows.push(["Above ground", formatLength(point.heightAboveGround)]);
  if (object !== undefined) {
    rows.push(["Object", `${object.kind === "building" ? "Building" : "Tree"} ${object.id} \u00b7 ${formatLength(object.height)} tall`]);
  } else if (point.objectId !== undefined) {
    rows.push(["Object", `#${point.objectId}`]);
  }
  if (point.returnNumber !== undefined && point.numberOfReturns !== undefined && point.numberOfReturns > 0) {
    rows.push(["Return", `${point.returnNumber} of ${point.numberOfReturns}`]);
  }
  if (point.intensity !== undefined) rows.push(["Intensity", formatNumber(point.intensity, 0)]);
  return (
    <section className="pick-card" aria-label="Inspected point" aria-live="polite">
      <header>
        <span>
          {point.color === undefined ? null : <i className="pick-swatch" style={{ background: `rgb(${point.color.join(",")})` }} />}
          {georeferenced ? "POINT" : "POINT \u00b7 LOCAL COORDINATES"}
        </span>
        <button type="button" onClick={onClose} aria-label="Clear the inspected point">{"\u00d7"}</button>
      </header>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>
  );
}

function MeasureCard({ from, to, onClose }: { from: PointDetails; to: PointDetails | undefined; onClose: () => void }) {
  const measurement = to === undefined ? undefined : measureBetween(from, to);
  return (
    <section className="pick-card" aria-label="Measurement" aria-live="polite">
      <header>
        <span>MEASUREMENT</span>
        <button type="button" onClick={onClose} aria-label="Clear the measurement">{"\u00d7"}</button>
      </header>
      {to === undefined || measurement === undefined ? (
        <p><i className="pick-dot pick-dot-from" />A is at {formatLength(from.map[2])} elevation. Click a second point.</p>
      ) : (
        <>
          <dl>
            <div><dt>Distance</dt><dd className="pick-headline">{formatLength(measurement.distance)}</dd></div>
            <div><dt>Horizontal</dt><dd>{formatLength(measurement.horizontal)}</dd></div>
            <div><dt>Height</dt><dd>{`${measurement.vertical >= 0 ? "+" : "\u2212"}${formatLength(Math.abs(measurement.vertical))}`}</dd></div>
            <div><dt>Slope</dt><dd>{`${measurement.slopeDegrees.toFixed(1)}\u00b0`}</dd></div>
          </dl>
          <p>
            <i className="pick-dot pick-dot-from" />A {formatLength(from.map[2])}
            <i className="pick-dot pick-dot-to" />B {formatLength(to.map[2])}
            <span className="pick-hint">Click again to start over</span>
          </p>
        </>
      )}
    </section>
  );
}





function ImportProgressBar({ progress }: { progress: ImportProgress }) {
  const percent = Math.round(progress.fraction * 100);
  const [step, label] = progress.stage === "reading" ? [1, "Reading the file"] : [2, "Building detail levels"];
  return (
    <div className="import-progress">
      <div className="control-label">
        <span>{label}</span>
        <strong>{`STEP ${step}/2 \u00b7 ${percent}%`}</strong>
      </div>
      <div className="analysis-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        {/* Keyed by stage, so the bar starts the second step from empty instead of sliding back from full. */}
        <i key={progress.stage} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ExportButton({ label, format, busy, disabled, onClick }: { label: string; format: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button className="analysis-button export-button" type="button" disabled={disabled} aria-busy={busy} onClick={onClick}>
      <span>{busy ? "Preparing…" : label}</span>
      <small>{format}</small>
    </button>
  );
}

function ModeButton({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={active ? "active" : ""} disabled={disabled} onClick={onClick}>{children}</button>;
}

function Telemetry({ label, value }: { label: string; value: string }) {
  return <div className="telemetry"><span>{label}</span><strong>{value}</strong></div>;
}

function Icon({ name }: { name: "spark" | "orbit" | "layers" | "upload" | "arrow" }) {
  const paths = {
    spark: <path d="m12 3-1.8 5.2L5 10l5.2 1.8L12 17l1.8-5.2L19 10l-5.2-1.8L12 3Zm6.5 11-.7 2-2 .7 2 .7.7 2 .7-2 2-.7-2-.7-.7-2Z" />,
    orbit: <><circle cx="12" cy="12" r="2.3" /><path d="M4.6 8.1c1.8-3 8.3-4.5 12.8-2.2 4.6 2.2 5.5 6.2 3.2 8.3-2.8 2.5-9.5 2-13.6-.3-3.7-2.1-4-4.7-2.4-5.8Z" /></>,
    layers: <><path d="m12 3 8 4.4-8 4.4-8-4.4L12 3Z" /><path d="m4 12 8 4.4 8-4.4M4 16.7l8 4.3 8-4.3" /></>,
    upload: <><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5" /><path d="M5 13.5v5.3c0 1 .8 1.7 1.7 1.7h10.6c1 0 1.7-.8 1.7-1.7v-5.3" /></>,
    arrow: <path d="M5 12h13m-5-5 5 5-5 5" />,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function midpoint(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function exportFootnote(counted: boolean, classified: boolean): string {
  if (!classified) {
    return "Count buildings and trees, or detect ground, to give this scan something to export. Files are made on this device.";
  }
  const las = "LAS files are uncompressed; the browser cannot write LAZ.";
  if (!counted) return `Classes can be exported now; the inventory and map layer need a count first. ${las}`;
  return `Positions are in the scan's own coordinate system. ${las}`;
}
