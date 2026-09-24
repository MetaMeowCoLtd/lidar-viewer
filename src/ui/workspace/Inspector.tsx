import { Icon } from "../icons.js";
import { classificationName } from "../../core/point-cloud-classification.js";
import { measureBetween, type PointDetails } from "../../core/point-inspection.js";
import { formatCoordinate, formatLength, formatNumber } from "../format.js";
import type { DetectedObject } from "../../core/object-detection.js";
import type { Workspace } from "./use-workspace.js";

/**
 * What the last click found, beside the scan: a point with everything known
 * about it, or a measurement between two. It is also where an object's own
 * figures appear, which is the place corrections to a count will go.
 */
export function Inspector({ workspace }: { workspace: Workspace }) {
  const { picking, source } = workspace;
  if (source === undefined) return null;
  const { picks, clickTool, inspectedObject } = picking;

  if (clickTool === "measure" && picks.from !== undefined) {
    return (
      <Card title="Measurement" onClose={picking.clearMeasurement}>
        <MeasurementBody from={picks.from} to={picks.to} />
      </Card>
    );
  }

  if (clickTool === "inspect" && picks.inspected !== undefined) {
    return (
      <Card title={source.isGeoreferenced ? "Point" : "Point · local coordinates"} onClose={picking.clearInspected}>
        <PointBody point={picks.inspected} object={inspectedObject} />
      </Card>
    );
  }

  return null;
}

function Card({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <section className="ws-inspector" aria-label={title} aria-live="polite">
      <header>
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={`Clear the ${title.toLowerCase()}`}>
          <Icon name="close" />
        </button>
      </header>
      {children}
    </section>
  );
}

function PointBody({ point, object }: { point: PointDetails; object: DetectedObject | undefined }) {
  const rows: [string, string][] = [
    ["East", formatCoordinate(point.map[0])],
    ["North", formatCoordinate(point.map[1])],
    ["Elevation", formatLength(point.map[2])],
  ];
  if (point.classification !== undefined) rows.push(["Class", classificationName(point.classification)]);
  if (point.heightAboveGround !== undefined) rows.push(["Above ground", formatLength(point.heightAboveGround)]);
  if (point.returnNumber !== undefined && point.numberOfReturns !== undefined && point.numberOfReturns > 0) {
    rows.push(["Return", `${point.returnNumber} of ${point.numberOfReturns}`]);
  }
  if (point.pointSourceId !== undefined && point.pointSourceId > 0) {
    rows.push(["Flight line", String(point.pointSourceId)]);
  }
  if (point.intensity !== undefined) rows.push(["Intensity", formatNumber(point.intensity, 0)]);

  return (
    <>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {object === undefined ? null : (
        <div className="ws-inspector-object">
          <p>
            <i style={{ background: object.kind === "building" ? "var(--building)" : "var(--tree)" }} />
            {object.kind === "building" ? "Building" : "Tree"} {object.id}
          </p>
          <dl>
            <div>
              <dt>Height</dt>
              <dd>{formatLength(object.height)}</dd>
            </div>
            <div>
              <dt>{object.kind === "building" ? "Footprint" : "Crown"}</dt>
              <dd>{`${Math.round(object.kind === "building" ? object.footprintArea : object.crownArea).toLocaleString("en-US")} m²`}</dd>
            </div>
            <div>
              <dt>Points</dt>
              <dd>{object.pointCount.toLocaleString("en-US")}</dd>
            </div>
          </dl>
        </div>
      )}
    </>
  );
}

function MeasurementBody({ from, to }: { from: PointDetails; to: PointDetails | undefined }) {
  if (to === undefined) {
    return (
      <p className="ws-inspector-hint">
        <i className="ws-pick-dot ws-pick-from" />A is at {formatLength(from.map[2])} elevation. Click a second point.
      </p>
    );
  }
  const measurement = measureBetween(from, to);
  return (
    <>
      <p className="ws-inspector-headline">{formatLength(measurement.distance)}</p>
      <dl>
        <div>
          <dt>Horizontal</dt>
          <dd>{formatLength(measurement.horizontal)}</dd>
        </div>
        <div>
          <dt>Height</dt>
          <dd>{`${measurement.vertical >= 0 ? "+" : "−"}${formatLength(Math.abs(measurement.vertical))}`}</dd>
        </div>
        <div>
          <dt>Slope</dt>
          <dd>{`${measurement.slopeDegrees.toFixed(1)}°`}</dd>
        </div>
      </dl>
      <p className="ws-inspector-hint">
        <i className="ws-pick-dot ws-pick-from" />A {formatLength(from.map[2])}
        <i className="ws-pick-dot ws-pick-to" />B {formatLength(to.map[2])} · click again to start over
      </p>
    </>
  );
}
