import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { Note, ProgressBar, Segmented, Toggle } from "../controls.js";
import { formatCount, formatOrigin, formatShare, ordinalSuffix } from "../format.js";
import { countSummary, groundSummary, noiseSummary, terrainSummary } from "./analysis-text.js";
import type { Workspace } from "./use-workspace.js";
import type { CountState, GroundState, NoiseState, TerrainState } from "./types.js";

/**
 * Everything about the scan in one column: what it is, one button that
 * analyses it, and a card per result. Each card carries the controls for what
 * it produced - the noise's visibility beside the noise, the terrain's layers
 * beside the terrain, the outlines beside the count - so nothing has to be
 * looked for in another panel.
 */
export function Sidebar({ workspace }: { workspace: Workspace }) {
  const { source } = workspace;
  return (
    <aside className="ws-panel ws-sidebar" aria-label="Scan and analysis">
      <ScanSummary workspace={workspace} />
      {source === undefined ? null : <Analysis workspace={workspace} />}
    </aside>
  );
}

function ScanSummary({ workspace }: { workspace: Workspace }) {
  const { source, sourceLabel, sampling } = workspace;
  if (source === undefined) return null;
  return (
    <section className="side-section side-scan">
      <strong className="side-scan-name" title={sourceLabel}>
        {sourceLabel}
      </strong>
      <p className="side-scan-facts">
        <span>{formatCount(source.pointCount)} points</span>
        <span>{`${Math.round(source.bounds.size[0])} × ${Math.round(source.bounds.size[2])} m`}</span>
        <span>{source.spatialReference?.epsg === undefined ? formatOrigin(source) : `EPSG:${source.spatialReference.epsg}`}</span>
      </p>
      {sampling === undefined ? null : (
        <Note tone="warning">
          {`Every ${Math.ceil(sampling.total / sampling.loaded)}${ordinalSuffix(Math.ceil(sampling.total / sampling.loaded))} of ${formatCount(sampling.total)} points is loaded, spread evenly.`}
        </Note>
      )}
    </section>
  );
}

