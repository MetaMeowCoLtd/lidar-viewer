import { Icon } from "../../icons.js";
import { Note, ProgressBar } from "../../controls.js";
import { formatCount, formatOrigin, ordinalSuffix } from "../../format.js";
import type { Workspace } from "../use-workspace.js";

/** The scan on screen and how to replace it. */
export function ScanPanel({ workspace }: { workspace: Workspace }) {
  const { source, sourceLabel, sampling, importProgress, actions, maxImportPoints } = workspace;

  return (
    <div className="panel">
      <h2 className="panel-title">Scan</h2>

      {source === undefined ? (
        <Note>No scan is open. Choose a file or load the sample city to get started.</Note>
      ) : (
        <div className="scan-card">
          <strong title={sourceLabel}>{sourceLabel}</strong>
          <dl>
            <div>
              <dt>Points</dt>
              <dd>{source.pointCount.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Coordinates</dt>
              <dd>{source.spatialReference?.epsg === undefined ? formatOrigin(source) : `EPSG:${source.spatialReference.epsg}`}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{`${Math.round(source.bounds.size[0])} × ${Math.round(source.bounds.size[2])} m`}</dd>
            </div>
          </dl>
        </div>
      )}

      {sampling === undefined ? null : (
        <Note tone="warning">
          {`This scan has ${formatCount(sampling.total)} points. Every ${Math.ceil(sampling.total / sampling.loaded)}${ordinalSuffix(
            Math.ceil(sampling.total / sampling.loaded),
          )} point is loaded, ${formatCount(sampling.loaded)} in all, spread evenly. Raise maxImportPoints in viewer-config.json on a machine with memory to spare.`}
        </Note>
      )}

      <div className="panel-actions">
        <button type="button" className="btn btn-block" onClick={actions.openFilePicker}>
          <Icon name="folder" /> Open a scan
        </button>
        <button type="button" className="btn btn-block" onClick={() => actions.loadSample()}>
          <Icon name="city" /> Load the sample city
        </button>
      </div>

      {importProgress === undefined ? null : (
        <div className="panel-progress">
          <ProgressBar label="Opening the scan" fraction={importProgress.fraction} />
        </div>
      )}

      <Note>
        {`Reads LAS, LAZ and PLY up to ${formatCount(maxImportPoints)} points. Everything stays on this device; no scan is uploaded.`}
      </Note>
    </div>
  );
}
