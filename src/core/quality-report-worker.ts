import { buildQualityReport } from "./quality-report.js";
import type { QualityReportMessage, QualityReportRequest } from "./quality-report-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<QualityReportRequest>) => void) | null;
  postMessage: (message: QualityReportMessage, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = (event: MessageEvent<QualityReportRequest>) => {
  const { options, ...input } = event.data;
  try {
    const report = buildQualityReport(input, options, (stage, fraction) => scope.postMessage({ kind: "progress", stage, fraction }));
    scope.postMessage({ kind: "done", report }, [report.density.grid.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "Building the quality report failed" });
  }
};
