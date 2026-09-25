import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PointCloud, definedChannels, type PointCloudColorMode, type PointCloudPointShape } from "../../core/point-cloud.js";
import type { PointCloudLodPyramid } from "../../core/lod-pyramid.js";
import { QualityReportCancelled, startQualityReport, type QualityReportJob } from "../../core/quality-report-job.js";
import { defaultQualityReportOptions, parseCheckpoints } from "../../core/quality-report.js";
import { densityHeatmapUrl, qualityReportHtml } from "../../export/quality-report-html.js";
import { ScanImportCancelled, startScanImport, type ScanImportJob } from "../../import/scan-import-job.js";
import { defaultSample, fetchSampleFile, findSample, sampleSurveys, type SampleSurvey } from "../../import/sample-survey.js";
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
import { buildSurfaceGrid, selectSurface, type SurfaceGrid } from "../../core/surface-area.js";
import { TerrainCancelled, startTerrainBuild, type TerrainJob } from "../../core/terrain-job.js";
import { NoiseDetectionCancelled, startNoiseDetection, type NoiseDetectionJob } from "../../core/noise-detection-job.js";
import { withoutNoise } from "../../export/clean.js";
import { gpuSupported } from "../../gpu/gpu-context.js";
import type { NoiseDisplay } from "../../three/point-cloud-shader-material.js";
import { contoursGeoJson, terrainGeoTiff } from "../../export/terrain-export.js";
import type {
  ClickTool,
  CountState,
  ExportKind,
  GroundState,
  ImportProgress,
  LodMode,
  CheckpointSet,
  NoiseState,
  Picks,
  QualityState,
  PipelineState,
  Sampling,
  TerrainState,
  ViewerStatus,
} from "./types.js";
import { noPicks } from "./types.js";

export interface WorkspaceOptions {
  /**
   * A sample survey to open as soon as the viewer starts, by id; an id that
   * names no sample (such as older links' "city") opens the default one.
   */
  readonly sampleOnStart?: string | undefined;
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
  const { sampleOnStart } = options;
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
  /** The sample on screen, if the scan is one: what it is and whose, as its licence asks. */
  const [shownSample, setShownSample] = useState<SampleSurvey>();
  const [uiHidden, setUiHidden] = useState(false);
  const [lodMode, setLodMode] = useState<LodMode>(() => (viewerConfig().distanceLod.enabledByDefault ? "distance" : "manual"));
  const [lodSummary, setLodSummary] = useState<LodRenderSummary>();
  const [quality, setQuality] = useState<QualityState>({ status: "idle" });
  const qualityJobRef = useRef<QualityReportJob | undefined>(undefined);
  const [checkpoints, setCheckpoints] = useState<CheckpointSet>();
  const checkpointsRef = useRef<CheckpointSet | undefined>(undefined);
  const [reportOpen, setReportOpen] = useState(false);
  const [noise, setNoise] = useState<NoiseState>({ status: "idle" });
  // Heavy analysis stages run on the GPU wherever the browser offers WebGPU; the CPU path is always there.
  const [useGpu, setUseGpu] = useState(() => gpuSupported());
  const useGpuRef = useRef(useGpu);
  useEffect(() => {
    useGpuRef.current = useGpu;
  }, [useGpu]);
  const noiseJobRef = useRef<NoiseDetectionJob | undefined>(undefined);
  const [noiseDisplay, setNoiseDisplay] = useState<NoiseDisplay>("hidden");
  /** Flight lines switched off in the flight-line view, to inspect the others on their own. */
  const [hiddenLines, setHiddenLines] = useState<ReadonlySet<number>>(() => new Set());
  const [ground, setGround] = useState<GroundState>({ status: "idle" });
  const groundJobRef = useRef<GroundDetectionJob | undefined>(undefined);
  const [count, setCount] = useState<CountState>({ status: "idle" });
  const countJobRef = useRef<ObjectDetectionJob | undefined>(undefined);
  const importJobRef = useRef<ScanImportJob | undefined>(undefined);
  const [importProgress, setImportProgress] = useState<ImportProgress>();
  // Counts imports, so progress from one that was superseded never lands on the bar of the next.
  const importRunRef = useRef(0);
  const [sampling, setSampling] = useState<Sampling>();
  const samplingRef = useRef<Sampling | undefined>(undefined);
  useLayoutEffect(() => {
    samplingRef.current = sampling;
  }, [sampling]);
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
  const [picks, setPicks] = useState<Picks>(noPicks);
  /** The scan's top surface for the area tool, built on its first use and kept while the points stay the same. */
  const surfaceGridRef = useRef<{ positions: Float32Array; grid: SurfaceGrid } | undefined>(undefined);
  const [pipeline, setPipeline] = useState<PipelineState>();
  /**
   * Set while "Analyze scan" runs every step. Run one at a time, a step shows
   * its result - ground switches to height above ground, counting to objects,
   * the terrain appears over the scan - which is the feedback asked for. Run
   * all together, those switches follow one another and leave the view
   * somewhere the user did not choose, so the view is left as it was and each
   * card offers its own view instead.
   */
  const keepViewRef = useRef(false);
  // Counts pipeline runs, so one that was superseded stops at its next step.
  const pipelineRunRef = useRef(0);
  const sourceWaitersRef = useRef<Array<() => void>>([]);