function Analysis({ workspace }: { workspace: Workspace }) {
  const { analysis, view, status, source } = workspace;
  const { noise, ground, terrain, count, pipeline } = analysis;
  const busy = analysis.analysing || status !== "ready";
  const everythingDone = noise.status === "done" && terrain.status === "done" && count.status === "done";

  return (
    <section className="side-section">
      <button type="button" className="btn btn-primary btn-block btn-lg" disabled={busy} onClick={() => void analysis.analyzeScan()}>
        <Icon name={everythingDone ? "refresh" : "sparkles"} />
        {pipeline !== undefined ? `${pipeline.label}…` : everythingDone ? "Analyze again" : "Analyze scan"}
      </button>
      {pipeline === undefined ? (
        <Note>{everythingDone ? "Every step below is done. Each can also be run again on its own." : "Cleans out noise, finds the ground and terrain, then outlines and counts every building and tree."}</Note>
      ) : (
        <p className="side-pipeline">{`Step ${pipeline.step} of ${pipeline.total}`}</p>
      )}

      <ResultCard
        icon="noise"
        title="Noise"
        value={noise.status === "done" ? `${formatCount(noise.stats.total)} points` : undefined}
        states={[noise]}
        busy={busy}
        onRun={() => void analysis.analyzeNoise()}
        summary={noiseSummary(noise)}
      >
        {noise.status === "done" && view.noisePoints > 0 ? (
          <Segmented
            label="Noise"
            value={view.noiseDisplay}
            choices={[
              { value: "hidden", label: "Hide" },
              { value: "highlighted", label: "Highlight" },
              { value: "shown", label: "Show" },
            ]}
            onChange={view.setNoiseDisplay}
          />
        ) : null}
      </ResultCard>

      <ResultCard
        icon="mountain"
        title="Ground and terrain"
        value={
          terrain.status === "done"
            ? `${Math.round((source?.origin[1] ?? 0) + terrain.result.model.minElevation)}–${Math.round((source?.origin[1] ?? 0) + terrain.result.model.maxElevation)} m`
            : ground.status === "done"
              ? `${formatShare(ground.stats.groundPoints, ground.stats.pointCount)} ground`
              : undefined
        }
        states={[ground, terrain]}
        busy={busy}
        onRun={() => void analysis.analyzeTerrain()}
        summary={terrain.status === "done" || terrain.status === "failed" ? terrainSummary(terrain, analysis.hasGround, source?.origin[1] ?? 0) : groundSummary(ground)}
      >
        {terrain.status === "done" ? (
          <div className="toggle-list">
            <Toggle label="Terrain surface" pressed={view.showSurface} onChange={view.setShowSurface} />
            <Toggle label="Contour lines" pressed={view.showContours} onChange={view.setShowContours} />
            <Toggle label="Points" pressed={view.showPoints} onChange={view.setShowPoints} />
          </div>
        ) : null}
        {ground.status === "done" ? <ColourLink workspace={workspace} mode="heightAboveGround" label="Colour by height above ground" /> : null}
      </ResultCard>

      <ResultCard
        icon="building"
        title="Buildings and trees"
        value={count.status === "done" ? `${count.stats.buildings} · ${count.stats.trees}` : undefined}
        states={[count]}
        busy={busy}
        onRun={() => void analysis.analyzeObjects()}
        summary={countSummary(count)}
      >
        {count.status === "done" ? (
          <>
            <div className="tally">
              <div>
                <strong>{count.stats.buildings.toLocaleString("en-US")}</strong>
                <span>
                  <i style={{ background: "var(--building)" }} />
                  {count.stats.buildings === 1 ? "Building" : "Buildings"}
                </span>
              </div>
              <div>
                <strong>{count.stats.trees.toLocaleString("en-US")}</strong>
                <span>
                  <i style={{ background: "var(--tree)" }} />
                  {count.stats.trees === 1 ? "Tree" : "Trees"}
                </span>
              </div>
            </div>
            <div className="toggle-list">
              <Toggle label="Building outlines" swatch="var(--building)" pressed={view.showBuildingOutlines} onChange={view.setShowBuildingOutlines} />
              <Toggle label="Tree outlines" swatch="var(--tree)" pressed={view.showTreeOutlines} onChange={view.setShowTreeOutlines} />
            </div>
            <ColourLink workspace={workspace} mode="objects" label="Colour each object" />
          </>
        ) : null}
      </ResultCard>
    </section>
  );
}

function ColourLink({ workspace, mode, label }: { workspace: Workspace; mode: "heightAboveGround" | "objects"; label: string }) {
  const { view } = workspace;
  if (view.colorMode === mode || !view.supports[mode]) return null;
  return (
    <button type="button" className="link-btn" onClick={() => view.setColorMode(mode)}>
      {label}
    </button>
  );
}

type AnyState = NoiseState | GroundState | TerrainState | CountState;

function ResultCard({
  icon,
  title,
  value,
  states,
  busy,
  onRun,
  summary,
  children,
}: {
  icon: IconName;
  title: string;
  value: string | undefined;
  states: readonly AnyState[];
  busy: boolean;
  onRun: () => void;
  summary: string;
  children?: ReactNode;
}) {
  const running = states.find((state) => state.status === "running");
  const failed = states.find((state) => state.status === "failed");
  const done = states.every((state) => state.status === "done");
  return (
    <section className={`result${running !== undefined ? " is-running" : ""}${done ? " is-done" : ""}`}>
      <header>
        <span className="result-icon">{done ? <Icon name="check" /> : <Icon name={icon} />}</span>
        <h3>{title}</h3>
        {value === undefined ? null : <span className="result-value">{value}</span>}
        <button type="button" className="icon-btn result-run" title={done ? `Run ${title.toLowerCase()} again` : `Run only ${title.toLowerCase()}`} disabled={busy} onClick={onRun}>
          <Icon name={done ? "refresh" : "play"} />
        </button>
      </header>
      {running !== undefined && running.status === "running" ? (
        <>
          <p className="result-stage">{`${running.stage} · ${Math.round(running.fraction * 100)}%`}</p>
          <ProgressBar label={`${title} progress`} fraction={running.fraction} />
        </>
      ) : (
        <Note tone={failed === undefined ? undefined : "error"}>{summary}</Note>
      )}
      {running === undefined ? children : null}
    </section>
  );
}
