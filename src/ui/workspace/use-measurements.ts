import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PointCloud } from "../../core/point-cloud.js";
import type { PointHit } from "../../core/point-picking.js";
import { describeLocation, describePoint, measureBetween } from "../../core/point-inspection.js";
import { buildSurfaceGrid, combinedPlanArea, mergeSurfaces, selectSurface, surfacesTouch, type SurfaceGrid } from "../../core/surface-area.js";
import { measurePolygon, planArea, polygonAnchor, polygonDrawing, type PolygonMeasurement, type PolygonShape, type Vec3, type VolumeBase } from "../../core/polygon-measure.js";
import type { ArrowAnnotation, AxisHandle, DragModifiers, AxisDragPhase, DraggableMarker, FillStyle, LidarViewer, LineStyle, MarkerAnnotation } from "../../three/lidar-viewer.js";
import { formatArea, formatLength } from "../format.js";
import { noPicks, type AxisLock, type ClickTool, type Picks, type PolygonPick, type ValueEntry } from "./types.js";

/** Steps kept for undo; older ones fall away. */
const historyLimit = 100;

/** Keys that choose a tool, as a DCC's toolbar has them: none of them move the camera. */
const toolKeys: Record<string, ClickTool> = { i: "inspect", m: "measure", r: "area", p: "polygon" };

/** A handle's id says what it moves: `ruler:<id>:from`, `poly:<id>:v:<corner>`, `poly:<id>:m:<edge>`, `poly:<id>:height`. */
type Handle =
  | { kind: "inspected" }
  | { kind: "ruler"; ruler: number; end: "from" | "to" }
  | { kind: "corner"; polygon: number; index: number }
  | { kind: "midpoint"; polygon: number; index: number }
  | { kind: "arrow"; polygon: number; which: "height" | "base" };

function parseHandle(id: string): Handle | undefined {
  if (id === "inspected") return { kind: "inspected" };
  const [kind, owner, part, index] = id.split(":");
  const number = Number(owner);
  if (kind === "ruler" && (part === "from" || part === "to")) return { kind: "ruler", ruler: number, end: part };
  if (kind !== "poly") return undefined;
  if (part === "v") return { kind: "corner", polygon: number, index: Number(index) };
  if (part === "m") return { kind: "midpoint", polygon: number, index: Number(index) };
  if (part === "height" || part === "base") return { kind: "arrow", polygon: number, which: part };
  return undefined;
}

const shapeOf = (polygon: PolygonPick): PolygonShape => ({ vertices: polygon.vertices, base: polygon.base, customBase: polygon.customBase, height: polygon.height });

const positionOf = (hit: PointHit): Vec3 => {
  const offset = hit.index * 3;
  return [hit.cloud.positions[offset]!, hit.cloud.positions[offset + 1]!, hit.cloud.positions[offset + 2]!];
};

const nextId = (items: ReadonlyArray<{ id: number }>) => items.reduce((highest, item) => Math.max(highest, item.id), 0) + 1;

/** Beyond this many grid cells a polygon takes longer to measure than a frame lasts. */
const largeDragCells = 250_000;

/** Roughly how many grid cells a polygon's measurement visits: those in its bounding box. */
function cellsUnder(polygon: PolygonPick, cellSize: number): number {
  const xs = polygon.vertices.map((vertex) => vertex[0]);
  const zs = polygon.vertices.map((vertex) => vertex[2]);
  return ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs))) / (cellSize * cellSize);
}

/** Where a ruler's end lands when held to an axis: the cursor's point, with the axes it may not leave taken from the start. */
function constrain(from: Vec3, to: Vec3, lock: AxisLock | undefined): Vec3 {
  switch (lock) {
    case "x":
      return [to[0], from[1], from[2]];
    // North is the local frame's negative z.
    case "y":
      return [from[0], from[1], to[2]];
    case "z":
      return [from[0], to[1], from[2]];
    case "plane":
      return [to[0], from[1], to[2]];
    default:
      return to;
  }
}

/** The base's height where its arrow stands: the level itself, or on a sloping base the base under the polygon's middle. */
function baseLevel(polygon: PolygonPick): number {
  const heights = polygon.vertices.map((vertex) => vertex[1]);
  switch (polygon.base) {
    case "lowest":
      return Math.min(...heights);
    case "highest":
      return Math.max(...heights);
    case "mean":
      return heights.reduce((sum, height) => sum + height, 0) / heights.length;
    case "custom":
      return polygon.customBase ?? heights[0]!;
    default:
      return polygonAnchor(shapeOf(polygon))?.[1] ?? heights[0]!;
  }
}

function snapTo(value: number, modifiers: DragModifiers): number {
  if (!modifiers.snap) return value;
  const step = modifiers.fine ? 0.1 : 1;
  return Math.round(value / step) * step;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);

/**
 * Everything the click tools make and edit: the point inspected, rulers,
 * surfaces and polygons, with the interaction a DCC tool gives them.
 *
 * - The cursor shows where a click would land before it is made, and what is
 *   being drawn follows it: a ruler's line, a polygon's next edge and area.
 * - Handles light up under the cursor. Corners and ruler ends drag over the
 *   scan and snap to it; an edge's midpoint drags out a new corner; a polygon's
 *   arrows extrude it and move its base, with Ctrl snapping to whole metres and
 *   Shift moving finely, and after a drag a typed number sets the value exactly.
 * - Every change can be undone with Ctrl+Z and redone with Ctrl+Shift+Z.
 *
 * State the viewer's listeners read lives in refs kept in step with it, as
 * those listeners are registered once for the viewer's whole life.
 */
