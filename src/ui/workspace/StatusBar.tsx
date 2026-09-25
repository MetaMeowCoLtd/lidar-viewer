import type { Workspace } from "./use-workspace.js";

/**
 * One line along the bottom: what the app is doing right now, or what went
 * wrong. What the scan is lives in the top bar, and what the analyses found
 * on their cards, so neither is repeated here.
 */
export function StatusBar({ workspace }: { workspace: Workspace }) {
  const { status, statusText, analysis, importProgress, exports } = workspace;
  const busy = importProgress !== undefined || analysis.analysing || status === "processing";

  let message = statusText;
  if (importProgress !== undefined) {
    const label = importProgress.stage === "reading" ? "Reading the file" : importProgress.stage === "downloading" ? "Downloading the sample survey" : "Building detail levels";
    message = `${label} · ${Math.round(importProgress.fraction * 100)}%`;
  } else if (analysis.pipeline !== undefined) {
    message = `${analysis.pipeline.label} · step ${analysis.pipeline.step} of ${analysis.pipeline.total}`;
  } else if (exports.exportError !== undefined) {
    message = `Export failed: ${exports.exportError}`;
  }
  const failed = status === "error" || (!busy && exports.exportError !== undefined);

  return (
    <footer className="ws-status">
      <span className={`ws-dot ws-dot-${failed ? "error" : busy ? "busy" : "ready"}`} />
      <span className="ws-status-message">{message}</span>
    </footer>
  );
}