  const source = pyramid?.tiers[0]?.cloud;
  // The budget the user chose is kept as chosen and only capped here, per scan.
  // Writing the cap back into it would shrink the budget to the size of a small
  // scan and leave the next, larger one drawn at a fraction of its detail.
  const effectivePointBudget = Math.min(pointBudget, source?.pointCount ?? pointBudget);
  // A full pass over the flight-line channel, once per loaded scan.
  const flightLines = useMemo(() => source?.flightLineHistogram() ?? [], [source]);
  const supports = {
    rgb: source?.supportsColorMode("rgb") ?? false,
    intensity: source?.supportsColorMode("intensity") ?? false,
    classification: source?.supportsColorMode("classification") ?? false,
    heightAboveGround: source?.supportsColorMode("heightAboveGround") ?? false,
    objects: source?.supportsColorMode("objects") ?? false,
    // One line is no comparison: a scan whose points all share an id has nothing to colour apart.
    flightLine: flightLines.length > 1,
  };
  const analysing = pipeline !== undefined || quality.status === "running" || noise.status === "running" || ground.status === "running" || count.status === "running" || terrain.status === "running";
  const exportBlocked = source === undefined || status !== "ready" || analysing || exporting !== undefined;
  const counted = count.status === "done" && source?.objectId !== undefined;
  const budgetMaximum = source?.pointCount ?? viewerConfig().defaultPointBudget;

  // A full pass over the class channel, so it is computed once per loaded
  // scan rather than on every render.
  const classHistogram = useMemo(() => source?.classificationHistogram() ?? [], [source]);

