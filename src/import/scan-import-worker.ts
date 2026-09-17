import { definedChannels } from "../core/point-cloud.js";
import { blobSource } from "./byte-source.js";
import { importScan } from "./scan-file-importer.js";
import type { ScanImportMessage, ScanImportRequest } from "./scan-import-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ScanImportRequest>) => void) | null;
  postMessage: (message: ScanImportMessage, transfer?: ArrayBuffer[]) => void;
};

/** Progress is reported in steps of this size, so a fast read does not flood the page with messages. */
const progressStep = 0.01;

scope.onmessage = async (event: MessageEvent<ScanImportRequest>) => {
  const { file, name } = event.data;
  let reported = -1;
  try {
    const cloud = await importScan(blobSource(file), name, (fraction) => {
      if (fraction - reported < progressStep && fraction < 1) return;
      reported = fraction;
      scope.postMessage({ kind: "progress", fraction });
    });
    const channels = definedChannels(cloud);
    // Every array is handed over rather than copied: the worker is done with
    // them, and copying a large scan would briefly double its memory.
    const transfer = [cloud.positions, ...Object.values(channels)].map((array) => (array as ArrayBufferView).buffer as ArrayBuffer);
    scope.postMessage(
      {
        kind: "done",
        name: cloud.name,
        positions: cloud.positions,
        ...channels,
        bounds: cloud.bounds,
        origin: cloud.origin,
        ...(cloud.spatialReference === undefined ? {} : { spatialReference: cloud.spatialReference }),
      },
      [...new Set(transfer)],
    );
  } catch (error) {
    scope.postMessage({ kind: "failed", message: error instanceof Error ? error.message : "The scan could not be read" });
  }
};
