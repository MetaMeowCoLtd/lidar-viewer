import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import { PointCloud, definedChannels, type PointCloudColorMode, type PointCloudPointShape } from "./core/point-cloud.js";
import type { PointCloudLodPyramid } from "./core/lod-pyramid.js";
import type { LodRenderSummary } from "./three/lidar-viewer.js";
import { ProceduralCloudGenerator } from "./core/procedural-cloud-generator.js";
import { importScanFile, supportedScanExtensions } from "./import/scan-file-importer.js";
import { LidarViewer } from "./three/lidar-viewer.js";
import { classificationColor, classificationName } from "./core/point-cloud-classification.js";
import { GroundDetectionCancelled, startGroundDetection, type GroundDetectionJob } from "./core/ground-detection-job.js";
import type { GroundDetectionStats } from "./core/ground-detection.js";
import { ObjectDetectionCancelled, startObjectDetection, type ObjectDetectionJob } from "./core/object-detection-job.js";
import type { DetectedObject, ObjectDetectionStats } from "./core/object-detection.js";
import { heightAboveGroundRampTop } from "./core/statistics.js";
import { viewerConfig } from "./config.js";
import { writeLas } from "./export/las-writer.js";
import { classSummaryCsv, objectInventoryCsv, objectsGeoJson } from "./export/object-inventory.js";
import { fileStem, saveFile } from "./export/save-file.js";

const INITIAL_POINT_COUNT = 380_000;
const budgetStep = 10_000;

type ViewerStatus = "initializing" | "processing" | "ready" | "error";

type ExportKind = "inventory" | "geojson" | "las" | "classes";

type GroundState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly stage: string; readonly fraction: number }
  | { readonly status: "done"; readonly stats: GroundDetectionStats; readonly seconds: number }
  | { readonly status: "failed"; readonly message: string };

