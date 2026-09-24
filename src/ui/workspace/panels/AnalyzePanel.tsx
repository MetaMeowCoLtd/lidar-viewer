import type { ReactNode } from "react";
import { Icon } from "../../icons.js";
import { Note, ProgressBar } from "../../controls.js";
import { countSummary, groundSummary, noiseSummary, progressHeadline, terrainSummary } from "../analysis-text.js";
import type { Workspace } from "../use-workspace.js";
import type { CountState, GroundState, NoiseState, TerrainState } from "../types.js";

/**
 * The three analyses as numbered steps. A step says what it will do, what it
 * found, and - when it depends on another - which one has to run first, so the
 * order is visible instead of implied by a disabled button.
 */
export function AnalyzePanel({ workspace }: { workspace: Workspace }) {
  const { analysis, source, status } = workspace;
  const ready = source !== undefined && status === "ready" && !analysis.analysing;

  return (
    <div className="panel">
      <h2 className="panel-title">Analyze</h2>

      <Step
        number={1}
        title="Noise"
        state={analysis.noise}
        action={analysis.noise.status === "done" ? "Find again" : "Find noise"}
        ready={ready}
        onRun={() => void analysis.findNoise()}
        summary={noiseSummary(analysis.noise)}
      />

      <Step
        number={2}
        title="Ground"
        state={analysis.ground}
        action={analysis.ground.status === "done" ? "Detect again" : "Detect ground"}
        ready={ready}
        onRun={() => void analysis.detectGround()}
        summary={groundSummary(analysis.ground)}
      />

      <Step
        number={3}
        title="Terrain"
        state={analysis.terrain}
        action={analysis.terrain.status === "done" ? "Build again" : "Build terrain"}
        ready={ready && analysis.hasGround}
        blocked={analysis.hasGround ? undefined : "Needs ground"}
        onRun={() => void analysis.buildTerrain()}
        summary={terrainSummary(analysis.terrain, analysis.hasGround, source?.origin[1] ?? 0)}
      />

      <Step
        number={4}
        title="Buildings and trees"
        state={analysis.count}
        action={analysis.count.status === "done" ? "Count again" : "Count objects"}
        ready={ready}
        onRun={() => void analysis.countObjects()}
        summary={countSummary(analysis.count)}
      >
        {analysis.count.status === "done" ? (
          <div className="tally">
            <div>
              <strong>{analysis.count.stats.buildings.toLocaleString("en-US")}</strong>
              <span>
                <i style={{ background: "var(--building)" }} />
                {analysis.count.stats.buildings === 1 ? "Building" : "Buildings"}
              </span>
            </div>
            <div>
              <strong>{analysis.count.stats.trees.toLocaleString("en-US")}</strong>
              <span>
                <i style={{ background: "var(--tree)" }} />
                {analysis.count.stats.trees === 1 ? "Tree" : "Trees"}
              </span>
            </div>
          </div>
        ) : null}
      </Step>
    </div>
  );
}

function Step({
  number,
  title,
  state,
  action,
  ready,
  blocked,
  summary,
  onRun,
  children,
}: {
  number: number;
  title: string;
  state: NoiseState | GroundState | TerrainState | CountState;
  action: string;
  ready: boolean;
  blocked?: string | undefined;
  summary: string;
  onRun: () => void;
  children?: ReactNode;
}) {
  const running = state.status === "running";
  const done = state.status === "done";
  return (
    <section className={`step${running ? " is-running" : ""}${done ? " is-done" : ""}`}>
      <header>
        <span className="step-number">{done ? <Icon name="check" /> : number}</span>
        <h3>{title}</h3>
        {blocked !== undefined && !done ? <span className="step-blocked">{blocked}</span> : null}
        {state.status === "failed" ? <span className="step-blocked step-failed">Failed</span> : null}
        <span className="step-time">{progressHeadline(state)}</span>
      </header>

      <button type="button" className="btn btn-block" disabled={!ready || running} onClick={onRun}>
        {running ? `${state.stage}…` : action}
      </button>

      {running ? <ProgressBar label={`${title} progress`} fraction={state.fraction} /> : null}
      {children}
      <Note tone={state.status === "failed" ? "error" : undefined}>{summary}</Note>
    </section>
  );
}
