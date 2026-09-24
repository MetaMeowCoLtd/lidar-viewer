import { PointCloud } from "./point-cloud.js";
import { sampleOrigin, sampleSpatialReference } from "./procedural-cloud-generator.js";
import type { SampleMessage, SampleRequest } from "./sample-protocol.js";

export interface SampleOptions {
  readonly pointCount: number;
  readonly seed: number;
  readonly name: string;
}

/**
 * Simulates the sample survey on a worker of its own - a couple of seconds of
 * tracing laser pulses that would otherwise freeze the page - and hands back
 * the finished, georeferenced cloud.
 */
export function generateSampleCloud(options: SampleOptions, onProgress?: (fraction: number) => void): Promise<PointCloud> {
  return new Promise<PointCloud>((resolve, reject) => {
    const worker = new Worker(new URL("./sample-worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<SampleMessage>) => {
      const message = event.data;
      if (message.kind === "progress") {
        onProgress?.(message.fraction);
        return;
      }
      finish();
      if (message.kind === "failed") {
        reject(new Error(message.message));
        return;
      }
      resolve(new PointCloud({ ...message.data, name: options.name, origin: sampleOrigin, spatialReference: sampleSpatialReference() }));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The sample survey worker stopped unexpectedly"));
    };
    const request: SampleRequest = { pointCount: options.pointCount, seed: options.seed };
    worker.postMessage(request);
  });
}