type CountState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly stage: string; readonly fraction: number }
  | {
      readonly status: "done";
      readonly stats: ObjectDetectionStats;
      readonly objects: readonly DetectedObject[];
      readonly tallestBuilding: number;
      readonly treeHeights: readonly [number, number];
      readonly seconds: number;
    }
  | { readonly status: "failed"; readonly message: string };

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<LidarViewer | undefined>(undefined);
  const [pyramid, setPyramid] = useState<PointCloudLodPyramid>();
  const [status, setStatus] = useState<ViewerStatus>("initializing");
  const [statusText, setStatusText] = useState("Booting visualizer");
  const [pointBudget, setPointBudget] = useState(() => viewerConfig().defaultPointBudget);
  const [pointSize, setPointSize] = useState(() => viewerConfig().pointSize.default);
  const [colorMode, setColorMode] = useState<PointCloudColorMode>("rgb");
  const [pointShape, setPointShape] = useState<PointCloudPointShape>(() => viewerConfig().pointShape);
  const [isDragging, setIsDragging] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("Procedural city block");
  const [uiHidden, setUiHidden] = useState(false);
  const [lodMode, setLodMode] = useState<"manual" | "distance">(
    () => (viewerConfig().distanceLod.enabledByDefault ? "distance" : "manual"),
  );
  const [lodSummary, setLodSummary] = useState<LodRenderSummary>();
  const [ground, setGround] = useState<GroundState>({ status: "idle" });
  const groundJobRef = useRef<GroundDetectionJob | undefined>(undefined);
  const [count, setCount] = useState<CountState>({ status: "idle" });
  const countJobRef = useRef<ObjectDetectionJob | undefined>(undefined);
  const [showBuildingOutlines, setShowBuildingOutlines] = useState(true);
  const [showTreeOutlines, setShowTreeOutlines] = useState(true);
  const sourceRef = useRef<PointCloud | undefined>(undefined);
  const [exporting, setExporting] = useState<ExportKind>();
  const [exportError, setExportError] = useState<string>();

  const source = pyramid?.tiers[0]?.cloud;
  const effectivePointBudget = Math.min(pointBudget, source?.pointCount ?? pointBudget);
  const supportsRgb = source?.supportsColorMode("rgb") ?? false;
  const supportsClassification = source?.supportsColorMode("classification") ?? false;
  const supportsHeightAboveGround = source?.supportsColorMode("heightAboveGround") ?? false;
  const supportsObjects = source?.supportsColorMode("objects") ?? false;
  const analysing = ground.status === "running" || count.status === "running";
  const exportBlocked = source === undefined || status !== "ready" || analysing || exporting !== undefined;
  const counted = count.status === "done" && source?.objectId !== undefined;
  const budgetMaximum = source?.pointCount ?? viewerConfig().defaultPointBudget;
  const budgetSliderMax = Math.max(budgetStep, Math.ceil(budgetMaximum / budgetStep) * budgetStep);

  // A full pass over the class channel, so it is computed once per loaded
  // scan rather than on every render.
  const classHistogram = useMemo(() => source?.classificationHistogram() ?? [], [source]);
  const aboveGroundTop = useMemo(
    () => (source?.heightAboveGround === undefined ? 0 : heightAboveGroundRampTop(source.heightAboveGround)),
    [source],
  );

  // A layout effect runs before the browser paints, so the moment a new scan
  // appears on screen, a click on an analysis button already works on it. A
  // plain effect runs after the paint, and a click in between would start work
  // on the scan that was just replaced.
  useLayoutEffect(() => {
    sourceRef.current = source;
  }, [source]);

  // Exports read the objects of the count now on screen, not of the render that created the handler.
  const countRef = useRef(count);
  useLayoutEffect(() => {
    countRef.current = count;
  }, [count]);

  /** Abandons any analysis in flight and its results, for when the scan it was working on is replaced. */
  const resetAnalysis = useCallback(() => {
    groundJobRef.current?.cancel();
    groundJobRef.current = undefined;
    countJobRef.current?.cancel();
    countJobRef.current = undefined;
    setGround({ status: "idle" });
    setCount({ status: "idle" });
  }, []);

  const loadProcedural = useCallback((seed = Math.floor(Math.random() * 1_000_000)) => {
    const viewer = viewerRef.current;
    if (viewer === undefined) return;
    resetAnalysis();
    setSourceLabel("Procedural city block");
    void viewer.load(
      new ProceduralCloudGenerator().generate({ pointCount: INITIAL_POINT_COUNT, seed }),
      createLodSpecs(115),
    );
  }, [resetAnalysis]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const viewer = new LidarViewer(canvas, {
      pointBudget: viewerConfig().defaultPointBudget,
      pointSize,
      distanceBasedLod: viewerConfig().distanceLod.enabledByDefault,
    });
    viewerRef.current = viewer;
    const unsubscribeTier = viewer.onLodSummaryChange(setLodSummary);
    const unsubscribe = viewer.session.subscribe((nextState) => {
      if (nextState.status === "processing") {
        setStatus("processing");
        setStatusText(nextState.sourceName);
      }
      if (nextState.status === "ready") {
        setPyramid(nextState.pyramid);
        setStatus("ready");
        setStatusText("Interactive render ready");
      }
      if (nextState.status === "error") {
        setStatus("error");
        setStatusText(nextState.error.message);
      }
    });
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) viewer.resize(entry.contentRect.width, entry.contentRect.height);
    });
    resizeObserver.observe(canvas.parentElement!);
    viewer.start();
    loadProcedural(21);

    return () => {
      unsubscribe();
      unsubscribeTier();
      resizeObserver.disconnect();
      viewer.dispose();
      viewerRef.current = undefined;
    };
  }, [loadProcedural]);

  useEffect(() => {
    viewerRef.current?.setDistanceBasedLodEnabled(lodMode === "distance");
  }, [lodMode]);

  useEffect(() => {
    viewerRef.current?.setPointBudget(effectivePointBudget);
  }, [effectivePointBudget]);

  useEffect(() => {
    if (source !== undefined && pointBudget > source.pointCount) {
      setPointBudget(source.pointCount);
    }
  }, [pointBudget, source]);

  useEffect(() => {
    viewerRef.current?.setPointSize(pointSize);
  }, [pointSize]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "h" || event.metaKey || event.ctrlKey || event.altKey) return;
      setUiHidden((hidden) => !hidden);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    viewerRef.current?.setPointShape(pointShape);
  }, [pointShape]);

  useEffect(() => {
    if (source !== undefined && !source.supportsColorMode(colorMode)) {
      setColorMode("height");
      return;
    }
    viewerRef.current?.setColorMode(colorMode);
  }, [colorMode, source]);

  const loadFile = useCallback(async (file: File) => {
    try {
      resetAnalysis();
      setSourceLabel(file.name);
      setStatus("processing");
      setStatusText("Reading local scan");
      const cloud = await importScanFile(file);
      await viewerRef.current?.load(cloud, createLodSpecs(cloud.bounds.diagonal));
    } catch (error) {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "Unable to load that scan");
    }
  }, [resetAnalysis]);

  const detectGround = useCallback(async () => {
    const viewer = viewerRef.current;
    const cloud = sourceRef.current;
    if (viewer === undefined || cloud === undefined) return;
    groundJobRef.current?.cancel();
    const started = performance.now();
    setGround({ status: "running", stage: "Starting", fraction: 0 });
    const job = startGroundDetection(cloud, viewerConfig().groundDetection, (stage, fraction) => {
      if (groundJobRef.current === job) setGround({ status: "running", stage, fraction });
    });
    groundJobRef.current = job;
    try {
      const result = await job.result;
      if (groundJobRef.current !== job) return;
      // The user may have opened another scan while this one was analysed;
      // the result is for a scan no longer on screen, so it is dropped.
      if (sourceRef.current !== cloud) {
        groundJobRef.current = undefined;
        setGround({ status: "idle" });
        return;
      }
      // Rebuilding every detail level with the new labels takes seconds on a
      // large scan, and saying so beats a progress bar stuck at its end.
      setGround({ status: "running", stage: "Updating the view", fraction: 1 });
      await viewer.replaceCloud(
        new PointCloud({
          positions: cloud.positions,
          ...channelsWithoutObjects(cloud),
          classification: result.classification,
          heightAboveGround: result.heightAboveGround,
          bounds: cloud.bounds,
          origin: cloud.origin,
          spatialReference: cloud.spatialReference,
          name: cloud.name,
        }),
      );
      if (groundJobRef.current !== job) return;
      groundJobRef.current = undefined;
      setCount({ status: "idle" });
      setColorMode("heightAboveGround");
      setGround({ status: "done", stats: result.stats, seconds: (performance.now() - started) / 1000 });
    } catch (error) {
      if (error instanceof GroundDetectionCancelled || groundJobRef.current !== job) return;
      groundJobRef.current = undefined;
      setGround({ status: "failed", message: error instanceof Error ? error.message : "Ground detection failed" });
    }
  }, []);

  const countObjects = useCallback(async () => {
    const viewer = viewerRef.current;
    const cloud = sourceRef.current;
    if (viewer === undefined || cloud === undefined) return;
    countJobRef.current?.cancel();
    const started = performance.now();
    // The worker spends the first 45% of its progress on ground detection when
    // it has to run it; noting when progress passes that point times it.
    let groundFinished = started;
    setCount({ status: "running", stage: "Starting", fraction: 0 });
    const job = startObjectDetection(cloud, viewerConfig().groundDetection, viewerConfig().objectDetection, (stage, fraction) => {
      if (fraction <= 0.45) groundFinished = performance.now();
      if (countJobRef.current === job) setCount({ status: "running", stage, fraction });
    });
    countJobRef.current = job;
    try {
      const result = await job.result;
      if (countJobRef.current !== job) return;
      if (sourceRef.current !== cloud) {
        countJobRef.current = undefined;
        setCount({ status: "idle" });
        return;
      }
      setCount({ status: "running", stage: "Updating the view", fraction: 1 });
      await viewer.replaceCloud(
        new PointCloud({
          positions: cloud.positions,
          ...definedChannels(cloud),
          classification: result.classification,
          heightAboveGround: result.heightAboveGround,
          objectId: result.objectId,
          bounds: cloud.bounds,
          origin: cloud.origin,
          spatialReference: cloud.spatialReference,
          name: cloud.name,
        }),
      );
      if (countJobRef.current !== job) return;
      countJobRef.current = undefined;
      // Outlines belong to the cloud now on screen, so they go in after it.
      viewer.setObjects(result.objects);
      const seconds = (performance.now() - started) / 1000;
      if (result.groundStats !== undefined) {
        setGround({ status: "done", stats: result.groundStats, seconds: (groundFinished - started) / 1000 });
      }
      let tallestBuilding = 0;
      let shortestTree = Infinity;
      let tallestTree = 0;
      for (const object of result.objects) {
        if (object.kind === "building") tallestBuilding = Math.max(tallestBuilding, object.height);
        else {
          shortestTree = Math.min(shortestTree, object.height);
          tallestTree = Math.max(tallestTree, object.height);
        }
      }
      setColorMode("objects");
      setCount({
        status: "done",
        stats: result.stats,
        objects: result.objects,
        tallestBuilding,
        treeHeights: [Number.isFinite(shortestTree) ? shortestTree : 0, tallestTree],
        seconds,
      });
    } catch (error) {
      if (error instanceof ObjectDetectionCancelled || countJobRef.current !== job) return;
      countJobRef.current = undefined;
      setCount({ status: "failed", message: error instanceof Error ? error.message : "Counting buildings and trees failed" });
    }
  }, []);

  const exportScan = useCallback(async (kind: ExportKind) => {
    const cloud = sourceRef.current;
    if (cloud === undefined) return;
    setExporting(kind);
    setExportError(undefined);
    try {
      // Writing a large LAS file holds the main thread for a moment, so the
      // button's "Preparing" label is given time to paint first. A timer rather
      // than an animation frame, which never arrives in a hidden tab.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stem = fileStem(cloud.name);
      if (kind === "las") {
        saveFile(writeLas(cloud) as BlobPart[], `${stem}-classified.las`, "application/vnd.las");
      } else if (kind === "classes") {
        saveFile([classSummaryCsv(cloud)], `${stem}-classes.csv`, "text/csv");
      } else {
        const objects = countRef.current.status === "done" ? countRef.current.objects : [];
        if (kind === "inventory") saveFile([objectInventoryCsv(cloud, objects)], `${stem}-inventory.csv`, "text/csv");
        else saveFile([objectsGeoJson(cloud, objects)], `${stem}-objects.geojson`, "application/geo+json");
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "The export could not be written");
    } finally {
      setExporting(undefined);
    }
  }, []);

  useEffect(() => {
    viewerRef.current?.setOutlineVisibility(showBuildingOutlines, showTreeOutlines);
  }, [showBuildingOutlines, showTreeOutlines]);

  useEffect(
    () => () => {
      groundJobRef.current?.cancel();
      countJobRef.current?.cancel();
    },
    [],
  );

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
    <main className={uiHidden ? "app-shell ui-hidden" : "app-shell"}>
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
              <strong>{groundHeadline(ground)}</strong>
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
            <p className={ground.status === "failed" ? "panel-footnote analysis-error" : "panel-footnote"}>{groundFootnote(ground)}</p>
          </div>

          <div className="control-block">
            <div className="control-label">
              <span>Buildings and trees</span>
              <strong>{countHeadline(count)}</strong>
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
            <p className={count.status === "failed" ? "panel-footnote analysis-error" : "panel-footnote"}>{countFootnote(count)}</p>
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

