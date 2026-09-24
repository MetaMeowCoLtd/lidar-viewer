import type { PointCloud } from "./point-cloud.js";
import type { Checkpoint, QualityReport, QualityReportOptions, QualityReportProgress } from "./quality-report.js";
import type { QualityReportMessage, QualityReportRequest } from "./quality-report-protocol.js";

export interface QualityReportJob {
  readonly result: Promise<QualityReport>;
  cancel(): void;
}

export class QualityReportCancelled extends Error {
  public constructor() {
    super("The quality report was cancelled");
    this.name = "QualityReportCancelled";
  }
}

/** Builds a cloud's quality report on a worker of its own; channels are copied so the cloud stays drawable. */
export function startQualityReport(
  cloud: PointCloud,
  checkpoints: readonly Checkpoint[] | undefined,
  options: QualityReportOptions,
  onProgress?: QualityReportProgress,
  thinning?: { readonly loaded: number; readonly total: number },
): QualityReportJob {
  const worker = new Worker(new URL("./quality-report-worker.ts", import.meta.url), { type: "module" });
  let cancel: () => void = () => undefined;
  const result = new Promise<QualityReport>((resolve, reject) => {
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      return true;
    };
    cancel = () => {
      if (settle()) reject(new QualityReportCancelled());
    };
    worker.onmessage = (event: MessageEvent<QualityReportMessage>) => {
      const message = event.data;
      if (message.kind === "progress") {
        if (!settled) onProgress?.(message.stage, message.fraction);
        return;
      }
      if (!settle()) return;
      if (message.kind === "done") resolve(message.report);
      else reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      if (settle()) reject(new Error(event.message || "The quality report worker stopped unexpectedly"));
    };
    const request: QualityReportRequest = {
      positions: cloud.positions,
      bounds: cloud.bounds,
      origin: cloud.origin,
      ...(cloud.classification === undefined ? {} : { classification: cloud.classification }),
      ...(cloud.returnNumber === undefined ? {} : { returnNumber: cloud.returnNumber }),
      ...(cloud.numberOfReturns === undefined ? {} : { numberOfReturns: cloud.numberOfReturns }),
      ...(cloud.pointSourceId === undefined ? {} : { pointSourceId: cloud.pointSourceId }),
      ...(checkpoints === undefined ? {} : { checkpoints }),
      ...(thinning === undefined ? {} : { thinning }),
      options,
    };
    worker.postMessage(request);
  });
  return { result, cancel: () => cancel() };
}
