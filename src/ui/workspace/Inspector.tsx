import { Icon } from "../icons.js";
import { classificationName } from "../../core/point-cloud-classification.js";
import { measureBetween, type PointDetails } from "../../core/point-inspection.js";
import { planArea, type VolumeBase } from "../../core/polygon-measure.js";
import { formatArea, formatCoordinate, formatLength, formatNumber, formatShare, formatVolume } from "../format.js";
import type { DetectedObject } from "../../core/object-detection.js";
import type { Workspace } from "./use-workspace.js";
import type { PolygonPick, Ruler } from "./types.js";

/**
 * What the last click found, beside the scan: a point with everything known
 * about it, or a measurement between two. It is also where an object's own
 * figures appear, which is the place corrections to a count will go.
 */
export function Inspector({ workspace }: { workspace: Workspace }) {
  const { picking, source } = workspace;
  if (source === undefined) return null;
  const { picks, clickTool, inspectedObject } = picking;

  if (clickTool === "measure") {
    const placing = picks.rulers.at(-1)?.to === undefined && picks.rulers.length > 0;
    if (picks.rulers.length === 0) {
      return (
        <Card title="Distance" onClose={() => picking.setClickTool("inspect")} closeLabel="Stop measuring">
          <p className="ws-inspector-hint">Click where the ruler starts, then where it ends. Each end snaps to the scan point under the cursor.</p>
        </Card>
      );
    }
    return (
      <Card title={picks.rulers.length === 1 ? "Measurement" : `${picks.rulers.length} rulers`} onClose={picking.clearRulers} closeLabel="Remove every ruler">
        {picks.rulers.length === 1 ? (
          <MeasurementBody from={picks.rulers[0]!.from} to={picks.rulers[0]!.to} />
        ) : (
          <RulerList rulers={picks.rulers} onRemove={picking.removeRuler} />
        )}
        {placing ? (
          <Keys
            rows={[
              ["Click", "where it ends"],
              ["X Y Z", picking.lock === undefined ? "hold the end to east, north or vertical" : `held ${lockNames[picking.lock]} · press again to let go`],
              ["Shift Z", "keep it level with the start"],
              ["Esc", "drop this ruler"],
            ]}
          />
        ) : (
          <Keys
            rows={[
              ["Click", "start another ruler"],
              ["Drag", "an end to move it"],
              ["Del", "the ruler under the cursor"],
            ]}
          />
        )}
      </Card>
    );
  }

  if (clickTool === "polygon") return <PolygonCard workspace={workspace} />;

  if (clickTool === "area") {
    if (picks.surfaces.length === 0) {
      return (
        <Card title="Surface area" onClose={() => picking.setClickTool("inspect")} closeLabel="Stop measuring surfaces">
          <p className="ws-inspector-hint">Click a roof, a yard or a road: the flat or evenly sloped surface under the click is outlined and measured.</p>
        </Card>
      );
    }
    return (
      <Card title={picks.surfaces.length === 1 ? "Surface area" : `${picks.surfaces.length} surfaces`} onClose={picking.clearSurfaces} closeLabel="Remove every surface">
        <ol className="ws-rulers">
          {picks.surfaces.map((each) => {
            const sloped = each.surface.slopeDegrees >= 2;
            return (
              <li key={each.id}>
                <b>{each.id}</b>
                <span>
                  <strong>{formatArea(each.surface.planArea)}</strong>
                  <small>{sloped ? `${formatArea(each.surface.surfaceArea)} along a ${each.surface.slopeDegrees.toFixed(0)}° pitch` : "level"}</small>
                </span>
                <button type="button" className="icon-btn" onClick={() => picking.removeSurface(each.id)} aria-label={`Remove surface ${each.id}`} title="Remove this surface">
                  <Icon name="close" />
                </button>
              </li>
            );
          })}
        </ol>
        {picks.surfaces.length > 1 ? <p className="ws-inspector-headline ws-area-total">{`${formatArea(picking.totalSurfaceArea)} in all`}</p> : null}
        {picking.mergeableSurfaces > 1 ? (
          <button type="button" className="btn ws-merge" onClick={picking.mergeTouchingSurfaces} title="Surfaces that overlap or touch become one, their shared cells counted once">
            {`Merge touching surfaces (${picking.mergeableSurfaces})`}
          </button>
        ) : null}
        <p className="ws-inspector-hint">
          Areas are as a plan measures them; a sloped surface's own area is given beside it. Click another surface to add it; if a click covered only part of one, click the rest and merge them.
        </p>
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

function Card({
  title,
  onClose,
  closeLabel,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={wide ? "ws-inspector ws-inspector-wide" : "ws-inspector"} aria-label={title} aria-live="polite">
      <header>
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={closeLabel ?? `Clear the ${title.toLowerCase()}`} title={closeLabel}>
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

/** Every ruler on one line each: its length, its height and slope, and a button to take it away. */
function RulerList({ rulers, onRemove }: { rulers: readonly Ruler[]; onRemove: (id: number) => void }) {
  return (
    <ol className="ws-rulers">
      {rulers.map((ruler) => {
        const measurement = ruler.to === undefined ? undefined : measureBetween(ruler.from, ruler.to);
        return (
          <li key={ruler.id}>
            <b>{ruler.id}</b>
            {measurement === undefined ? (
              <span className="ws-rulers-pending">placing…</span>
            ) : (
              <span>
                <strong>{formatLength(measurement.distance)}</strong>
                <small>{`${measurement.vertical >= 0 ? "+" : "−"}${formatLength(Math.abs(measurement.vertical))} · ${measurement.slopeDegrees.toFixed(1)}°`}</small>
              </span>
            )}
            <button type="button" className="icon-btn" onClick={() => onRemove(ruler.id)} aria-label={`Remove ruler ${ruler.id}`} title="Remove this ruler">
              <Icon name="close" />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function MeasurementBody({ from, to }: { from: PointDetails; to: PointDetails | undefined }) {
  if (to === undefined) {
    return (
      <p className="ws-inspector-hint">
        <i className="ws-pick-dot ws-pick-from" />A is at {formatLength(from.map[2])} elevation.
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
        <i className="ws-pick-dot ws-pick-to" />B {formatLength(to.map[2])}
      </p>
    </>
  );
}

const lockNames = { x: "east–west (X)", y: "north–south (Y)", z: "vertical (Z)", plane: "level" } as const;

/** Keys and what they do now, as a DCC's status bar lists them for the tool in hand. */
function Keys({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="ws-keys">
      {rows.map(([key, action]) => (
        <div key={key}>
          <dt>
            {key.split(" ").map((part) => (
              <kbd key={part}>{part}</kbd>
            ))}
          </dt>
          <dd>{action}</dd>
        </div>
      ))}
    </dl>
  );
}

const baseChoices: ReadonlyArray<{ value: VolumeBase; label: string }> = [
  { value: "triangulated", label: "Through the corners" },
  { value: "fit", label: "Fitted plane" },
  { value: "lowest", label: "Lowest corner" },
  { value: "mean", label: "Mean of the corners" },
  { value: "highest", label: "Highest corner" },
  { value: "custom", label: "An elevation" },
];

/**
 * The polygon tool's card: the polygon being drawn, or the polygons drawn and
 * the figures of the one selected - its areas, the volume over its base with
 * the base's settings, and its extrusion.
 */
function PolygonCard({ workspace }: { workspace: Workspace }) {
  const { picking } = workspace;
  const { picks } = picking;
  const draft = picks.polygons.find((polygon) => !polygon.closed);
  const closed = picks.polygons.filter((polygon) => polygon.closed);

  if (draft !== undefined) {
    const corners = draft.vertices.length;
    return (
      <Card title={`Drawing polygon ${draft.id}`} onClose={() => picking.removePolygon(draft.id)} closeLabel="Cancel this polygon">
        <p className="ws-inspector-headline">{corners >= 3 ? formatArea(planArea(draft.vertices)) : `${corners} of 3 corners`}</p>
        <Keys
          rows={[
            ["Click", "add a corner on the scan"],
            ["Enter", "finish - or click the first corner, or right-click"],
            ["Backspace", "take back the last corner"],
            ["Esc", "cancel the polygon"],
          ]}
        />
      </Card>
    );
  }

  if (closed.length === 0) {
    return (
      <Card title="Area and volume" onClose={() => picking.setClickTool("inspect")} closeLabel="Stop drawing polygons">
        <p className="ws-inspector-hint">
          Click corner by corner around a stockpile, a pit, a roof or a yard. Its plan and surface area are measured, and the volume between the scan and a base
          through its corners. Extrude it for the volume of a prism.
        </p>
      </Card>
    );
  }

  const selected = closed.find((polygon) => polygon.id === picking.selectedPolygon) ?? (closed.length === 1 ? closed[0] : undefined);
  return (
    <Card title={closed.length === 1 ? `Polygon ${closed[0]!.id}` : `${closed.length} polygons`} onClose={picking.clearPolygons} closeLabel="Remove every polygon" wide>
      {closed.length > 1 ? (
        <ol className="ws-rulers ws-polygons">
          {closed.map((polygon) => {
            const result = picking.polygonResults.get(polygon.id);
            const volume = result === undefined || !result.valid ? undefined : polygon.height > 0 ? result.prism : result.cut;
            return (
              <li key={polygon.id} className={polygon.id === selected?.id ? "is-selected" : undefined}>
                <button type="button" className="ws-row-select" onClick={() => picking.selectPolygon(polygon.id)} aria-pressed={polygon.id === selected?.id}>
                  <b>{polygon.id}</b>
                  <span>
                    <strong>{result === undefined || !result.valid ? "—" : formatArea(result.planArea)}</strong>
                    <small>{volume === undefined ? "" : formatVolume(volume)}</small>
                  </span>
                </button>
                <button type="button" className="icon-btn" onClick={() => picking.removePolygon(polygon.id)} aria-label={`Remove polygon ${polygon.id}`} title="Remove this polygon">
                  <Icon name="close" />
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {selected === undefined ? (
        <p className="ws-inspector-hint">Pick a polygon from the list, or click one of its corners, to see its figures.</p>
      ) : (
        <PolygonDetails workspace={workspace} polygon={selected} />
      )}
      <Keys
        rows={[
          ["Drag", "a corner; a midpoint adds one"],
          ["Drag ↕", "blue arrow extrudes, grey moves the base"],
          ["Ctrl", "snaps a drag to 1 m, with Shift to 0.1 m"],
          ["0–9 Enter", "type an exact height after a drag"],
          ["Del", "the corner under the cursor, or the polygon"],
          ["F", "frame it · Ctrl Z undoes"],
        ]}
      />
    </Card>
  );
}

function PolygonDetails({ workspace, polygon }: { workspace: Workspace; polygon: PolygonPick }) {
  const { picking, source } = workspace;
  const result = picking.polygonResults.get(polygon.id);
  if (result === undefined || source === undefined) return null;
  if (!result.valid) {
    return <p className="note note-warning">Its edges cross, so it encloses nothing to measure. Drag a corner to untangle it.</p>;
  }
  const origin = source.origin[1];
  const level = polygon.base !== "triangulated" && polygon.base !== "fit";
  const net = result.cut - result.fill;
  const steep = result.edgeLength > result.perimeter * 1.01;
  return (
    <>
      <p className="ws-inspector-headline">{formatArea(result.planArea)}</p>
      <dl>
        <Row label="Surface area" value={formatArea(result.surfaceArea)} />
        <Row label="Perimeter" value={steep ? `${formatLength(result.perimeter)} · ${formatLength(result.edgeLength)} along` : formatLength(result.perimeter)} />
      </dl>

      <h3 className="ws-inspector-section">Volume over the base</h3>
      <label className="ws-field">
        <span>Base</span>
        <select aria-label="Base of the volume" value={polygon.base} onChange={(event) => picking.setPolygonBase(polygon.id, event.target.value as VolumeBase)}>
          {baseChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ws-field">
        <span>{level ? "Base elevation" : "Base, on average"}</span>
        {level ? (
          <NumberInput value={origin + picking.baseLevel(polygon)} label="Base elevation" onCommit={(value) => picking.setPolygonBaseElevation(polygon.id, value)} />
        ) : (
          <output>{formatLength(origin + result.baseMean)}</output>
        )}
      </label>
      <dl>
        <Row label="Above the base (cut)" value={formatVolume(result.cut)} />
        <Row label="Below the base (fill)" value={formatVolume(result.fill)} />
        <Row label="Net" value={`${net < 0 ? "−" : ""}${formatVolume(Math.abs(net))}`} />
      </dl>

      <h3 className="ws-inspector-section">Extrusion</h3>
      <label className="ws-field">
        <span>Height</span>
        <NumberInput value={polygon.height} label="Extrusion height" onCommit={(value) => picking.setPolygonHeight(polygon.id, value)} />
      </label>
      {polygon.height > 0 ? (
        <dl>
          <Row label="Prism volume" value={formatVolume(result.prism)} />
          <Row label="Filled by the scan" value={`${formatVolume(result.filled)} · ${formatShare(result.filled, result.prism)}`} />
        </dl>
      ) : null}
      {result.unmeasured >= 0.01 ? (
        <p className="note">{`No points fell in ${formatShare(result.unmeasured, 1)} of it; the surface there is filled in from around it.`}</p>
      ) : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * A number field that applies its value when Enter is pressed or it loses
 * focus, not on every keystroke: each change is one undo step, and a half-typed
 * number never reaches the scan. Escape puts back what it showed.
 */
function NumberInput({ value, label, onCommit }: { value: number; label: string; onCommit: (value: number) => void }) {
  const shown = value.toFixed(2);
  return (
    <span className="ws-number">
      <input
        key={shown}
        type="text"
        inputMode="decimal"
        defaultValue={shown}
        aria-label={label}
        onBlur={(event) => {
          const typed = Number(event.currentTarget.value.replace(",", "."));
          if (Number.isFinite(typed) && event.currentTarget.value.trim() !== "" && Math.abs(typed - value) > 1e-6) onCommit(typed);
          else event.currentTarget.value = shown;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.currentTarget.value = shown;
            event.currentTarget.blur();
          }
        }}
      />
      <span>m</span>
    </span>
  );
}
