import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PointCloud, definedChannels, type PointCloudColorMode, type PointCloudPointShape } from "../../core/point-cloud.js";
import type { PointCloudLodPyramid } from "../../core/lod-pyramid.js";
import { ProceduralCloudGenerator } from "../../core/procedural-cloud-generator.js";
import { ScanImportCancelled, startScanImport, type ScanImportJob } from "../../import/scan-import-job.js";
import { LidarViewer, type LodRenderSummary } from "../../three/lidar-viewer.js";
import { GroundDetectionCancelled, startGroundDetection, type GroundDetectionJob } from "../../core/ground-detection-job.js";
import { ObjectDetectionCancelled, startObjectDetection, type ObjectDetectionJob } from "../../core/object-detection-job.js";
import { heightAboveGroundRampTop } from "../../core/statistics.js";
import { viewerConfig } from "../../config.js";
import { createLodSpecs } from "../lod-specs.js";
import { writeLas } from "../../export/las-writer.js";
import { classSummaryCsv, objectInventoryCsv, objectsGeoJson } from "../../export/object-inventory.js";
import { fileStem, saveFile } from "../../export/save-file.js";
import { describePoint } from "../../core/point-inspection.js";
import { TerrainCancelled, startTerrainBuild, type TerrainJob } from "../../core/terrain-job.js";
import { contoursGeoJson, terrainGeoTiff } from "../../export/terrain-export.js";
import type {
  ClickTool,
  CountState,
  ExportKind,
  GroundState,
  ImportProgress,
  LodMode,
  Picks,
  Sampling,
  TerrainState,
  ViewerStatus,
} from "./types.js";

const samplePointCount = 600_000;
const sampleName = "Sample city block";

export interface WorkspaceOptions {
  /** Load the procedural sample as soon as the viewer starts. */
  readonly loadSampleOnStart: boolean;
}

/**
 * Everything the workspace knows and can do: the scan on screen, the analyses
 * run on it, what the user has clicked, and how it is drawn.
 *
 * The viewer itself is imperative and owns the render loop; this hook is the
 * bridge that keeps React state and the viewer in step. Long-running work -
 * reading a file, detecting ground, counting, building terrain - runs as jobs
 * on workers, and each job is checked against the one currently running when
 * it settles, so a result for a scan that has since been replaced is dropped
 * rather than applied to the wrong scan.
 */
