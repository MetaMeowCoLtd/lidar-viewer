import { ProceduralCloudGenerator } from "./procedural-cloud-generator.js";
import type { SampleMessage, SampleRequest } from "./sample-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SampleRequest>) => void) | null;
  postMessage: (message: SampleMessage, transfer?: ArrayBuffer[]) => void;
};

scope.onmessage = (event: MessageEvent<SampleRequest>) => {
  const { pointCount, seed } = event.data;
  try {
    const data = new ProceduralCloudGenerator().generateData({
      pointCount,
      seed,
      onProgress: (fraction) => scope.postMessage({ kind: "progress", fraction }),
    });
    scope.postMessage({ kind: "done", data }, [
      data.positions.buffer as ArrayBuffer,
      data.colors.buffer as ArrayBuffer,
      data.intensity.buffer as ArrayBuffer,
      data.returnNumber.buffer as ArrayBuffer,
      data.numberOfReturns.buffer as ArrayBuffer,
      data.pointSourceId.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "Simulating the sample survey failed" });
  }
};