function createLodSpecs(diagonal: number) {
  const scale = Math.max(diagonal, 1);
  const { fine, balanced, lean } = viewerConfig().lodDivisors;
  const distance = viewerConfig().distanceLod.distanceMultipliers;
  return [
    { id: "full", voxelSize: 0, minCameraDistance: scale * distance.full },
    { id: "fine", voxelSize: scale / fine, minCameraDistance: scale * distance.fine },
    { id: "balanced", voxelSize: scale / balanced, minCameraDistance: scale * distance.balanced },
    { id: "lean", voxelSize: scale / lean, minCameraDistance: scale * distance.lean },
  ];
}

function ControlRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return <div className="control-block"><div className="control-label"><span>{label}</span><strong>{value}</strong></div>{children}</div>;
}

/** A button that stays pressed or released, for switches that are not mutually exclusive. */
function ToggleButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={pressed ? "active" : ""} aria-pressed={pressed} onClick={onClick}>{children}</button>;
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

/**
 * A label on the height key. The ramp is square-root scaled, so its midpoint
 * sits at a quarter of the top height rather than half of it.
 */
function formatRampHeight(metres: number): string {
  return `${metres < 10 ? metres.toFixed(1) : Math.round(metres)} m`;
}

/** A cloud's channels without its object ids, which a new classification makes stale. */
function channelsWithoutObjects(cloud: PointCloud) {
  const { objectId: _stale, ...channels } = definedChannels(cloud);
  return channels;
}