export function useMeasurements(viewerRef: RefObject<LidarViewer | undefined>, source: PointCloud | undefined) {
  const [clickTool, setClickToolState] = useState<ClickTool>("inspect");
  const clickToolRef = useRef(clickTool);
  const [picks, setPicksState] = useState<Picks>(noPicks);
  const picksRef = useRef(picks);
  const historyRef = useRef<{ past: Picks[]; future: Picks[] }>({ past: [], future: [] });
  const [historySize, setHistorySize] = useState({ undo: 0, redo: 0 });
  const [selected, setSelectedState] = useState<number>();
  const selectedRef = useRef<number | undefined>(undefined);
  const [lock, setLockState] = useState<AxisLock>();
  const lockRef = useRef<AxisLock | undefined>(undefined);
  const [entry, setEntryState] = useState<ValueEntry>();
  const entryRef = useRef<ValueEntry | undefined>(undefined);
  /** Which arrow a typed number sets: the one last dragged. */
  const entryTargetRef = useRef<"height" | "base">("height");
  const hoverRef = useRef<{ hit: PointHit | undefined; handle: string | undefined }>({ hit: undefined, handle: undefined });
  const dragRef = useRef<{ id: string; start: Picks; value?: number; inserted?: number } | undefined>(undefined);
  const sourceRef = useRef(source);
  const measureLabelRef = useRef<HTMLDivElement>(null);
  const previewLabelRef = useRef<HTMLDivElement>(null);
  /** The scan's highest surface for picking a roof, built on first use and kept while the points stay the same. */
  const surfaceGridRef = useRef<{ positions: Float32Array; grid: SurfaceGrid } | undefined>(undefined);
  /** Its mean surface for volumes, likewise. */
  const volumeGridRef = useRef<{ positions: Float32Array; grid: SurfaceGrid; results: WeakMap<PolygonPick, PolygonMeasurement> } | undefined>(undefined);

  useLayoutEffect(() => {
    sourceRef.current = source;
  }, [source]);

  const setClickToolRaw = useCallback((tool: ClickTool) => {
    clickToolRef.current = tool;
    setClickToolState(tool);
  }, []);
  const setSelected = useCallback((id: number | undefined) => {
    selectedRef.current = id;
    setSelectedState(id);
  }, []);
  const setLock = useCallback((next: AxisLock | undefined) => {
    lockRef.current = next;
    setLockState(next);
  }, []);
  const setEntry = useCallback((next: ValueEntry | undefined) => {
    entryRef.current = next;
    setEntryState(next);
  }, []);

  /** The one way picks change: the ref is updated at once, so a second change in the same event builds on the first. */
  const applyPicks = useCallback((update: (current: Picks) => Picks, undoable = true) => {
    const current = picksRef.current;
    const next = update(current);
    if (next === current) return;
    if (undoable) {
      const history = historyRef.current;
      history.past.push(current);
      if (history.past.length > historyLimit) history.past.shift();
      history.future = [];
      setHistorySize({ undo: history.past.length, redo: 0 });
    }
    picksRef.current = next;
    setPicksState(next);
  }, []);

  /** Keeps an undo step for a change that will arrive in many parts, such as a drag. */
  const recordStep = useCallback(() => {
    const history = historyRef.current;
    history.past.push(picksRef.current);
    if (history.past.length > historyLimit) history.past.shift();
    history.future = [];
    setHistorySize({ undo: history.past.length, redo: 0 });
  }, []);

  const travel = useCallback((from: "past" | "future") => {
    const history = historyRef.current;
    const step = history[from].pop();
    if (step === undefined) return;
    const current = picksRef.current;
    (from === "past" ? history.future : history.past).push(current);
    // What is inspected is not a measurement, and is kept as it is.
    const next = { ...step, inspected: current.inspected };
    picksRef.current = next;
    setPicksState(next);
    setHistorySize({ undo: history.past.length, redo: history.future.length });
    if (selectedRef.current !== undefined && !next.polygons.some((polygon) => polygon.id === selectedRef.current)) setSelected(undefined);
    setEntry(undefined);
  }, [setEntry, setSelected]);
  const undo = useCallback(() => travel("past"), [travel]);
  const redo = useCallback(() => travel("future"), [travel]);

  /** Forgets everything, for a new scan: its measurements, their history and the tool's state. */
  const reset = useCallback(() => {
    historyRef.current = { past: [], future: [] };
    hoverRef.current = { hit: undefined, handle: undefined };
    dragRef.current = undefined;
    setHistorySize({ undo: 0, redo: 0 });
    picksRef.current = noPicks;
    setPicksState(noPicks);
    setSelected(undefined);
    setLock(undefined);
    setEntry(undefined);
  }, [setEntry, setLock, setSelected]);

  const volumeGrid = useCallback((cloud: PointCloud) => {
    let cached = volumeGridRef.current;
    // Analyses replace the cloud but never move its points, so the grid lasts until another scan is opened.
    if (cached === undefined || cached.positions !== cloud.positions) {
      cached = { positions: cloud.positions, grid: buildSurfaceGrid(cloud, undefined, "mean"), results: new WeakMap() };
      volumeGridRef.current = cached;
    }
    return cached;
  }, []);

  // ------------------------------------------------------------ polygons

  const draftOf = (current: Picks) => current.polygons.find((polygon) => !polygon.closed);

  const updatePolygon = useCallback(
    (id: number, update: (polygon: PolygonPick) => PolygonPick, undoable = true) =>
      applyPicks((current) => ({ ...current, polygons: current.polygons.map((polygon) => (polygon.id === id ? update(polygon) : polygon)) }), undoable),
    [applyPicks],
  );

  /** Adds a corner to the polygon being drawn, or starts a new one. */
  const addCorner = useCallback(
    (at: Vec3) => {
      const draft = draftOf(picksRef.current);
      if (draft !== undefined) {
        const last = draft.vertices.at(-1);
        if (last !== undefined && last[0] === at[0] && last[1] === at[1] && last[2] === at[2]) return;
        updatePolygon(draft.id, (polygon) => ({ ...polygon, vertices: [...polygon.vertices, at] }));
        return;
      }
      const id = nextId(picksRef.current.polygons);
      applyPicks((current) => ({ ...current, polygons: [...current.polygons, { id, vertices: [at], closed: false, base: "triangulated", height: 0 }] }));
      setSelected(id);
    },
    [applyPicks, setSelected, updatePolygon],
  );

  /** Closes the polygon being drawn; one with fewer than three corners encloses nothing and is dropped. */
  const finishPolygon = useCallback(() => {
    const draft = draftOf(picksRef.current);
    if (draft === undefined) return false;
    if (draft.vertices.length < 3) {
      applyPicks((current) => ({ ...current, polygons: current.polygons.filter((polygon) => polygon.id !== draft.id) }));
      setSelected(undefined);
      return true;
    }
    updatePolygon(draft.id, (polygon) => ({ ...polygon, closed: true }));
    setSelected(draft.id);
    return true;
  }, [applyPicks, setSelected, updatePolygon]);

  const removePolygon = useCallback(
    (id: number) => {
      applyPicks((current) => ({ ...current, polygons: current.polygons.filter((polygon) => polygon.id !== id) }));
      if (selectedRef.current === id) setSelected(undefined);
      if (entryRef.current?.polygon === id) setEntry(undefined);
    },
    [applyPicks, setEntry, setSelected],
  );

  const removeCorner = useCallback(
    (id: number, index: number) => {
      const polygon = picksRef.current.polygons.find((each) => each.id === id);
      if (polygon === undefined) return;
      // A closed polygon needs three corners; taking one of the last three away takes the polygon.
      if (polygon.closed && polygon.vertices.length <= 3) removePolygon(id);
      else if (polygon.vertices.length <= 1) removePolygon(id);
      else updatePolygon(id, (each) => ({ ...each, vertices: each.vertices.filter((_, at) => at !== index) }));
    },
    [removePolygon, updatePolygon],
  );

  const insertCorner = useCallback(
    (id: number, edge: number, undoable = true) => {
      const polygon = picksRef.current.polygons.find((each) => each.id === id);
      if (polygon === undefined) return;
      const a = polygon.vertices[edge]!;
      const b = polygon.vertices[(edge + 1) % polygon.vertices.length]!;
      const middle: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      updatePolygon(id, (each) => ({ ...each, vertices: [...each.vertices.slice(0, edge + 1), middle, ...each.vertices.slice(edge + 1)] }), undoable);
    },
    [updatePolygon],
  );

  const setPolygonBase = useCallback(
    (id: number, base: VolumeBase) =>
      updatePolygon(id, (polygon) => (base === "custom" ? { ...polygon, base, customBase: polygon.customBase ?? baseLevel(polygon) } : { ...polygon, base })),
    [updatePolygon],
  );

  /** Sets a custom base at an elevation in the scan's own vertical frame. */
  const setPolygonBaseElevation = useCallback(
    (id: number, elevation: number) => {
      const origin = sourceRef.current?.origin[1] ?? 0;
      if (!Number.isFinite(elevation)) return;
      updatePolygon(id, (polygon) => ({ ...polygon, base: "custom", customBase: elevation - origin }));
    },
    [updatePolygon],
  );

  const setPolygonHeight = useCallback(
    (id: number, height: number) => {
      if (!Number.isFinite(height)) return;
      updatePolygon(id, (polygon) => ({ ...polygon, height: Math.max(0, height) }));
    },
    [updatePolygon],
  );

  // --------------------------------------------------------------- tools

  const setClickTool = useCallback(
    (tool: ClickTool) => {
      if (tool === clickToolRef.current) return;
      // A polygon left half drawn is finished if it can be, as leaving a drawing tool does in CAD.
      if (draftOf(picksRef.current) !== undefined) finishPolygon();
      // A ruler left half laid has nothing to measure.
      const last = picksRef.current.rulers.at(-1);
      if (last !== undefined && last.to === undefined) applyPicks((current) => ({ ...current, rulers: current.rulers.slice(0, -1) }), false);
      setLock(undefined);
      setEntry(undefined);
      setClickToolRaw(tool);
    },
    [applyPicks, finishPolygon, setClickToolRaw, setEntry, setLock],
  );

  useLayoutEffect(() => {
    // Two quick clicks while measuring are two points, not a request to fly.
    viewerRef.current?.setDoubleClickToFly(clickTool === "inspect");
  }, [clickTool, viewerRef]);

  // ------------------------------------------------------------- preview

  /**
   * Draws what the cursor is about to do, straight to the viewer and the
   * label, never through React: it changes every frame the cursor moves.
   */
  const refreshPreview = useCallback(() => {
    const viewer = viewerRef.current;
    const label = previewLabelRef.current;
    if (viewer === undefined) return;
    const tool = clickToolRef.current;
    const current = picksRef.current;
    const { hit, handle } = hoverRef.current;
    const at = hit === undefined ? undefined : positionOf(hit);
    const markers: MarkerAnnotation[] = [];
    const lines: Array<{ style: LineStyle; positions: number[] }> = [];
    const fills: Array<{ style: FillStyle; positions: Float32Array }> = [];
    const measurements: Array<{ from: Vec3; to: Vec3 }> = [];
    let text: string | undefined;
    let anchor: Vec3 | undefined;

    if (tool === "measure") {
      const pending = current.rulers.at(-1)?.to === undefined ? current.rulers.at(-1) : undefined;
      const lockNow = lockRef.current;
      if (pending !== undefined && lockNow !== undefined && lockNow !== "plane") {
        // A guide along the held axis, in the axis's colour, as Blender draws one.
        const from = pending.from.local;
        const reach = Math.max(50, (sourceRef.current?.bounds.diagonal ?? 100) * 2);
        const axis = lockNow === "x" ? [reach, 0, 0] : lockNow === "y" ? [0, 0, reach] : [0, reach, 0];
        lines.push({
          style: lockNow === "x" ? "axisX" : lockNow === "y" ? "axisY" : "axisZ",
          positions: [from[0] - axis[0]!, from[1] - axis[1]!, from[2] - axis[2]!, from[0] + axis[0]!, from[1] + axis[1]!, from[2] + axis[2]!],
        });
      }
      if (at !== undefined) {
        const target = pending === undefined ? at : constrain(pending.from.local, at, lockNow);
        markers.push({ position: target, tone: "snap" });
        if (pending !== undefined) {
          measurements.push({ from: pending.from.local, to: target });
          const cloud = sourceRef.current;
          if (cloud !== undefined) {
            const measured = measureBetween(pending.from, describeLocation(cloud, target));
            text = `${formatLength(measured.distance)}${lockNow === undefined ? "" : ` · ${lockNow === "plane" ? "level" : lockNow.toUpperCase()}`}`;
            anchor = [(pending.from.local[0] + target[0]) / 2, (pending.from.local[1] + target[1]) / 2, (pending.from.local[2] + target[2]) / 2];
          }
        }
      }
    } else if (tool === "polygon") {
      const draft = draftOf(current);
      const hovered = handle === undefined ? undefined : parseHandle(handle);
      const closing =
        draft !== undefined &&
        draft.vertices.length >= 3 &&
        hovered?.kind === "corner" &&
        hovered.polygon === draft.id &&
        (hovered.index === 0 || hovered.index === draft.vertices.length - 1);
      if (draft !== undefined && closing) {
        // Over the first corner, or the last again: show the polygon as a click would close it.
        const first = draft.vertices[0]!;
        markers.push({ position: first, tone: "close" });
        const drawing = polygonDrawing({ ...shapeOf(draft) }, true);
        fills.push({ style: "preview", positions: drawing.base });
        lines.push({ style: "rubber", positions: [...draft.vertices.at(-1)!, ...first] });
        text = `Close · ${formatArea(planArea(draft.vertices))}`;
        anchor = first;
      } else if (at !== undefined && hovered === undefined) {
        markers.push({ position: at, tone: "snap" });
        if (draft !== undefined) {
          const last = draft.vertices.at(-1)!;
          lines.push({ style: "rubber", positions: [...last, ...at] });
          if (draft.vertices.length >= 2) {
            lines.push({ style: "rubberClose", positions: [...at, ...draft.vertices[0]!] });
            const drawing = polygonDrawing({ ...shapeOf(draft), vertices: [...draft.vertices, at] }, true);
            fills.push({ style: "preview", positions: drawing.base });
          }
          const edge = Math.hypot(at[0] - last[0], at[1] - last[1], at[2] - last[2]);
          text = draft.vertices.length >= 2 ? `${formatLength(edge)} · ${formatArea(planArea([...draft.vertices, at]))}` : formatLength(edge);
          anchor = at;
        }
      }
    } else if (at !== undefined) {
      markers.push({ position: at, tone: "snap" });
    }

    viewer.setPreview(markers.length === 0 && lines.length === 0 && fills.length === 0 ? undefined : { markers, lines, fills, measurements });
    if (label !== null) {
      if (text === undefined || anchor === undefined) {
        label.style.display = "none";
        delete label.dataset.anchor;
      } else {
        label.textContent = text;
        label.dataset.anchor = JSON.stringify(anchor);
        label.style.display = "";
      }
    }
  }, [viewerRef]);

  // The preview follows the tool and what has been measured, not only the cursor.
  useEffect(() => {
    refreshPreview();
  }, [clickTool, picks, lock, refreshPreview]);

  // ---------------------------------------------------- viewer listeners

  /** Subscribes to everything the viewer reports about clicks, drags and the cursor; returns the way to stop. */
  const attach = useCallback(
    (viewer: LidarViewer) => {
      const onClick = viewer.onPointClick((hit) => {
        const tool = clickToolRef.current;
        if (tool === "inspect") {
          applyPicks((current) => ({ ...current, inspected: hit === undefined ? undefined : describePoint(hit.cloud, hit.index) }), false);
          return;
        }
        const cloud = sourceRef.current;
        // A miss while measuring is most likely a slip, so it keeps what was measured.
        if (hit === undefined || cloud === undefined) return;
        setEntry(undefined);
        if (tool === "polygon") {
          addCorner(positionOf(hit));
          return;
        }
        if (tool === "area") {
          let cached = surfaceGridRef.current;
          if (cached === undefined || cached.positions !== cloud.positions) {
            cached = { positions: cloud.positions, grid: buildSurfaceGrid(cloud) };
            surfaceGridRef.current = cached;
          }
          const [x, , z] = positionOf(hit);
          const surface = selectSurface(cached.grid, x, z);
          if (surface === undefined) return;
          applyPicks((current) => ({ ...current, surfaces: [...current.surfaces, { id: nextId(current.surfaces), surface }] }));
          return;
        }
        // A click ends the ruler being laid, held to its axis if one is locked, or starts a new one beside those already there.
        const last = picksRef.current.rulers.at(-1);
        if (last !== undefined && last.to === undefined) {
          const heldTo = lockRef.current;
          const to = heldTo === undefined ? describePoint(hit.cloud, hit.index) : describeLocation(cloud, constrain(last.from.local, positionOf(hit), heldTo));
          applyPicks((current) => ({ ...current, rulers: [...current.rulers.slice(0, -1), { ...last, to }] }));
          // As in Blender, a lock lasts for the one placement.
          setLock(undefined);
          return;
        }
        // Numbered one past the highest on screen, so the numbers stay short and follow the order they were laid.
        applyPicks((current) => ({ ...current, rulers: [...current.rulers, { id: nextId(current.rulers), from: describePoint(hit.cloud, hit.index) }] }));
      });

      const onSecondary = viewer.onSecondaryClick(() => {
        if (clickToolRef.current === "polygon") finishPolygon();
      });

      const onHandleClick = viewer.onHandleClick((id) => {
        const handle = parseHandle(id);
        if (handle === undefined) return;
        if (handle.kind === "corner") {
          const polygon = picksRef.current.polygons.find((each) => each.id === handle.polygon);
          if (polygon === undefined) return;
          if (!polygon.closed) {
            // The first corner closes the outline; the last clicked again - a double click - finishes it.
            if (handle.index === 0 || handle.index === polygon.vertices.length - 1) finishPolygon();
            return;
          }
          setSelected(polygon.id);
        } else if (handle.kind === "midpoint") {
          insertCorner(handle.polygon, handle.index);
          setSelected(handle.polygon);
        } else if (handle.kind === "arrow") {
          setSelected(handle.polygon);
          entryTargetRef.current = handle.which;
        }
      });

      const onDragStart = viewer.onDragStart((id) => {
        const handle = parseHandle(id);
        if (handle === undefined) return;
        setEntry(undefined);
        if (handle.kind === "inspected") {
          dragRef.current = { id, start: picksRef.current };
          return;
        }
        recordStep();
        const start = picksRef.current;
        dragRef.current = { id, start };
        if (handle.kind === "midpoint") {
          insertCorner(handle.polygon, handle.index, false);
          dragRef.current.inserted = handle.index + 1;
        }
        if (handle.kind === "corner" || handle.kind === "midpoint" || handle.kind === "arrow") setSelected(handle.polygon);
        if (handle.kind === "arrow") {
          const polygon = start.polygons.find((each) => each.id === handle.polygon);
          if (polygon !== undefined) dragRef.current.value = handle.which === "height" ? polygon.height : baseLevel(polygon);
          entryTargetRef.current = handle.which;
        }
      });

      // A marker dragged across the scan moves the point it marks; the measurement follows it.
      const onMarkerDrag = viewer.onMarkerDrag((id, hit, done) => {
        const handle = parseHandle(id);
        const drag = dragRef.current;
        if (done && drag?.id === id) dragRef.current = undefined;
        if (handle === undefined) return;
        const at = positionOf(hit);
        if (handle.kind === "inspected") {
          applyPicks((current) => ({ ...current, inspected: describePoint(hit.cloud, hit.index) }), false);
        } else if (handle.kind === "ruler") {
          const details = describePoint(hit.cloud, hit.index);
          applyPicks(
            (current) => ({ ...current, rulers: current.rulers.map((each) => (each.id === handle.ruler ? { ...each, [handle.end]: details } : each)) }),
            false,
          );
        } else if (handle.kind === "corner" || handle.kind === "midpoint") {
          const index = handle.kind === "corner" ? handle.index : drag?.inserted;
          if (index === undefined) return;
          updatePolygon(handle.polygon, (polygon) => ({ ...polygon, vertices: polygon.vertices.map((vertex, corner) => (corner === index ? at : vertex)) }), false);
        }
      });

      const onAxisDrag = viewer.onAxisDrag((id, delta, modifiers: DragModifiers, phase: AxisDragPhase) => {
        const handle = parseHandle(id);
        const drag = dragRef.current;
        if (handle?.kind !== "arrow" || drag === undefined || drag.id !== id || drag.value === undefined) return;
        if (phase === "cancel") {
          // Put back as it was, and the undo step kept for the drag goes with it.
          historyRef.current.past.pop();
          setHistorySize({ undo: historyRef.current.past.length, redo: historyRef.current.future.length });
          picksRef.current = { ...drag.start, inspected: picksRef.current.inspected };
          setPicksState(picksRef.current);
          dragRef.current = undefined;
          return;
        }
        if (handle.which === "height") {
          const height = Math.max(0, snapTo(drag.value + delta, modifiers));
          updatePolygon(handle.polygon, (polygon) => ({ ...polygon, height }), false);
        } else {
          // A base snaps to round elevations of the scan, not of the viewer's local frame.
          const origin = sourceRef.current?.origin[1] ?? 0;
          const level = snapTo(origin + drag.value + delta, modifiers) - origin;
          updatePolygon(handle.polygon, (polygon) => ({ ...polygon, base: "custom", customBase: level }), false);
        }
        if (phase === "end") dragRef.current = undefined;
      });

      const onHover = viewer.onHover((hit, handle) => {
        hoverRef.current = { hit, handle };
        refreshPreview();
      });

      // Labels follow what they label as the camera moves, written straight to the elements each frame rather than through React.
      const onFrame = viewer.onFrame(() => {
        const layer = measureLabelRef.current;
        if (layer === null) return;
        for (const label of layer.children) {
          if (!(label instanceof HTMLElement) || label.dataset.anchor === undefined) continue;
          const spot = viewer.projectToCanvas(JSON.parse(label.dataset.anchor) as [number, number, number]);
          label.style.visibility = spot.visible ? "visible" : "hidden";
          // Above what it labels, or beside it where a gizmo's arrows stand above and below.
          const place =
            label.dataset.place === "right" ? "translate(16px, -50%)" : label.dataset.place === "left" ? "translate(calc(-100% - 16px), -50%)" : "translate(-50%, -140%)";
          label.style.transform = `translate(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px) ${place}`;
        }
      });

      return () => {
        onClick();
        onSecondary();
        onHandleClick();
        onDragStart();
        onMarkerDrag();
        onAxisDrag();
        onHover();
        onFrame();
      };
    },
    [addCorner, applyPicks, finishPolygon, insertCorner, recordStep, refreshPreview, setEntry, setLock, setSelected, updatePolygon],
  );

  // A point's class, height and object change when an analysis replaces the
  // cloud, so what was inspected is dropped; a measurement is only positions,
  // which no analysis moves, so it stays.
  useEffect(() => {
    applyPicks((current) => (current.inspected === undefined ? current : { ...current, inspected: undefined }), false);
  }, [source, applyPicks]);

  // ------------------------------------------------------------ keyboard

  const frameSelection = useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer === undefined) return false;
    const current = picksRef.current;
    const polygon = current.polygons.find((each) => each.id === selectedRef.current) ?? (clickToolRef.current === "polygon" ? current.polygons.at(-1) : undefined);
    const ruler = clickToolRef.current === "measure" ? current.rulers.at(-1) : undefined;
    const points: Vec3[] =
      polygon !== undefined
        ? polygon.vertices.flatMap((vertex) => [vertex, [vertex[0], vertex[1] + polygon.height, vertex[2]] as Vec3])
        : ruler !== undefined
          ? [ruler.from.local, ...(ruler.to === undefined ? [] : [ruler.to.local])]
          : current.inspected !== undefined
            ? [current.inspected.local]
            : [];
    if (points.length === 0) return false;
    const mean = (axis: 0 | 1 | 2) => points.reduce((sum, point) => sum + point[axis], 0) / points.length;
    const centre: Vec3 = [mean(0), mean(1), mean(2)];
    const radius = Math.max(2, ...points.map((point) => Math.hypot(point[0] - centre[0], point[1] - centre[1], point[2] - centre[2])));
    viewer.frame(centre, radius);
    return true;
  }, [viewerRef]);

  useEffect(() => {
    const applyEntry = (typed: ValueEntry) => {
      const value = Number(typed.text.replace(",", "."));
      setEntry(undefined);
      if (!Number.isFinite(value) || typed.text.trim() === "" || typed.text === "-") return;
      if (typed.target === "height") setPolygonHeight(typed.polygon, value);
      else setPolygonBaseElevation(typed.polygon, value);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const key = event.key;
      const lower = key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (lower === "z" || lower === "y")) {
        event.preventDefault();
        if (lower === "y" || event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const tool = clickToolRef.current;
      const current = picksRef.current;
      const draft = draftOf(current);
      const typed = entryRef.current;
      const selectedPolygon = current.polygons.find((polygon) => polygon.id === selectedRef.current && polygon.closed);

      // A number typed with a finished polygon selected sets its height, or its base after the base arrow was
      // dragged - SketchUp's measurements box. Enter applies it.
      if (tool === "polygon" && selectedPolygon !== undefined && draft === undefined && /^[0-9.,-]$/.test(key)) {
        event.preventDefault();
        setEntry({ polygon: selectedPolygon.id, target: typed?.target ?? entryTargetRef.current, text: (typed?.text ?? "") + key });
        return;
      }
      if (typed !== undefined) {
        if (key === "Enter") applyEntry(typed);
        else if (key === "Escape") setEntry(undefined);
        else if (key === "Backspace") setEntry(typed.text.length > 1 ? { ...typed, text: typed.text.slice(0, -1) } : undefined);
        else if (key === "Tab") setEntry({ ...typed, target: typed.target === "height" ? "base" : "height" });
        else return;
        event.preventDefault();
        return;
      }

      const chosen = toolKeys[lower];
      if (chosen !== undefined && !event.shiftKey) {
        setClickTool(chosen);
        return;
      }
      if (lower === "f") {
        if (!frameSelection()) viewerRef.current?.resetView();
        return;
      }

      const pending = current.rulers.at(-1)?.to === undefined ? current.rulers.at(-1) : undefined;
      if (tool === "measure" && (lower === "x" || lower === "y" || lower === "z")) {
        // Pressing the same lock again lets go, as in Blender.
        const next: AxisLock = event.shiftKey && lower === "z" ? "plane" : (lower as AxisLock);
        setLock(lockRef.current === next ? undefined : next);
        return;
      }

      if (key === "Enter" && draft !== undefined) {
        event.preventDefault();
        finishPolygon();
        return;
      }
      if (key === "Backspace" || key === "Delete") {
        const hovered = hoverRef.current.handle === undefined ? undefined : parseHandle(hoverRef.current.handle);
        if (draft !== undefined) removeCorner(draft.id, draft.vertices.length - 1);
        else if (hovered?.kind === "corner") removeCorner(hovered.polygon, hovered.index);
        else if (hovered?.kind === "ruler") applyPicks((all) => ({ ...all, rulers: all.rulers.filter((ruler) => ruler.id !== hovered.ruler) }));
        else if (tool === "polygon" && selectedPolygon !== undefined) removePolygon(selectedPolygon.id);
        else return;
        event.preventDefault();
        return;
      }
      if (key === "Escape") {
        // One step back at a time: the lock, then what is being drawn, then the selection, then the point inspected.
        if (lockRef.current !== undefined) setLock(undefined);
        else if (draft !== undefined) {
          applyPicks((all) => ({ ...all, polygons: all.polygons.filter((polygon) => polygon.id !== draft.id) }));
          setSelected(undefined);
        } else if (pending !== undefined) applyPicks((all) => ({ ...all, rulers: all.rulers.slice(0, -1) }), false);
        else if (selectedRef.current !== undefined) setSelected(undefined);
        else if (current.inspected !== undefined) applyPicks((all) => ({ ...all, inspected: undefined }), false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyPicks, finishPolygon, frameSelection, redo, removeCorner, removePolygon, setClickTool, setEntry, setLock, setPolygonBaseElevation, setPolygonHeight, setSelected, undo, viewerRef]);

  // --------------------------------------------------------- the results

  /** The figures last shown for each polygon, kept on screen while a large one is dragged. */
  const shownResultsRef = useRef(new Map<number, PolygonMeasurement>());
  const polygonResults = useMemo(() => {
    const results = new Map<number, PolygonMeasurement>();
    const cloud = source;
    if (cloud === undefined) return results;
    const closed = picks.polygons.filter((polygon) => polygon.closed);
    if (closed.length === 0) return results;
    const cached = volumeGrid(cloud);
    const dragging = dragRef.current !== undefined;
    for (const polygon of closed) {
      let result = cached.results.get(polygon);
      const shown = shownResultsRef.current.get(polygon.id);
      // Measuring takes time in proportion to the cells under a polygon: a
      // tenth of a second for one over most of a city scan. Dragged, such a
      // polygon keeps its last figures until it is let go, so the drag stays smooth.
      if (result === undefined && dragging && shown !== undefined && cellsUnder(polygon, cached.grid.cellSize) > largeDragCells) result = shown;
      if (result === undefined) {
        result = measurePolygon(cached.grid, shapeOf(polygon));
        cached.results.set(polygon, result);
      }
      results.set(polygon.id, result);
    }
    shownResultsRef.current = results;
    return results;
  }, [picks.polygons, source, volumeGrid]);

  // Surfaces that overlap or touch, grouped: each group can be merged into one surface.
  const surfaceGroups = useMemo(() => {
    const grid = surfaceGridRef.current?.grid;
    const surfaces = picks.surfaces;
    const parent = surfaces.map((_, index) => index);
    const root = (index: number): number => (parent[index] === index ? index : (parent[index] = root(parent[index]!)));
    if (grid !== undefined) {
      for (let a = 0; a < surfaces.length; a += 1) {
        for (let b = a + 1; b < surfaces.length; b += 1) {
          if (root(a) !== root(b) && surfacesTouch(grid, surfaces[a]!.surface.cells, surfaces[b]!.surface.cells)) parent[root(b)] = root(a);
        }
      }
    }
    const groups = new Map<number, number[]>();
    surfaces.forEach((_, index) => groups.set(root(index), [...(groups.get(root(index)) ?? []), index]));
    return [...groups.values()];
  }, [picks.surfaces]);
  const mergeableSurfaces = surfaceGroups.filter((group) => group.length > 1).reduce((sum, group) => sum + group.length, 0);
  const totalSurfaceArea = useMemo(() => {
    const grid = surfaceGridRef.current?.grid;
    const parts = picks.surfaces.map((each) => each.surface);
    return grid === undefined ? parts.reduce((sum, part) => sum + part.planArea, 0) : combinedPlanArea(grid, parts);
  }, [picks.surfaces]);
  const mergeTouchingSurfaces = useCallback(() => {
    const grid = surfaceGridRef.current?.grid;
    if (grid === undefined) return;
    applyPicks((current) => {
      const merged = surfaceGroups.map((group) => {
        const members = group.map((index) => current.surfaces[index]).filter((each) => each !== undefined);
        if (members.length === 1) return members[0]!;
        // A merged surface keeps the lowest of its parts' numbers.
        return { id: Math.min(...members.map((each) => each.id)), surface: mergeSurfaces(grid, members.map((each) => each.surface)) };
      });
      return { ...current, surfaces: merged.sort((a, b) => a.id - b.id) };
    });
  }, [applyPicks, surfaceGroups]);

  // ------------------------------------------------------------ drawing

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer === undefined) return;
    const markers: MarkerAnnotation[] = [];
    const lines: Array<{ style: LineStyle; positions: Float32Array }> = [];
    const fills: Array<{ style: FillStyle; positions: Float32Array }> = [];
    const arrows: ArrowAnnotation[] = [];
    const draggable: DraggableMarker[] = [];
    const measuring = clickTool === "measure";
    const drawingPolygons = clickTool === "polygon";

    if (clickTool === "inspect" && picks.inspected !== undefined) {
      markers.push({ position: picks.inspected.local, tone: "inspect", id: "inspected" });
      draggable.push({ id: "inspected", position: picks.inspected.local });
    }
    // Every measurement stays on the scan whichever tool is in hand; only the tool's own can be picked up.
    for (const ruler of picks.rulers) {
      const ends = [["from", ruler.from] as const, ...(ruler.to === undefined ? [] : [["to", ruler.to] as const])];
      for (const [end, point] of ends) {
        const id = `ruler:${ruler.id}:${end}`;
        markers.push({ position: point.local, tone: end, id });
        if (measuring) draggable.push({ id, position: point.local });
      }
    }
    for (const polygon of picks.polygons) {
      const isSelected = drawingPolygons && polygon.id === selected;
      const drawing = polygonDrawing(shapeOf(polygon), polygon.closed);
      lines.push({ style: isSelected ? "polygonSelected" : "polygon", positions: drawing.outline });
      lines.push({ style: "guide", positions: drawing.drops });
      lines.push({ style: "prism", positions: drawing.prismEdges });
      fills.push({ style: isSelected ? "baseSelected" : "base", positions: drawing.base });
      fills.push({ style: "prism", positions: drawing.prismFaces });
      if (!drawingPolygons) continue;
      polygon.vertices.forEach((vertex, index) => {
        const id = `poly:${polygon.id}:v:${index}`;
        markers.push({ position: vertex, tone: isSelected ? "vertexSelected" : "vertex", id });
        draggable.push({ id, position: vertex });
      });
      if (!isSelected || !polygon.closed) continue;
      polygon.vertices.forEach((vertex, index) => {
        const next = polygon.vertices[(index + 1) % polygon.vertices.length]!;
        const id = `poly:${polygon.id}:m:${index}`;
        const middle: Vec3 = [(vertex[0] + next[0]) / 2, (vertex[1] + next[1]) / 2, (vertex[2] + next[2]) / 2];
        markers.push({ position: middle, tone: "midpoint", id });
        draggable.push({ id, position: middle });
      });
      const anchor = polygonAnchor(shapeOf(polygon));
      if (anchor !== undefined) {
        const base = baseLevel(polygon);
        arrows.push({ id: `poly:${polygon.id}:height`, anchor: [anchor[0], base + polygon.height, anchor[2]], direction: 1, tone: "extrude" });
        arrows.push({ id: `poly:${polygon.id}:base`, anchor: [anchor[0], base, anchor[2]], direction: -1, tone: "base" });
      }
    }
    viewer.setAnnotations({
      markers,
      measurements: picks.rulers.flatMap((ruler) => (ruler.to === undefined ? [] : [{ from: ruler.from.local, to: ruler.to.local }])),
      surfaces: picks.surfaces.map((each) => each.surface.outline),
      lines,
      fills,
      arrows,
    });
    viewer.setDraggableMarkers(draggable);
    viewer.setAxisHandles(arrows.map((arrow): AxisHandle => ({ id: arrow.id, anchor: arrow.anchor, direction: arrow.direction })));
    viewer.setHoverPicking(source !== undefined);
  }, [clickTool, picks, selected, source, viewerRef]);

  return {
    clickTool,
    setClickTool,
    picks,
    selectedPolygon: selected,
    selectPolygon: setSelected,
    polygonResults,
    lock,
    entry,
    measureLabelRef,
    previewLabelRef,
    canUndo: historySize.undo > 0,
    canRedo: historySize.redo > 0,
    undo,
    redo,
    attach,
    reset,
    clearInspected: () => applyPicks((current) => ({ ...current, inspected: undefined }), false),
    removeRuler: (id: number) => applyPicks((current) => ({ ...current, rulers: current.rulers.filter((ruler) => ruler.id !== id) })),
    clearRulers: () => applyPicks((current) => ({ ...current, rulers: [] })),
    removeSurface: (id: number) => applyPicks((current) => ({ ...current, surfaces: current.surfaces.filter((each) => each.id !== id) })),
    clearSurfaces: () => applyPicks((current) => ({ ...current, surfaces: [] })),
    mergeableSurfaces,
    mergeTouchingSurfaces,
    totalSurfaceArea,
    finishPolygon,
    removePolygon,
    clearPolygons: () => {
      applyPicks((current) => ({ ...current, polygons: [] }));
      setSelected(undefined);
      setEntry(undefined);
    },
    setPolygonBase,
    setPolygonBaseElevation,
    setPolygonHeight,
    baseLevel,
  };
}

export type Measurements = ReturnType<typeof useMeasurements>;