export function useWorkspace(options: WorkspaceOptions) {
  const { loadSampleOnStart } = options;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const measureLabelRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<LidarViewer | undefined>(undefined);
  const [pyramid, setPyramid] = useState<PointCloudLodPyramid>();
  const [status, setStatus] = useState<ViewerStatus>("initializing");
  const [statusText, setStatusText] = useState("No scan open");
  const [pointBudget, setPointBudget] = useState(() => viewerConfig().defaultPointBudget);
  const [pointSize, setPointSize] = useState(() => viewerConfig().pointSize.default);
  const [colorMode, setColorMode] = useState<PointCloudColorMode>("rgb");
  const [pointShape, setPointShape] = useState<PointCloudPointShape>(() => viewerConfig().pointShape);
  const [sourceLabel, setSourceLabel] = useState("");
  const [uiHidden, setUiHidden] = useState(false);
  const [lodMode, setLodMode] = useState<LodMode>(() => (viewerConfig().distanceLod.enabledByDefault ? "distance" : "manual"));
  const [lodSummary, setLodSummary] = useState<LodRenderSummary>();
  const [ground, setGround] = useState<GroundState>({ status: "idle" });
  const groundJobRef = useRef<GroundDetectionJob | undefined>(undefined);
  const [count, setCount] = useState<CountState>({ status: "idle" });
  const countJobRef = useRef<ObjectDetectionJob | undefined>(undefined);
  const importJobRef = useRef<ScanImportJob | undefined>(undefined);
  const [importProgress, setImportProgress] = useState<ImportProgress>();
  // Counts imports, so progress from one that was superseded never lands on the bar of the next.
  const importRunRef = useRef(0);
  const [sampling, setSampling] = useState<Sampling>();
  const [showBuildingOutlines, setShowBuildingOutlines] = useState(true);
  const [showTreeOutlines, setShowTreeOutlines] = useState(true);
  const sourceRef = useRef<PointCloud | undefined>(undefined);
  const [exporting, setExporting] = useState<ExportKind>();
  const [exportError, setExportError] = useState<string>();
  const [terrain, setTerrain] = useState<TerrainState>({ status: "idle" });
  const terrainJobRef = useRef<TerrainJob | undefined>(undefined);
  const [showSurface, setShowSurface] = useState(true);
  const [showContours, setShowContours] = useState(true);
  const [showPoints, setShowPoints] = useState(true);
  const [clickTool, setClickTool] = useState<ClickTool>("inspect");
  const clickToolRef = useRef(clickTool);
  const [picks, setPicks] = useState<Picks>({});

  const source = pyramid?.tiers[0]?.cloud;
  // The budget the user chose is kept as chosen and only capped here, per scan.
  // Writing the cap back into it would shrink the budget to the size of a small
  // scan and leave the next, larger one drawn at a fraction of its detail.
  const effectivePointBudget = Math.min(pointBudget, source?.pointCount ?? pointBudget);
  const supports = {
    rgb: source?.supportsColorMode("rgb") ?? false,
    classification: source?.supportsColorMode("classification") ?? false,
    heightAboveGround: source?.supportsColorMode("heightAboveGround") ?? false,
    objects: source?.supportsColorMode("objects") ?? false,
  };
  const analysing = ground.status === "running" || count.status === "running" || terrain.status === "running";
  const importing = importProgress !== undefined;
  const exportBlocked = source === undefined || status !== "ready" || analysing || exporting !== undefined;
  const counted = count.status === "done" && source?.objectId !== undefined;
  const budgetMaximum = source?.pointCount ?? viewerConfig().defaultPointBudget;

  // A full pass over the class channel, so it is computed once per loaded
  // scan rather than on every render.
  const classHistogram = useMemo(() => source?.classificationHistogram() ?? [], [source]);
  const hasGround = classHistogram.some(({ code, count: points }) => code === 2 && points >= 100);
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

  useLayoutEffect(() => {
    clickToolRef.current = clickTool;
  }, [clickTool]);

  const terrainRef = useRef(terrain);
  useLayoutEffect(() => {
    terrainRef.current = terrain;
  }, [terrain]);

  /** Drops the terrain, for when the ground it was built from is replaced. */
  const clearTerrain = useCallback(() => {
    terrainJobRef.current?.cancel();
    terrainJobRef.current = undefined;
    setTerrain({ status: "idle" });
    setShowPoints(true);
    viewerRef.current?.setTerrain(undefined, undefined);
  }, []);

  /** Abandons any analysis in flight and its results, for when the scan it was working on is replaced. */
  const resetAnalysis = useCallback(() => {
    setPicks({});
    importJobRef.current?.cancel();
    importJobRef.current = undefined;
    importRunRef.current += 1;
    setImportProgress(undefined);
    groundJobRef.current?.cancel();
    groundJobRef.current = undefined;
    countJobRef.current?.cancel();
    countJobRef.current = undefined;
    setGround({ status: "idle" });
    setCount({ status: "idle" });
    clearTerrain();
  }, [clearTerrain]);

  const loadSample = useCallback((seed = Math.floor(Math.random() * 1_000_000)) => {
    const viewer = viewerRef.current;
    if (viewer === undefined) return;
    resetAnalysis();
    setSampling(undefined);
    setSourceLabel(sampleName);
    const cloud = new ProceduralCloudGenerator().generate({ pointCount: samplePointCount, seed, name: sampleName });
    void viewer.load(cloud, createLodSpecs(cloud.bounds.diagonal));
  }, [resetAnalysis]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const viewer = new LidarViewer(canvas, {
      pointBudget: viewerConfig().defaultPointBudget,
      pointSize: viewerConfig().pointSize.default,
      distanceBasedLod: viewerConfig().distanceLod.enabledByDefault,
      // The viewport is the whole window here, so a scan can sit closer than
      // the configured default without running out of the frame.
      framingDistance: viewerConfig().camera.framingDistance * 0.72,
    });
    viewerRef.current = viewer;
    const unsubscribeTier = viewer.onLodSummaryChange(setLodSummary);
    const unsubscribeClick = viewer.onPointClick((hit) => {
      const details = hit === undefined ? undefined : describePoint(hit.cloud, hit.index);
      if (clickToolRef.current === "inspect") {
        setPicks((current) => ({ ...current, inspected: details }));
        return;
      }
      // A miss while measuring is most likely a slip, so it keeps what was measured.
      if (details === undefined) return;
      setPicks((current) =>
        current.from === undefined || current.to !== undefined ? { inspected: current.inspected, from: details } : { ...current, to: details },
      );
    });
    // The measurement label follows its line as the camera moves, written
    // straight to the element each frame rather than through React state.
    const unsubscribeFrame = viewer.onFrame(() => {
      const label = measureLabelRef.current;
      const anchor = label?.dataset.anchor;
      if (label === null || anchor === undefined) return;
      const spot = viewer.projectToCanvas(JSON.parse(anchor) as [number, number, number]);
      label.style.visibility = spot.visible ? "visible" : "hidden";
      label.style.transform = `translate(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px) translate(-50%, -140%)`;
    });
    const unsubscribe = viewer.session.subscribe((nextState) => {
      if (nextState.status === "processing") {
        setStatus("processing");
        setStatusText("Building detail levels");
      }
      if (nextState.status === "ready") {
        setPyramid(nextState.pyramid);
        setStatus("ready");
        setStatusText("Ready");
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
    if (loadSampleOnStart) loadSample(21);

    return () => {
      unsubscribe();
      unsubscribeTier();
      unsubscribeClick();
      unsubscribeFrame();
      resizeObserver.disconnect();
      viewer.dispose();
      viewerRef.current = undefined;
    };
  }, [loadSample]);

  useEffect(() => {
    viewerRef.current?.setDistanceBasedLodEnabled(lodMode === "distance");
  }, [lodMode]);

  useEffect(() => {
    viewerRef.current?.setPointBudget(effectivePointBudget);
  }, [effectivePointBudget]);

  useEffect(() => {
    viewerRef.current?.setPointSize(pointSize);
  }, [pointSize]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "h") setUiHidden((hidden) => !hidden);
      if (event.key === "Escape") setPicks({});
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
    resetAnalysis();
    const run = importRunRef.current;
    try {
      const report = (stage: ImportProgress["stage"], fraction: number) => {
        if (importRunRef.current === run) setImportProgress({ stage, fraction });
      };
      setSourceLabel(file.name);
      setStatus("processing");
      setStatusText("Reading the file");
      setSampling(undefined);
      report("reading", 0);
      const job = startScanImport(file, viewerConfig().maxImportPoints, (fraction) => {
        if (importJobRef.current !== job) return;
        report("reading", fraction);
      });
      importJobRef.current = job;
      const { cloud, sourcePointCount } = await job.result;
      // Another scan was chosen while this one was being read.
      if (importJobRef.current !== job) return;
      importJobRef.current = undefined;
      if (sourcePointCount > cloud.pointCount) setSampling({ loaded: cloud.pointCount, total: sourcePointCount });
      report("building", 0);
      await viewerRef.current?.load(cloud, createLodSpecs(cloud.bounds.diagonal), (fraction) => report("building", fraction));
      if (importRunRef.current === run) setImportProgress(undefined);
    } catch (error) {
      if (error instanceof ScanImportCancelled || importRunRef.current !== run) return;
      setImportProgress(undefined);
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "That scan couldn't be loaded");
    }
  }, [resetAnalysis]);

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const resetView = useCallback(() => viewerRef.current?.resetView(), []);

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
      // New ground means a new terrain; the old one describes ground that is gone.
      clearTerrain();
      setColorMode("heightAboveGround");
      setGround({ status: "done", stats: result.stats, seconds: (performance.now() - started) / 1000 });
    } catch (error) {
      if (error instanceof GroundDetectionCancelled || groundJobRef.current !== job) return;
      groundJobRef.current = undefined;
      setGround({ status: "failed", message: error instanceof Error ? error.message : "Ground detection failed" });
    }
  }, [clearTerrain]);

  const buildTerrain = useCallback(async () => {
    const viewer = viewerRef.current;
    const cloud = sourceRef.current;
    if (viewer === undefined || cloud === undefined) return;
    terrainJobRef.current?.cancel();
    const started = performance.now();
    setTerrain({ status: "running", stage: "Starting", fraction: 0 });
    const job = startTerrainBuild(cloud, viewerConfig().terrain, (stage, fraction) => {
      if (terrainJobRef.current === job) setTerrain({ status: "running", stage, fraction });
    });
    terrainJobRef.current = job;
    try {
      const result = await job.result;
      if (terrainJobRef.current !== job) return;
      terrainJobRef.current = undefined;
      viewer.setTerrain(result.model, result.contours);
      setTerrain({ status: "done", result, seconds: (performance.now() - started) / 1000 });
    } catch (error) {
      if (error instanceof TerrainCancelled || terrainJobRef.current !== job) return;
      terrainJobRef.current = undefined;
      setTerrain({ status: "failed", message: error instanceof Error ? error.message : "Building the terrain failed" });
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
      if (result.groundSource === "detected") clearTerrain();
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
  }, [clearTerrain]);

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
      } else if (kind === "elevation" || kind === "contours") {
        const built = terrainRef.current;
        if (built.status !== "done") return;
        if (kind === "elevation") saveFile([terrainGeoTiff(built.result.model, cloud.origin, cloud.spatialReference) as BlobPart], `${stem}-terrain.tif`, "image/tiff");
        else saveFile([contoursGeoJson(built.result.contours, cloud.origin, cloud.name, cloud.spatialReference)], `${stem}-contours.geojson`, "application/geo+json");
      } else {
        const objects = countRef.current.status === "done" ? countRef.current.objects : [];
        if (kind === "inventory") saveFile([objectInventoryCsv(cloud, objects)], `${stem}-inventory.csv`, "text/csv");
        else saveFile([objectsGeoJson(cloud, objects)], `${stem}-objects.geojson`, "application/geo+json");
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "The export couldn't be written");
    } finally {
      setExporting(undefined);
    }
  }, []);

  // A point's class, height and object change when an analysis replaces the
  // cloud, so what was inspected is dropped; a measurement is only positions,
  // which no analysis moves, so it stays.
  useEffect(() => {
    setPicks((current) => (current.inspected === undefined ? current : { from: current.from, to: current.to }));
  }, [source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer === undefined) return;
    if (clickTool === "inspect") {
      viewer.setAnnotations({ markers: picks.inspected === undefined ? [] : [{ position: picks.inspected.local, tone: "inspect" }] });
      return;
    }
    viewer.setAnnotations({
      markers: [
        ...(picks.from === undefined ? [] : [{ position: picks.from.local, tone: "from" as const }]),
        ...(picks.to === undefined ? [] : [{ position: picks.to.local, tone: "to" as const }]),
      ],
      ...(picks.from === undefined || picks.to === undefined ? {} : { measurement: { from: picks.from.local, to: picks.to.local } }),
    });
  }, [clickTool, picks]);

  useEffect(() => {
    viewerRef.current?.setOutlineVisibility(showBuildingOutlines, showTreeOutlines);
  }, [showBuildingOutlines, showTreeOutlines]);

  useEffect(() => {
    viewerRef.current?.setTerrainVisibility(showSurface, showContours);
  }, [showSurface, showContours]);

  useEffect(() => {
    viewerRef.current?.setPointsVisible(showPoints);
  }, [showPoints]);

  useEffect(
    () => () => {
      terrainJobRef.current?.cancel();
      importJobRef.current?.cancel();
      groundJobRef.current?.cancel();
      countJobRef.current?.cancel();
    },
    [],
  );

  const inspectedObject =
    count.status === "done" && picks.inspected?.objectId !== undefined
      ? count.objects.find((object) => object.id === picks.inspected?.objectId)
      : undefined;

  return {
    maxImportPoints: viewerConfig().maxImportPoints,
    canvasRef,
    fileInputRef,
    measureLabelRef,
    status,
    statusText,
    source,
    sourceLabel,
    sampling,
    importProgress,
    importing,
    uiHidden,
    view: {
      colorMode,
      setColorMode,
      supports,
      pointSize,
      setPointSize,
      pointShape,
      setPointShape,
      classHistogram,
      aboveGroundTop,
      showBuildingOutlines,
      setShowBuildingOutlines,
      showTreeOutlines,
      setShowTreeOutlines,
      showSurface,
      setShowSurface,
      showContours,
      setShowContours,
      showPoints,
      setShowPoints,
    },
    detail: {
      lodMode,
      setLodMode,
      pointBudget: effectivePointBudget,
      setPointBudget,
      budgetMaximum,
      lodSummary,
    },
    analysis: {
      analysing,
      hasGround,
      ground,
      detectGround,
      terrain,
      buildTerrain,
      count,
      countObjects,
    },
    picking: {
      clickTool,
      setClickTool,
      picks,
      inspectedObject,
      clearInspected: () => setPicks((current) => ({ from: current.from, to: current.to })),
      clearMeasurement: () => setPicks((current) => ({ inspected: current.inspected })),
    },
    exports: {
      exporting,
      exportError,
      exportBlocked,
      counted,
      exportScan,
    },
    actions: {
      loadFile,
      loadSample,
      openFilePicker,
      resetView,
    },
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;

/** A cloud's channels without its object ids, which a new classification makes stale. */
function channelsWithoutObjects(cloud: PointCloud) {
  const { objectId: _stale, ...channels } = definedChannels(cloud);
  return channels;
}