function exportFootnote(counted: boolean, classified: boolean): string {
  if (!classified) {
    return "Count buildings and trees, or detect ground, to give this scan something to export. Files are made on this device.";
  }
  const las = "LAS files are uncompressed; the browser cannot write LAZ.";
  if (!counted) return `Classes can be exported now; the inventory and map layer need a count first. ${las}`;
  return `Positions are in the scan's own coordinate system. ${las}`;
}

function countHeadline(count: CountState): string {
  if (count.status === "running") return `${Math.round(count.fraction * 100)}%`;
  if (count.status === "done") return `${count.seconds.toFixed(1)} s`;
  return "\u2014";
}

function countFootnote(count: CountState): string {
  if (count.status === "failed") return count.message;
  if (count.status !== "done") {
    return "Finds each building and tree standing on the ground, outlines it and counts it. Detects ground first when the scan needs it.";
  }
  const { stats, tallestBuilding, treeHeights } = count;
  const buildings =
    stats.buildings === 0
      ? "No buildings found."
      : `Footprints cover ${Math.round(stats.footprintArea).toLocaleString("en-US")} m\u00b2, the tallest building rising ${formatRampHeight(tallestBuilding)}.`;
  const trees =
    stats.trees === 0
      ? "No trees found."
      : stats.trees === 1
        ? `The tree stands ${formatRampHeight(treeHeights[1])} tall.`
        : `Trees stand ${formatRampHeight(treeHeights[0])} to ${formatRampHeight(treeHeights[1])} tall.`;
  return `${buildings} ${trees}`;
}