  const hasGround = classHistogram.some(({ code, count: points }) => code === 2 && points >= 100);
  const noisePoints = classHistogram.reduce((sum, { code, count: points }) => (code === 7 || code === 18 ? sum + points : sum), 0);
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
    for (const resolve of sourceWaitersRef.current.splice(0)) resolve();
  }, [source]);

  // Exports read the objects of the count now on screen, not of the render that created the handler.
  const countRef = useRef(count);
  useLayoutEffect(() => {
    countRef.current = count;
  }, [count]);

  useLayoutEffect(() => {
    clickToolRef.current = clickTool;
    // Two quick clicks while measuring are two points, not a request to fly.
    viewerRef.current?.setDoubleClickToFly(clickTool === "inspect");
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
    setPicks(noPicks);
    importJobRef.current?.cancel();
    importJobRef.current = undefined;
    importRunRef.current += 1;
    setImportProgress(undefined);
    pipelineRunRef.current += 1;
    setPipeline(undefined);
    noiseJobRef.current?.cancel();
    noiseJobRef.current = undefined;
    qualityJobRef.current?.cancel();
    qualityJobRef.current = undefined;
    groundJobRef.current?.cancel();
    groundJobRef.current = undefined;
    countJobRef.current?.cancel();
    countJobRef.current = undefined;
    setQuality({ status: "idle" });
    setReportOpen(false);
    setNoise({ status: "idle" });
    setGround({ status: "idle" });
    setCount({ status: "idle" });
    clearTerrain();
  }, [clearTerrain]);

  /**
   * Puts a scan on screen: gets its file (at once for a file the user chose,
   * after a download for the sample), reads it on a worker and builds its
   * detail levels.
   */
  const importScan = useCallback(
    async (label: string, sample: SampleSurvey | undefined, getFile: (report: (stage: ImportProgress["stage"], fraction: number) => void) => Promise<File>) => {
      resetAnalysis();
      const run = importRunRef.current;
      try {
        const report = (stage: ImportProgress["stage"], fraction: number) => {
          if (importRunRef.current === run) setImportProgress({ stage, fraction });
        };
        setSourceLabel(label);
        setShownSample(sample);
        setHiddenLines(new Set());
        checkpointsRef.current = undefined;
        setCheckpoints(undefined);
        setStatus("processing");
        setSampling(undefined);
        const file = await getFile(report);
        // Another scan was chosen while this one was downloading.
        if (importRunRef.current !== run) return;
        setStatusText("Reading the file");
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
    },
    [resetAnalysis],
  );

  const loadFile = useCallback((file: File) => importScan(file.name, undefined, async () => file), [importScan]);

  const loadSample = useCallback(
    (sample: SampleSurvey = defaultSample) =>
      importScan(sample.name, sample, (report) => {
        setStatusText("Downloading the sample survey");
        report("downloading", 0);
        return fetchSampleFile(sample.url, (fraction) => report("downloading", fraction));
      }),
    [importScan],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const viewer = new LidarViewer(canvas, {
      pointBudget: viewerConfig().defaultPointBudget,
      pointSize: viewerConfig().pointSize.default,
      distanceBasedLod: viewerConfig().distanceLod.enabledByDefault,
      // The viewport is the whole window here, so a scan can sit closer than
      // the configured default without running out of the frame.
      framingDistance: viewerConfig().camera.framingDistance * 0.5,
    });
    viewerRef.current = viewer;
    const unsubscribeTier = viewer.onLodSummaryChange(setLodSummary);
    const unsubscribeClick = viewer.onPointClick((hit) => {
      const details = hit === undefined ? undefined : describePoint(hit.cloud, hit.index);
      if (clickToolRef.current === "inspect") {
        setPicks((current) => ({ ...current, inspected: details }));
        return;
      }
      if (clickToolRef.current === "area") {
        const cloud = sourceRef.current;
        if (hit === undefined || cloud === undefined) return;
        // Analyses replace the cloud but never move its points, so the grid lasts until another scan is opened.
        let cached = surfaceGridRef.current;
        if (cached === undefined || cached.positions !== cloud.positions) {
          cached = { positions: cloud.positions, grid: buildSurfaceGrid(cloud) };
          surfaceGridRef.current = cached;
        }
        const offset = hit.index * 3;
        const surface = selectSurface(cached.grid, hit.cloud.positions[offset]!, hit.cloud.positions[offset + 2]!);
        if (surface === undefined) return;
        setPicks((current) => {
          const id = current.surfaces.reduce((highest, each) => Math.max(highest, each.id), 0) + 1;
          return { ...current, surfaces: [...current.surfaces, { id, surface }] };
        });
        return;
      }
      // A miss while measuring is most likely a slip, so it keeps what was measured.
      if (details === undefined) return;
      // A click ends the ruler being laid, or starts a new one beside those already there.
      setPicks((current) => {
        const last = current.rulers.at(-1);
        if (last !== undefined && last.to === undefined) return { ...current, rulers: [...current.rulers.slice(0, -1), { ...last, to: details }] };
        // Numbered one past the highest on screen, so the numbers stay short and follow the order they were laid.
        const id = current.rulers.reduce((highest, ruler) => Math.max(highest, ruler.id), 0) + 1;
        return { ...current, rulers: [...current.rulers, { id, from: details }] };
      });
    });
    // A marker dragged across the scan moves the point it marks; the measurement follows it.
    const unsubscribeDrag = viewer.onMarkerDrag((id, hit) => {
      const details = describePoint(hit.cloud, hit.index);
      if (id === "inspected") {
        setPicks((current) => ({ ...current, inspected: details }));
        return;
      }
      // Ruler ends are named "<ruler>:from" and "<ruler>:to".
      const [ruler, end] = id.split(":");
      setPicks((current) => ({
        ...current,
        rulers: current.rulers.map((each) => (String(each.id) === ruler ? (end === "from" ? { ...each, from: details } : { ...each, to: details }) : each)),
      }));
    });
    // Measurement labels follow their lines as the camera moves, written
    // straight to the elements each frame rather than through React state.
    const unsubscribeFrame = viewer.onFrame(() => {
      const layer = measureLabelRef.current;
      if (layer === null) return;
      for (const label of layer.children) {
        if (!(label instanceof HTMLElement) || label.dataset.anchor === undefined) continue;
        const spot = viewer.projectToCanvas(JSON.parse(label.dataset.anchor) as [number, number, number]);
        label.style.visibility = spot.visible ? "visible" : "hidden";
        label.style.transform = `translate(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px) translate(-50%, -140%)`;
      }
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
    if (sampleOnStart !== undefined) void loadSample(findSample(sampleOnStart) ?? defaultSample);

    return () => {
      unsubscribe();
      unsubscribeTier();
      unsubscribeClick();
      unsubscribeDrag();
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
      // Escape drops the ruler still being laid, and otherwise the point inspected; finished rulers stay.
      if (event.key === "Escape")
        setPicks((current) =>
          current.rulers.length > 0 && current.rulers.at(-1)?.to === undefined ? { ...current, rulers: current.rulers.slice(0, -1) } : { rulers: current.rulers, surfaces: current.surfaces },
        );
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

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const resetView = useCallback(() => viewerRef.current?.resetView(), []);

  const findNoise = useCallback(async () => {
    const viewer = viewerRef.current;
    const cloud = sourceRef.current;
    if (viewer === undefined || cloud === undefined) return false;
    noiseJobRef.current?.cancel();
    const started = performance.now();
    setNoise({ status: "running", stage: "Starting", fraction: 0 });
    const job = startNoiseDetection(
      cloud,
      viewerConfig().noiseDetection,
      (stage, fraction) => {
        if (noiseJobRef.current === job) setNoise({ status: "running", stage, fraction });
      },
      useGpuRef.current,
    );
    noiseJobRef.current = job;
    try {
      const result = await job.result;
      if (noiseJobRef.current !== job) return false;
      if (sourceRef.current !== cloud) {
        noiseJobRef.current = undefined;
        setNoise({ status: "idle" });
        return false;
      }
      setNoise({ status: "running", stage: "Updating the view", fraction: 1 });
      // Noise only relabels points, so ground, heights and objects found so far stay valid.
      await viewer.replaceCloud(
        new PointCloud({
          positions: cloud.positions,
          ...definedChannels(cloud),
          classification: result.classification,
          bounds: cloud.bounds,
          origin: cloud.origin,
          spatialReference: cloud.spatialReference,
          name: cloud.name,
        }),
      );
      if (noiseJobRef.current !== job) return false;
      noiseJobRef.current = undefined;
      setNoiseDisplay("hidden");
      setNoise({ status: "done", stats: result.stats, seconds: (performance.now() - started) / 1000, onGpu: result.usedGpu });
      return true;
    } catch (error) {
      if (error instanceof NoiseDetectionCancelled || noiseJobRef.current !== job) return false;
      noiseJobRef.current = undefined;
      setNoise({ status: "failed", message: error instanceof Error ? error.message : "Finding noise failed" });
      return false;
    }
  }, []);

  const detectGround = useCallback(async () => {
    const viewer = viewerRef.current;
    const cloud = sourceRef.current;
    if (viewer === undefined || cloud === undefined) return false;
    groundJobRef.current?.cancel();
    const started = performance.now();
    setGround({ status: "running", stage: "Starting", fraction: 0 });
    const job = startGroundDetection(
      cloud,
      viewerConfig().groundDetection,
      (stage, fraction) => {
        if (groundJobRef.current === job) setGround({ status: "running", stage, fraction });
      },
      useGpuRef.current,
    );
    groundJobRef.current = job;
    try {
      const result = await job.result;
      if (groundJobRef.current !== job) return false;
      // The user may have opened another scan while this one was analysed;
      // the result is for a scan no longer on screen, so it is dropped.
      if (sourceRef.current !== cloud) {
        groundJobRef.current = undefined;
        setGround({ status: "idle" });
        return false;
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
      if (groundJobRef.current !== job) return false;
      groundJobRef.current = undefined;
      setCount({ status: "idle" });
      // New ground means a new terrain; the old one describes ground that is gone.
      clearTerrain();
      if (!keepViewRef.current) setColorMode("heightAboveGround");
      setGround({ status: "done", stats: result.stats, seconds: (performance.now() - started) / 1000, onGpu: result.usedGpu });
      return true;
    } catch (error) {
      if (error instanceof GroundDetectionCancelled || groundJobRef.current !== job) return false;
      groundJobRef.current = undefined;
      setGround({ status: "failed", message: error instanceof Error ? error.message : "Ground detection failed" });
      return false;
    }
  }, [clearTerrain]);

  const buildTerrain = useCallback(async () => {
    const viewer = viewerRef.current;
    const cloud = sourceRef.current;
    if (viewer === undefined || cloud === undefined) return false;
    terrainJobRef.current?.cancel();
    const started = performance.now();
    setTerrain({ status: "running", stage: "Starting", fraction: 0 });
    const job = startTerrainBuild(cloud, viewerConfig().terrain, (stage, fraction) => {
      if (terrainJobRef.current === job) setTerrain({ status: "running", stage, fraction });
    });
    terrainJobRef.current = job;
    try {
      const result = await job.result;
      if (terrainJobRef.current !== job) return false;
      terrainJobRef.current = undefined;
      if (keepViewRef.current) {
        // Built but not drawn over the scan; the card's switches show it.
        setShowSurface(false);
        setShowContours(false);
        viewer.setTerrainVisibility(false, false);
      }
      viewer.setTerrain(result.model, result.contours);
      setTerrain({ status: "done", result, seconds: (performance.now() - started) / 1000 });
      return true;
    } catch (error) {
      if (error instanceof TerrainCancelled || terrainJobRef.current !== job) return false;
      terrainJobRef.current = undefined;
      setTerrain({ status: "failed", message: error instanceof Error ? error.message : "Building the terrain failed" });
      return false;
    }
  }, []);

  const countObjects = useCallback(async () => {
    const viewer = viewerRef.current;
    const cloud = sourceRef.current;
    if (viewer === undefined || cloud === undefined) return false;
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
      if (countJobRef.current !== job) return false;
      if (sourceRef.current !== cloud) {
        countJobRef.current = undefined;
        setCount({ status: "idle" });
        return false;
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
      if (countJobRef.current !== job) return false;
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
      if (!keepViewRef.current) setColorMode("objects");
      setCount({
        status: "done",
        stats: result.stats,
        objects: result.objects,
        tallestBuilding,
        treeHeights: [Number.isFinite(shortestTree) ? shortestTree : 0, tallestTree],
        seconds,
      });
      return true;
    } catch (error) {
      if (error instanceof ObjectDetectionCancelled || countJobRef.current !== job) return false;
      countJobRef.current = undefined;
      setCount({ status: "failed", message: error instanceof Error ? error.message : "Counting buildings and trees failed" });
      return false;
    }
  }, [clearTerrain]);

  const checkQuality = useCallback(async () => {
    const cloud = sourceRef.current;
    if (cloud === undefined) return false;
    qualityJobRef.current?.cancel();
    const started = performance.now();
    setQuality({ status: "running", stage: "Starting", fraction: 0 });
    const job = startQualityReport(
      cloud,
      checkpointsRef.current?.checkpoints,
      defaultQualityReportOptions,
      (stage, fraction) => {
        if (qualityJobRef.current === job) setQuality({ status: "running", stage, fraction });
      },
      // A scan thinned on import is rated for the file it came from, and says so.
      samplingRef.current,
    );
    qualityJobRef.current = job;
    try {
      const report = await job.result;
      if (qualityJobRef.current !== job) return false;
      qualityJobRef.current = undefined;
      if (sourceRef.current !== cloud) {
        setQuality({ status: "idle" });
        return false;
      }
      setQuality({ status: "done", report, seconds: (performance.now() - started) / 1000 });
      return true;
    } catch (error) {
      if (error instanceof QualityReportCancelled || qualityJobRef.current !== job) return false;
      qualityJobRef.current = undefined;
      setQuality({ status: "failed", message: error instanceof Error ? error.message : "Building the quality report failed" });
      return false;
    }
  }, []);

  const loadCheckpoints = useCallback(async (file: File) => {
    const parsed = parseCheckpoints(await file.text());
    if (parsed.length === 0) {
      setQuality({ status: "failed", message: `${file.name} has no rows of easting, northing and elevation.` });
      return;
    }
    const set = { checkpoints: parsed, source: file.name };
    checkpointsRef.current = set;
    setCheckpoints(set);
    // A report built without these checkpoints no longer says what they would.
    setQuality((current) => (current.status === "done" ? { status: "idle" } : current));
  }, []);

  const downloadReport = useCallback(() => {
    const cloud = sourceRef.current;
    if (cloud === undefined || quality.status !== "done") return;
    const epsg = cloud.spatialReference?.epsg;
    const html = qualityReportHtml(quality.report, {
      name: cloud.name,
      crs: epsg === undefined ? "Local coordinates" : `EPSG:${epsg}`,
      heatmapUrl: densityHeatmapUrl(quality.report),
    });
    saveFile([html], `${fileStem(cloud.name)}-quality-report.html`, "text/html");
  }, [quality]);

  /**
   * Resolves once the scan on screen is no longer `previous`. An analysis that
   * relabels the points swaps in a new cloud, and React only hands it to the
   * next step after its next render; starting the step sooner would run it on
   * the old cloud and throw its result away.
   */
  const afterSourceChanges = useCallback(
    (previous: PointCloud | undefined) =>
      new Promise<void>((resolve) => {
        if (sourceRef.current !== previous) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 15_000);
        sourceWaitersRef.current.push(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
    [],
  );

  /**
   * Runs analyses one after another. A step that fails shows its error on its
   * own card and the rest still run: the quality report, say, needs nothing
   * from the object count, and one failure should not leave every later card
   * silently untouched. Only starting another run, or opening another scan,
   * stops the sequence.
   */
  const runSteps = useCallback(
    async (steps: ReadonlyArray<{ label: string; run: () => Promise<boolean>; relabels: boolean }>, keepView = false) => {
      const run = ++pipelineRunRef.current;
      keepViewRef.current = keepView;
      try {
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index]!;
          if (pipelineRunRef.current !== run) return;
          setPipeline({ step: index + 1, total: steps.length, label: step.label });
          const before = sourceRef.current;
          const finished = await step.run();
          if (pipelineRunRef.current !== run) return;
          // Only a finished step swaps in a relabelled cloud to wait for.
          if (finished && step.relabels) await afterSourceChanges(before);
        }
      } finally {
        if (pipelineRunRef.current === run) {
          setPipeline(undefined);
          keepViewRef.current = false;
        }
      }
    },
    [afterSourceChanges],
  );

  const noiseStep = useMemo(() => ({ label: "Finding noise", run: findNoise, relabels: true }), [findNoise]);
  const groundStep = useMemo(() => ({ label: "Finding the ground", run: detectGround, relabels: true }), [detectGround]);
  const terrainStep = useMemo(() => ({ label: "Building the terrain", run: buildTerrain, relabels: false }), [buildTerrain]);
  const countStep = useMemo(() => ({ label: "Counting buildings and trees", run: countObjects, relabels: true }), [countObjects]);
  const qualityStep = useMemo(() => ({ label: "Checking survey quality", run: checkQuality, relabels: false }), [checkQuality]);

  /** Everything, in the order each step helps the next: noise out of the way, then ground, terrain and objects. */
  const analyzeScan = useCallback(
    () => runSteps([noiseStep, groundStep, terrainStep, countStep, qualityStep], true),
    [runSteps, noiseStep, groundStep, terrainStep, countStep, qualityStep],
  );
  const analyzeNoise = useCallback(() => runSteps([noiseStep]), [runSteps, noiseStep]);
  const analyzeTerrain = useCallback(() => runSteps([groundStep, terrainStep]), [runSteps, groundStep, terrainStep]);
  const analyzeObjects = useCallback(() => runSteps([countStep]), [runSteps, countStep]);
  const analyzeQuality = useCallback(() => runSteps([qualityStep]), [runSteps, qualityStep]);

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
      } else if (kind === "cleaned") {
        saveFile(writeLas(withoutNoise(cloud)) as BlobPart[], `${stem}-cleaned.las`, "application/vnd.las");
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
    setPicks((current) => (current.inspected === undefined ? current : { rulers: current.rulers, surfaces: current.surfaces }));
  }, [source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer === undefined) return;
    if (clickTool === "inspect") {
      viewer.setAnnotations({ markers: picks.inspected === undefined ? [] : [{ position: picks.inspected.local, tone: "inspect" }] });
      viewer.setDraggableMarkers(picks.inspected === undefined ? [] : [{ id: "inspected", position: picks.inspected.local }]);
      return;
    }
    if (clickTool === "area") {
      viewer.setAnnotations({ markers: [], surfaces: picks.surfaces.map((each) => each.surface.outline) });
      viewer.setDraggableMarkers([]);
      return;
    }
    viewer.setDraggableMarkers(
      picks.rulers.flatMap((ruler) => [
        { id: `${ruler.id}:from`, position: ruler.from.local },
        ...(ruler.to === undefined ? [] : [{ id: `${ruler.id}:to`, position: ruler.to.local }]),
      ]),
    );
    viewer.setAnnotations({
      markers: picks.rulers.flatMap((ruler) => [
        { position: ruler.from.local, tone: "from" as const },
        ...(ruler.to === undefined ? [] : [{ position: ruler.to.local, tone: "to" as const }]),
      ]),
      measurements: picks.rulers.flatMap((ruler) => (ruler.to === undefined ? [] : [{ from: ruler.from.local, to: ruler.to.local }])),
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

  useEffect(() => {
    viewerRef.current?.setNoiseDisplay(noiseDisplay);
  }, [noiseDisplay]);

  useEffect(() => {
    viewerRef.current?.setHiddenFlightLines(hiddenLines);
  }, [hiddenLines]);

  /** Shows or hides one flight line, or with `only` shows that line alone. */
  const toggleLine = useCallback(
    (id: number, only: boolean) => {
      setHiddenLines((hidden) => {
        if (only) return new Set(flightLines.map((line) => line.id).filter((other) => other !== id));
        const next = new Set(hidden);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        // Every line off leaves nothing to look at; that click means "all of them" again.
        return next.size === flightLines.length ? new Set() : next;
      });
    },
    [flightLines],
  );
  const showAllLines = useCallback(() => setHiddenLines(new Set()), []);

  useEffect(
    () => () => {
      terrainJobRef.current?.cancel();
      noiseJobRef.current?.cancel();
      qualityJobRef.current?.cancel();
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
    shownSample,
    samples: sampleSurveys,
    sampling,
    importProgress,
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
      flightLines,
      hiddenLines,
      toggleLine,
      showAllLines,
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
      noiseDisplay,
      setNoiseDisplay,
      noisePoints,
    },
    compute: {
      gpuSupported: gpuSupported(),
      useGpu,
      setUseGpu,
    },
    detail: {
      lodMode,
      setLodMode,
      pointBudget: effectivePointBudget,
      setPointBudget,
      budgetMaximum,
      lodSummary,
    },
    quality: {
      state: quality,
      checkpoints,
      loadCheckpoints,
      analyzeQuality,
      reportOpen,
      setReportOpen,
      downloadReport,
    },
    analysis: {
      analysing,
      pipeline,
      analyzeScan,
      analyzeNoise,
      analyzeTerrain,
      analyzeObjects,
      noise,
      hasGround,
      ground,
      terrain,
      count,
    },
    picking: {
      clickTool,
      setClickTool,
      picks,
      inspectedObject,
      clearInspected: () => setPicks((current) => ({ rulers: current.rulers, surfaces: current.surfaces })),
      removeRuler: (id: number) => setPicks((current) => ({ ...current, rulers: current.rulers.filter((ruler) => ruler.id !== id) })),
      clearRulers: () => setPicks((current) => ({ ...current, rulers: [] })),
      removeSurface: (id: number) => setPicks((current) => ({ ...current, surfaces: current.surfaces.filter((each) => each.id !== id) })),
      clearSurfaces: () => setPicks((current) => ({ ...current, surfaces: [] })),
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
