import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, ReactNode } from "react";
import type { PointCloudColorMode } from "./core/point-cloud.js";
import type { PointCloudLodPyramid } from "./core/lod-pyramid.js";
import { ProceduralCloudGenerator } from "./core/procedural-cloud-generator.js";
import { importPlyFile } from "./import/ply-file-importer.js";
import { LidarViewer } from "./three/lidar-viewer.js";

const INITIAL_POINT_COUNT = 380_000;
const DEFAULT_BUDGET = 500_000;

type ViewerStatus = "initializing" | "processing" | "ready" | "error";

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<LidarViewer | undefined>(undefined);
  const [pyramid, setPyramid] = useState<PointCloudLodPyramid>();
  const [status, setStatus] = useState<ViewerStatus>("initializing");
  const [statusText, setStatusText] = useState("Booting visualizer");
  const [pointBudget, setPointBudget] = useState(DEFAULT_BUDGET);
  const [pointSize, setPointSize] = useState(2.4);
  const [colorMode, setColorMode] = useState<PointCloudColorMode>("rgb");
  const [isDragging, setIsDragging] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("Procedural city block");
  const [uiHidden, setUiHidden] = useState(false);

  const source = pyramid?.tiers[0]?.cloud;
  const effectivePointBudget = Math.min(pointBudget, source?.pointCount ?? pointBudget);
  const selectedTier = useMemo(
    () => pyramid?.selectForPointBudget(effectivePointBudget),
    [effectivePointBudget, pyramid],
  );
  const supportsRgb = source?.supportsColorMode("rgb") ?? false;
  const supportsIntensity = source?.supportsColorMode("intensity") ?? false;
  const budgetMaximum = source?.pointCount ?? DEFAULT_BUDGET;

  const loadProcedural = useCallback((seed = Math.floor(Math.random() * 1_000_000)) => {
    const viewer = viewerRef.current;
    if (viewer === undefined) return;
    setSourceLabel("Procedural city block");
    void viewer.load(
      new ProceduralCloudGenerator().generate({ pointCount: INITIAL_POINT_COUNT, seed }),
      createLodSpecs(115),
    );
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const viewer = new LidarViewer(canvas, { pointBudget: DEFAULT_BUDGET, pointSize });
    viewerRef.current = viewer;
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
      resizeObserver.disconnect();
      viewer.dispose();
      viewerRef.current = undefined;
    };
  }, [loadProcedural]);

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
    if (source !== undefined && !source.supportsColorMode(colorMode)) {
      setColorMode("height");
      return;
    }
    viewerRef.current?.setColorMode(colorMode);
  }, [colorMode, source]);

  const loadFile = useCallback(async (file: File) => {
    try {
      setSourceLabel(file.name);
      setStatus("processing");
      setStatusText("Parsing local PLY scan");
      const cloud = await importPlyFile(file);
      await viewerRef.current?.load(cloud, createLodSpecs(cloud.bounds.diagonal));
    } catch (error) {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "Unable to load that scan");
    }
  }, []);

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

          <ControlRow label="Point budget" value={formatCount(effectivePointBudget)}>
            <input
              aria-label="Point budget"
              type="range"
              min="10000"
              max={Math.max(10_000, budgetMaximum)}
              step="10000"
              value={Math.min(effectivePointBudget, Math.max(10_000, budgetMaximum))}
              onChange={(event) => setPointBudget(Number(event.target.value))}
            />
            <div className="range-ends"><span>10K</span><span>{formatCount(budgetMaximum)}</span></div>
          </ControlRow>

          <ControlRow label="Point size" value={`${pointSize.toFixed(1)} px`}>
            <input aria-label="Point size" type="range" min="1" max="7" step="0.1" value={pointSize} onChange={(event) => setPointSize(Number(event.target.value))} />
            <div className="range-ends"><span>FINE</span><span>BOLD</span></div>
          </ControlRow>

          <div className="control-block color-control">
            <div className="control-label"><span>Color treatment</span></div>
            <div className="segmented-control" role="group" aria-label="Color treatment">
              <ModeButton active={colorMode === "height"} onClick={() => setColorMode("height")}>Height</ModeButton>
              <ModeButton active={colorMode === "rgb"} disabled={!supportsRgb} onClick={() => setColorMode("rgb")}>RGB</ModeButton>
              <ModeButton active={colorMode === "intensity"} disabled={!supportsIntensity} onClick={() => setColorMode("intensity")}>Intensity</ModeButton>
            </div>
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
            <span><strong>Import a LiDAR scan</strong><small>Drop a .PLY file or browse your device</small></span>
            <Icon name="arrow" />
          </button>
          <input ref={fileInputRef} className="visually-hidden" type="file" accept=".ply" onChange={handleFileInput} />

          <p className="panel-footnote">Everything stays local in your browser. No scan data is uploaded.</p>
        </aside>

        <footer className="telemetry-bar">
          <Telemetry label="SOURCE POINTS" value={source === undefined ? "—" : formatCount(source.pointCount)} />
          <Telemetry label="ACTIVE LOD" value={selectedTier?.id.toUpperCase() ?? "—"} />
          <Telemetry label="DRAW BUDGET" value={selectedTier === undefined ? "—" : formatCount(selectedTier.cloud.pointCount)} />
          <div className="telemetry-note"><span className="pulse-ring" />EDGE-READY RENDER PATH</div>
        </footer>
      </section>
    </main>
  );
}

function createLodSpecs(diagonal: number) {
  const scale = Math.max(diagonal, 1);
  return [
    { id: "full", voxelSize: 0 },
    { id: "fine", voxelSize: scale / 450 },
    { id: "balanced", voxelSize: scale / 175 },
    { id: "lean", voxelSize: scale / 65 },
  ];
}

function ControlRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return <div className="control-block"><div className="control-label"><span>{label}</span><strong>{value}</strong></div>{children}</div>;
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

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}