function groundHeadline(ground: GroundState): string {
  if (ground.status === "running") return `${Math.round(ground.fraction * 100)}%`;
  if (ground.status === "done") return formatShare(ground.stats.groundPoints, ground.stats.pointCount);
  return "\u2014";
}

function groundFootnote(ground: GroundState): string {
  if (ground.status === "failed") return ground.message;
  if (ground.status !== "done") {
    return "Finds the terrain under buildings and trees, and measures how high everything stands above it.";
  }
  const { stats, seconds } = ground;
  const parts = [`${formatShare(stats.groundPoints, stats.pointCount)} of points are ground`];
  if (stats.lowNoisePoints > 0) parts.push(`${formatCount(stats.lowNoisePoints)} flagged as low noise`);
  if (stats.preservedPoints > 0) parts.push(`existing classes kept on ${formatCount(stats.preservedPoints)}`);
  const cell = stats.cellSize < 10 ? stats.cellSize.toFixed(1) : String(Math.round(stats.cellSize));
  return `${parts.join(", ")}. Surface built on a ${cell} m grid in ${seconds.toFixed(1)} s.`;
}

function formatShare(count: number, total: number): string {
  const share = (count / total) * 100;
  if (share >= 10) return `${Math.round(share)}%`;
  if (share >= 1) return `${share.toFixed(1)}%`;
  return share > 0 ? "<1%" : "0%";
}

/**
 * Positions are held relative to the cloud's origin so a projected coordinate
 * never has to survive a narrowing to Float32. Showing that offset is how a
 * user confirms a scan was recognised as georeferenced rather than local.
 */
function formatOrigin(cloud: { origin: readonly [number, number, number]; isGeoreferenced: boolean }): string {
  if (!cloud.isGeoreferenced) return "LOCAL";
  return cloud.origin.map((value) => value.toLocaleString("en-US", { maximumFractionDigits: 0 })).join(" / ");
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
