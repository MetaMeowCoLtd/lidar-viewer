import { Matrix4, PerspectiveCamera, Scene, Vector2, Vector3, WebGLRenderer } from "three";
import { NavigationControls } from "./navigation-controls.js";
import type { PointCloud, PointCloudColorMode, PointCloudPointShape, PointSizeMode } from "../core/point-cloud.js";
import { PointCloudLodPyramid, type LodTierSpec } from "../core/lod-pyramid.js";
import { PointCloudSession } from "../core/point-cloud-session.js";
import { TiledPointCloudLodPyramid, distanceToBounds } from "../core/tiled-lod-pyramid.js";
import { LodBuildPool } from "../core/lod-build-pool.js";
import { ThreePointCloudRenderer } from "./three-point-cloud-renderer.js";
import { viewerConfig } from "../config.js";
import type { DetectedObject } from "../core/object-detection.js";
import { pickPoint, type PointHit } from "../core/point-picking.js";
import type { NoiseDisplay } from "./point-cloud-shader-material.js";
import { isNoiseClass } from "../core/noise-detection.js";
import { arrowLength, arrowPixels, type Annotations } from "./measurement-overlay.js";
import type { TerrainModel } from "../core/terrain.js";
import type { ContourSet } from "../core/contours.js";

export type { LodRenderSummary, LodTierUsage } from "./three-point-cloud-renderer.js";
export { lodTierColors } from "./three-point-cloud-renderer.js";
export type { Annotations, ArrowAnnotation, FillStyle, LineStyle, MarkerAnnotation, MarkerTone } from "./measurement-overlay.js";
import type { LodRenderSummary } from "./three-point-cloud-renderer.js";

/** How far, in CSS pixels, a press may travel and still count as a click. */
const clickSlop = 5;
/** How long, in milliseconds, a press may last and still count as a click. */
const clickDuration = 600;
/** How far from the cursor, in CSS pixels, a click in a gap between dots still finds a point. */
const pickTolerance = 8;
/** The same for aiming the camera, which is happy with a point a little further off. */
const pivotTolerance = 14;
/** How close, in CSS pixels, a press must land to a marker to grab it rather than move the camera. */
const handleRadius = 13;
/** How close, in CSS pixels, a press must land to a gizmo arrow to grab it. */
const arrowReach = 9;
/** Below this angle between the view and the vertical, an arrow is dragged by the cursor's height on screen instead. */
const minArrowAngle = Math.sin((12 * Math.PI) / 180);

/** A marker the user can drag to another spot on the scan. */
export interface DraggableMarker {
  readonly id: string;
  readonly position: readonly [number, number, number];
}

/** A gizmo arrow the user can drag straight up or down. */
export interface AxisHandle {
  readonly id: string;
  readonly anchor: readonly [number, number, number];
  readonly direction: 1 | -1;
}

/** Keys held while dragging an arrow: Ctrl snaps to whole steps, Shift moves finely, as in Blender. */
export interface DragModifiers {
  readonly snap: boolean;
  readonly fine: boolean;
}

export type AxisDragPhase = "move" | "end" | "cancel";

export interface LidarViewerOptions {
  readonly pointBudget?: number;
  readonly pointSize?: number;
  readonly clearColor?: number;
  readonly pixelRatio?: number;
  /**
   * When true, the active LOD tier is chosen every frame from each tile's
   * distance to the orbit target instead of the manual point budget. Off by
   * default so existing integrations keep their current behavior.
   */
  readonly distanceBasedLod?: boolean;
  /** How far from the scan the camera starts, in multiples of its diagonal. Defaults to the configured framing distance. */
  readonly framingDistance?: number;
}

/**
 * Browser composition root for the renderer. It owns the only animation loop,
 * camera controls, and GPU lifecycle, while keeping UI framework state outside
 * the Three.js scene graph. The loaded cloud is partitioned into spatial
 * tiles (see {@link TiledPointCloudLodPyramid}) so LOD can be resolved per
 * region instead of switching the whole cloud's detail level at once.
 */
export class LidarViewer {
  public readonly scene = new Scene();
  public readonly camera = new PerspectiveCamera(viewerConfig().camera.fieldOfView, 1, 0.05, 10_000);
  public readonly session = new PointCloudSession();

  private readonly renderer: WebGLRenderer;
  private readonly controls: NavigationControls;
  private readonly pointCloudRenderer: ThreePointCloudRenderer;
  private activePyramid: PointCloudLodPyramid | undefined;
  private activeTiledPyramid: TiledPointCloudLodPyramid | undefined;
  private lastSpecs: readonly LodTierSpec[] = [];
  private pointBudget: number;
  private pointSize: number;
  private colorMode: PointCloudColorMode = "height";
  private pointShape: PointCloudPointShape = viewerConfig().pointShape;
  private frameHandle: number | undefined;
  private disposed = false;
  private distanceBasedLodEnabled: boolean;
  /** In distance mode, the widest gap between points on screen, in CSS pixels, before a tile draws finer detail. */
  private lodGapPixels = viewerConfig().distanceLod.maxGapPixels.default;
  private lastSummary: LodRenderSummary | undefined;
  private readonly summaryListeners = new Set<(summary: LodRenderSummary) => void>();
  private buildPool: LodBuildPool | undefined;
  /** Set by {@link LidarViewer.replaceCloud}, so the next ready cloud keeps the current view. */
  private keepCameraOnNextReady = false;
  private readonly clickListeners = new Set<(hit: PointHit | undefined) => void>();
  private readonly frameListeners = new Set<() => void>();
  private pointsVisible = true;
  private readonly framingDistance: number | undefined;
  private pressed: { x: number; y: number; time: number; pointerId: number; button: number } | undefined;
  private draggableMarkers: readonly DraggableMarker[] = [];
  private readonly markerDragListeners = new Set<(id: string, hit: PointHit, done: boolean) => void>();
  private markerDrag:
    | { id: string; pointerId: number; x: number; y: number; pending: boolean; startX: number; startY: number; moved: boolean; last?: PointHit }
    | undefined;
  private axisHandles: readonly AxisHandle[] = [];
  private readonly axisDragListeners = new Set<(id: string, delta: number, modifiers: DragModifiers, phase: AxisDragPhase) => void>();
  private axisDrag:
    | {
        id: string;
        pointerId: number;
        anchor: readonly [number, number, number];
        lastT: number | undefined;
        lastY: number;
        delta: number;
        startX: number;
        startY: number;
        moved: boolean;
      }
    | undefined;
  private readonly handleClickListeners = new Set<(id: string) => void>();
  private readonly dragStartListeners = new Set<(id: string) => void>();
  private readonly secondaryClickListeners = new Set<() => void>();
  private readonly hoverListeners = new Set<(hit: PointHit | undefined, handle: string | undefined) => void>();
  /** Where the cursor rests over the scan, waiting for the next frame to find the point under it. */
  private hover: { x: number; y: number; pending: boolean } | undefined;
  private hoverPicking = false;
  private hoveredHandle: string | undefined;
  /** How long the last hover search took, and when it ran: a slow one is repeated less often. */
  private hoverCost = 0;
  private lastHoverPick = 0;
  /**
   * A press on a marker starts dragging it instead of moving the camera: the
   * press is caught before the navigation controls see it. Anywhere else, the
   * press goes on to them untouched.
   */
  private readonly onHandlePointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
    const handle = this.handleAt(event.clientX, event.clientY);
    if (handle === undefined) return;
    event.stopImmediatePropagation();
    // Also keeps the browser from firing the mousedown the controls listen for.
    event.preventDefault();
    this.pressed = undefined;
    this.clearHover();
    const start = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    const axis = handle.kind === "axis" ? this.axisHandles.find((each) => each.id === handle.id) : undefined;
    if (axis !== undefined) {
      const lastT = this.axisParameter(axis.anchor, event.clientX, event.clientY);
      this.axisDrag = { id: handle.id, anchor: axis.anchor, lastT, lastY: event.clientY, delta: 0, ...start };
    } else {
      this.markerDrag = { id: handle.id, x: event.clientX, y: event.clientY, pending: false, ...start };
    }
    this.setHighlight(handle.id);
    // Keeps the drag when the cursor leaves the canvas; a pointer the browser no longer tracks cannot be captured.
    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // The drag still works while the cursor stays over the scan.
    }
    this.renderer.domElement.style.cursor = "grabbing";
  };
  private readonly onHandlePointerMove = (event: PointerEvent) => {
    const axis = this.axisDrag;
    if (axis !== undefined) {
      if (event.pointerId !== axis.pointerId) return;
      event.stopImmediatePropagation();
      if (!axis.moved && Math.hypot(event.clientX - axis.startX, event.clientY - axis.startY) <= clickSlop) return;
      if (!axis.moved) {
        axis.moved = true;
        for (const listener of this.dragStartListeners) listener(axis.id);
      }
      // The point on the arrow's line nearest the cursor's ray keeps the arrow under the cursor, as a DCC gizmo
      // does. Seen end-on, from straight above, the line says nothing, and the cursor's height on screen moves it.
      const t = this.axisParameter(axis.anchor, event.clientX, event.clientY);
      let step = t !== undefined && axis.lastT !== undefined ? t - axis.lastT : -(event.clientY - axis.lastY) * this.worldPerPixel(axis.anchor);
      if (event.shiftKey) step *= 0.1;
      axis.delta += step;
      axis.lastT = t;
      axis.lastY = event.clientY;
      for (const listener of this.axisDragListeners) listener(axis.id, axis.delta, { snap: event.ctrlKey || event.metaKey, fine: event.shiftKey }, "move");
      return;
    }
    const drag = this.markerDrag;
    if (drag === undefined) {
      if (event.buttons !== 0) return;
      // Only hovering: say that the handle under the cursor can be picked up, or find the point a click would take.
      const handle = this.handleAt(event.clientX, event.clientY)?.id;
      const style = this.renderer.domElement.style;
      if (handle !== undefined) style.cursor = "grab";
      else if (style.cursor === "grab") style.cursor = "";
      this.setHighlight(handle);
      if (handle !== undefined) {
        if (this.hover !== undefined || this.hoveredHandle !== handle) {
          this.hover = undefined;
          this.hoveredHandle = handle;
          for (const listener of this.hoverListeners) listener(undefined, handle);
        }
        return;
      }
      this.hoveredHandle = undefined;
      if (this.hoverPicking) this.hover = { x: event.clientX, y: event.clientY, pending: true };
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    event.stopImmediatePropagation();
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= clickSlop) return;
    if (!drag.moved) {
      drag.moved = true;
      for (const listener of this.dragStartListeners) listener(drag.id);
    }
    // Snapping searches the scan, so it runs once per frame on the latest position rather than on every move.
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.pending = true;
  };
  private readonly onHandlePointerUp = (event: PointerEvent) => {
    const axis = this.axisDrag;
    const drag = this.markerDrag;
    const active = axis ?? drag;
    if (active === undefined || event.pointerId !== active.pointerId) return;
    event.stopImmediatePropagation();
    this.axisDrag = undefined;
    this.markerDrag = undefined;
    this.renderer.domElement.style.cursor = "";
    this.setHighlight(undefined);
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
    // A press that never moved is a click on the handle: it selects it, or on a polygon's first corner, closes it.
    if (!active.moved) {
      if (event.type === "pointerup") for (const listener of this.handleClickListeners) listener(active.id);
      return;
    }
    if (axis !== undefined) {
      const modifiers = { snap: event.ctrlKey || event.metaKey, fine: event.shiftKey };
      for (const listener of this.axisDragListeners) listener(axis.id, axis.delta, modifiers, event.type === "pointerup" ? "end" : "cancel");
      return;
    }
    // Let go over empty space, the marker stays where it last found the scan.
    const hit = this.pickAt(event.clientX, event.clientY) ?? drag?.last;
    if (hit !== undefined && drag !== undefined) for (const listener of this.markerDragListeners) listener(drag.id, hit, true);
  };
  /** Escape while an arrow is dragged puts it back where the drag began, as it cancels a transform in Blender. */
  private readonly onKeyDown = (event: KeyboardEvent) => {
    const axis = this.axisDrag;
    if (event.key !== "Escape" || axis === undefined) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    this.axisDrag = undefined;
    this.setHighlight(undefined);
    this.renderer.domElement.style.cursor = "";
    if (this.renderer.domElement.hasPointerCapture(axis.pointerId)) this.renderer.domElement.releasePointerCapture(axis.pointerId);
    if (axis.moved) for (const listener of this.axisDragListeners) listener(axis.id, 0, { snap: false, fine: false }, "cancel");
  };
  private readonly onPointerLeave = () => {
    if (this.markerDrag === undefined && this.axisDrag === undefined) this.clearHover();
  };
  private readonly onPointerDown = (event: PointerEvent) => {
    const tracked = event.isPrimary && (event.button === 0 || event.button === 2);
    this.pressed = tracked ? { x: event.clientX, y: event.clientY, time: event.timeStamp, pointerId: event.pointerId, button: event.button } : undefined;
    this.clearHover();
  };
  /**
   * A press and release close together in place and time is a click; anything
   * else was the user orbiting or panning, and must not pick a point.
   */
  private readonly onPointerUp = (event: PointerEvent) => {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (pressed === undefined || pressed.pointerId !== event.pointerId) return;
    // The controls count the travel too: a drag under the pointer lock ends where it began on screen.
    const moved = Math.max(Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y), this.controls.dragDistance);
    if (moved > clickSlop || event.timeStamp - pressed.time > clickDuration) return;
    // A right click that did not turn into a look around finishes what is being drawn, as in survey software.
    if (pressed.button === 2) {
      for (const listener of this.secondaryClickListeners) listener();
      return;
    }
    if (this.clickListeners.size === 0) return;
    const hit = this.pickAt(event.clientX, event.clientY);
    for (const listener of this.clickListeners) listener(hit);
  };

  public constructor(canvas: HTMLCanvasElement, options: LidarViewerOptions = {}) {
    this.pointBudget = options.pointBudget ?? 500_000;
    this.pointSize = options.pointSize ?? 2.4;
    this.distanceBasedLodEnabled = options.distanceBasedLod ?? false;
    this.framingDistance = options.framingDistance;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(options.clearColor ?? 0x07111f, 0);
    this.renderer.setPixelRatio(options.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    this.controls = new NavigationControls(this.camera, canvas, (clientX, clientY) => this.pivotAt(clientX, clientY));
    this.pointCloudRenderer = new ThreePointCloudRenderer(this.scene, this.renderer, this.camera);
    // Registered before the controls' own listeners and in the capture phase, so a press on a marker never reaches them.
    canvas.addEventListener("pointerdown", this.onHandlePointerDown, { capture: true });
    canvas.addEventListener("pointermove", this.onHandlePointerMove, { capture: true });
    canvas.addEventListener("pointerup", this.onHandlePointerUp, { capture: true });
    canvas.addEventListener("pointercancel", this.onHandlePointerUp, { capture: true });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    // Captured on the window, so an Escape that cancels a drag goes no further.
    window.addEventListener("keydown", this.onKeyDown, { capture: true });

    this.session.subscribe((state) => {
      if (state.status !== "ready" || this.disposed || state.tiled === undefined) return;
      this.activePyramid = state.pyramid;
      const source = state.pyramid.tiers[0]!.cloud;
      this.activeTiledPyramid = state.tiled;
      this.pointCloudRenderer.setTiledPyramid(source, this.activeTiledPyramid);
      if (this.keepCameraOnNextReady) this.keepCameraOnNextReady = false;
      else this.frameActiveCloud();
      this.applyLodForCurrentMode();
      this.pointCloudRenderer.setPointSize(this.pointSize);
      this.pointCloudRenderer.setColorMode(this.colorMode);
      this.pointCloudRenderer.setPointShape(this.pointShape);
    });
  }

  /**
   * Shows a new scan. `onProgress` hears how far building its detail levels
   * has got, from zero to one, for a load that takes long enough to report.
   */
  public async load(
    source: PointCloud | Promise<PointCloud>,
    specs: readonly LodTierSpec[],
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    this.assertNotDisposed();
    this.keepCameraOnNextReady = false;
    await this.build(source, specs, onProgress);
  }

  /**
   * Swaps in a new version of the scan already on screen - the same points
   * with channels an analysis has added - and rebuilds its detail levels with
   * the same tiers, leaving the camera where the user put it. Reframing would
   * throw away the view the user was studying at the moment the answer arrives.
   */
  public async replaceCloud(cloud: PointCloud): Promise<void> {
    this.assertNotDisposed();
    if (this.lastSpecs.length === 0) throw new Error("replaceCloud needs a cloud to have been loaded first");
    this.keepCameraOnNextReady = true;
    await this.build(cloud, this.lastSpecs);
  }

  private async build(
    source: PointCloud | Promise<PointCloud>,
    specs: readonly LodTierSpec[],
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    this.lastSpecs = specs;
    const tiling = viewerConfig().tiling;
    this.buildPool ??= new LodBuildPool(Math.min(navigator.hardwareConcurrency || 4, tiling.buildWorkers));
    const pool = this.buildPool;
    await this.session.load(source, specs.filter((spec) => spec.voxelSize === 0 && spec.pointFraction === undefined), (cloud) =>
      TiledPointCloudLodPyramid.buildWithPool(cloud, specs, tiling, pool, onProgress),
    );
  }

  public setPointBudget(pointBudget: number): void {
    this.assertNotDisposed();
    this.pointBudget = pointBudget;
    // By distance, the budget caps what refinement may spend; the next frame applies it.
    if (this.activeTiledPyramid !== undefined && !this.distanceBasedLodEnabled) {
      this.pointCloudRenderer.applyPointBudget(pointBudget, this.activeTiledPyramid);
      this.notifySummary();
    }
  }

  /** Toggles automatic, camera-distance-driven LOD selection on or off. */
  public setDistanceBasedLodEnabled(enabled: boolean): void {
    this.assertNotDisposed();
    if (this.distanceBasedLodEnabled === enabled) return;
    this.distanceBasedLodEnabled = enabled;
    if (this.activeTiledPyramid !== undefined) this.applyLodForCurrentMode();
  }

  /**
   * How much detail distance mode draws: each tile shows the leanest tier
   * whose points sit no more than this many CSS pixels apart on screen.
   * Smaller is sharper and heavier.
   */
  public setLodGapPixels(pixels: number): void {
    this.assertNotDisposed();
    if (!(pixels > 0)) throw new Error("the gap must be positive");
    this.lodGapPixels = pixels;
    if (this.activeTiledPyramid !== undefined && this.distanceBasedLodEnabled) this.applyLodForCurrentMode();
  }

  public isDistanceBasedLodEnabled(): boolean {
    return this.distanceBasedLodEnabled;
  }

  /** Notified whenever the rendered tiers change, from either selection mode. */
  public onLodSummaryChange(listener: (summary: LodRenderSummary) => void): () => void {
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  }

  public setPointSize(pointSize: number): void {
    this.assertNotDisposed();
    this.pointSize = pointSize;
    this.pointCloudRenderer.setPointSize(pointSize);
  }

  /** Dots sized by the spacing of their points in the world, or the same pixels at any distance. */
  public setPointSizeMode(mode: PointSizeMode): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setPointSizeMode(mode);
  }

  /** Tints each tile by the detail level it draws and outlines it, to see how detail is spread. */
  public setLodDebug(enabled: boolean): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setLodDebug(enabled);
  }

  public setPointShape(shape: PointCloudPointShape): void {
    this.assertNotDisposed();
    this.pointShape = shape;
    this.pointCloudRenderer.setPointShape(shape);
  }

  /** Outlines and per-object colours for detected buildings and trees; undefined clears them. */
  public setObjects(objects: readonly DetectedObject[] | undefined): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setObjects(objects);
  }

  /** The terrain surface and its contour lines; undefined clears them. */
  public setTerrain(model: TerrainModel | undefined, contours: ContourSet | undefined): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setTerrain(model, contours);
  }

  public setTerrainVisibility(surface: boolean, contours: boolean): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setTerrainVisibility(surface, contours);
  }

  public setPointsVisible(visible: boolean): void {
    this.assertNotDisposed();
    this.pointsVisible = visible;
    this.pointCloudRenderer.setPointsVisible(visible);
  }

  public setOutlineVisibility(buildings: boolean, trees: boolean): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setOutlineVisibility(buildings, trees);
  }

  /**
   * The scan point drawn under a position in the page, if any. Points come from
   * each tile's full-resolution tier whatever detail is on screen, so the
   * answer is always a real measured point rather than a decimated average.
   */
  public pickAt(clientX: number, clientY: number): PointHit | undefined {
    this.assertNotDisposed();
    const tiled = this.activeTiledPyramid;
    // Hidden points are not there to be clicked on.
    if (tiled === undefined || !this.pointsVisible) return undefined;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const scale = size.x / rect.width;
    this.camera.updateMatrixWorld();
    const viewProjection = new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    return pickPoint(
      tiled.tiles.map((tile) => tile.pyramid.tiers[0]!.cloud),
      {
        viewProjection: viewProjection.elements,
        width: size.x,
        height: size.y,
        cursorX: (clientX - rect.left) * scale,
        cursorY: (clientY - rect.top) * scale,
        dotRadius: (depth, cloud) => this.pointCloudRenderer.dotRadius(depth, cloud),
        maxDotRadius: this.pointCloudRenderer.maxDotRadius(),
        tolerance: pickTolerance * this.renderer.getPixelRatio(),
        skip: this.hiddenPoint(),
      },
    );
  }

  /**
   * Where the scan is under a position in the page, for the camera to turn,
   * zoom and pan around. Only the points on screen are searched - the detail
   * each tile is drawing - which is plenty to aim the camera by and keeps a
   * press or a wheel notch cheap however big the scan is.
   */
  private pivotAt(clientX: number, clientY: number): Vector3 | undefined {
    const hit = this.pickDrawn(clientX, clientY, pivotTolerance);
    if (hit === undefined) return undefined;
    const offset = hit.index * 3;
    return new Vector3(hit.cloud.positions[offset], hit.cloud.positions[offset + 1], hit.cloud.positions[offset + 2]);
  }

  /**
   * The drawn point under a position in the page, searching only the detail on
   * screen: an order of magnitude cheaper than {@link LidarViewer.pickAt} on a
   * large scan seen whole, which is what lets the cursor and the camera ask
   * every frame. On a thinned tile the point found is an average of the ones
   * it stands for, so what is measured still comes from `pickAt`.
   */
  private pickDrawn(clientX: number, clientY: number, tolerance: number): PointHit | undefined {
    if (this.activeTiledPyramid === undefined || !this.pointsVisible) return undefined;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const scale = size.x / rect.width;
    this.camera.updateMatrixWorld();
    const viewProjection = new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    return pickPoint(this.pointCloudRenderer.drawnClouds(), {
      viewProjection: viewProjection.elements,
      width: size.x,
      height: size.y,
      cursorX: (clientX - rect.left) * scale,
      cursorY: (clientY - rect.top) * scale,
      dotRadius: (depth, cloud) => this.pointCloudRenderer.dotRadius(depth, cloud),
      maxDotRadius: this.pointCloudRenderer.maxDotRadius(),
      tolerance: tolerance * this.renderer.getPixelRatio(),
      skip: this.hiddenPoint(),
    });
  }

  /** Hidden noise and flight lines are not on screen, so a click must go through them to what is. */
  private hiddenPoint(): ((cloud: PointCloud, index: number) => boolean) | undefined {
    const noiseHidden = this.pointCloudRenderer.getNoiseDisplay() === "hidden";
    const lines = this.pointCloudRenderer.getHiddenFlightLines();
    if (!noiseHidden && lines === undefined) return undefined;
    return (cloud, index) => {
      const code = cloud.classification?.[index];
      if (noiseHidden && code !== undefined && isNoiseClass(code)) return true;
      const line = cloud.pointSourceId?.[index];
      return lines !== undefined && line !== undefined && lines.has(line);
    };
  }

  /** Leaves these flight lines out while the scan is coloured by flight line. */
  public setHiddenFlightLines(hidden: ReadonlySet<number>): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setHiddenFlightLines(hidden);
  }

  /** Shows, hides or highlights the points labelled as noise. */
  public setNoiseDisplay(display: NoiseDisplay): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setNoiseDisplay(display);
  }

  /** Notified with the picked point, or undefined for a click on empty space. Drags never notify. */
  public onPointClick(listener: (hit: PointHit | undefined) => void): () => void {
    this.clickListeners.add(listener);
    return () => this.clickListeners.delete(listener);
  }

  /**
   * Markers the user may pick up and drag. While dragged, each follows the
   * scan's surface under the cursor as drawn, which is cheap enough to ask every
   * frame; where it is let go it snaps to the nearest real point, so a
   * measurement always runs between measured points. Listeners hear every new
   * spot, the last with `done` set.
   */
  public setDraggableMarkers(markers: readonly DraggableMarker[]): void {
    this.draggableMarkers = markers;
  }

  public onMarkerDrag(listener: (id: string, hit: PointHit, done: boolean) => void): () => void {
    this.markerDragListeners.add(listener);
    return () => this.markerDragListeners.delete(listener);
  }

  /**
   * Gizmo arrows the user may drag straight up or down. Listeners hear how far
   * the drag has moved from where it began, in local units along the vertical,
   * with the keys held; the last with "end", or "cancel" when Escape put it back.
   */
  public setAxisHandles(handles: readonly AxisHandle[]): void {
    this.axisHandles = handles;
  }

  public onAxisDrag(listener: (id: string, delta: number, modifiers: DragModifiers, phase: AxisDragPhase) => void): () => void {
    this.axisDragListeners.add(listener);
    return () => this.axisDragListeners.delete(listener);
  }

  /** Notified when a marker or an arrow is pressed and released without moving. */
  public onHandleClick(listener: (id: string) => void): () => void {
    this.handleClickListeners.add(listener);
    return () => this.handleClickListeners.delete(listener);
  }

  /** Notified once when a marker or an arrow starts moving, before its first move - for keeping an undo step. */
  public onDragStart(listener: (id: string) => void): () => void {
    this.dragStartListeners.add(listener);
    return () => this.dragStartListeners.delete(listener);
  }

  /** Notified of a right click that did not become a look around. */
  public onSecondaryClick(listener: () => void): () => void {
    this.secondaryClickListeners.add(listener);
    return () => this.secondaryClickListeners.delete(listener);
  }

  /**
   * While on, the point under the resting cursor is found once a frame and
   * listeners hear it - or the handle the cursor is over instead - so a tool
   * can show where a click would land before it is made.
   */
  public setHoverPicking(enabled: boolean): void {
    this.hoverPicking = enabled;
    if (!enabled) this.hover = undefined;
  }

  public onHover(listener: (hit: PointHit | undefined, handle: string | undefined) => void): () => void {
    this.hoverListeners.add(listener);
    return () => this.hoverListeners.delete(listener);
  }

  /** Flies the camera to look at a sphere from the direction it looks now, near enough for it to fill most of the view. */
  public frame(center: readonly [number, number, number], radius: number): void {
    this.assertNotDisposed();
    this.controls.flyToFit(new Vector3(...center), radius);
  }

  private setHighlight(id: string | undefined): void {
    this.pointCloudRenderer.setAnnotationHighlight(id);
  }

  private clearHover(): void {
    const had = this.hover !== undefined || this.hoveredHandle !== undefined;
    this.hover = undefined;
    this.hoveredHandle = undefined;
    if (this.markerDrag === undefined && this.axisDrag === undefined) this.setHighlight(undefined);
    if (had) for (const listener of this.hoverListeners) listener(undefined, undefined);
  }

  /**
   * Finds the point under the resting cursor among those drawn, at most once a
   * frame and less often when each search is slow. It is a preview of where a
   * click would land; the click itself snaps to the full-resolution point.
   */
  private pickHover(now: number): void {
    const hover = this.hover;
    if (hover === undefined || !hover.pending || !this.hoverPicking) return;
    if (now - this.lastHoverPick < Math.min(160, this.hoverCost * 3)) return;
    hover.pending = false;
    const started = performance.now();
    this.lastHoverPick = now;
    const hit = this.pickDrawn(hover.x, hover.y, pickTolerance);
    this.hoverCost = performance.now() - started;
    for (const listener of this.hoverListeners) listener(hit, undefined);
  }

  /** What is under the cursor to grab: the nearest marker or arrow within reach. */
  private handleAt(clientX: number, clientY: number): { id: string; kind: "marker" | "axis" } | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: { id: string; kind: "marker" | "axis" } | undefined;
    let bestDistance = Infinity;
    for (const marker of this.draggableMarkers) {
      const spot = this.projectToCanvas(marker.position);
      if (!spot.visible) continue;
      const distance = Math.hypot(x - spot.x, y - spot.y);
      if (distance <= handleRadius && distance < bestDistance) {
        bestDistance = distance;
        best = { id: marker.id, kind: "marker" };
      }
    }
    for (const handle of this.axisHandles) {
      const length = arrowLength(this.camera, handle.anchor, rect.height);
      const a = this.projectToCanvas(handle.anchor);
      const b = this.projectToCanvas([handle.anchor[0], handle.anchor[1] + length * handle.direction, handle.anchor[2]]);
      if (!a.visible || !b.visible) continue;
      // An arrow counts as a little further off than it is, so a corner under it can still be grabbed.
      const distance = distanceToSegment(x, y, a, b) + 3;
      if (distance <= arrowReach + 3 && distance < bestDistance) {
        bestDistance = distance;
        best = { id: handle.id, kind: "axis" };
      }
    }
    return best;
  }

  /** Where on the vertical line through `anchor` the cursor's ray passes closest, or undefined when the view looks along it. */
  private axisParameter(anchor: readonly [number, number, number], clientX: number, clientY: number): number | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    this.camera.updateMatrixWorld();
    const origin = this.camera.position.clone();
    const direction = new Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, 0.5)
      .unproject(this.camera)
      .sub(origin)
      .normalize();
    // Closest approach of the lines anchor + t·up and origin + s·direction.
    const b = direction.y;
    const denominator = 1 - b * b;
    if (denominator < minArrowAngle * minArrowAngle) return undefined;
    const w = new Vector3(anchor[0], anchor[1], anchor[2]).sub(origin);
    return (b * w.dot(direction) - w.y) / denominator;
  }

  /** How far one CSS pixel reaches at a position's distance from the camera. */
  private worldPerPixel(position: readonly [number, number, number]): number {
    return arrowLength(this.camera, position, this.renderer.domElement.getBoundingClientRect().height) / arrowPixels;
  }

  private snapDraggedMarker(): void {
    const drag = this.markerDrag;
    if (drag === undefined || !drag.pending) return;
    drag.pending = false;
    const hit = this.pickDrawn(drag.x, drag.y, pickTolerance);
    if (hit === undefined) return;
    drag.last = hit;
    for (const listener of this.markerDragListeners) listener(drag.id, hit, false);
  }

  /** Markers and measurement lines drawn over the scan; they stay until replaced. */
  public setAnnotations(annotations: Annotations): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setAnnotations(annotations);
  }

  /** What the cursor is about to do - a snap target, an edge being drawn - over the annotations; undefined clears it. */
  public setPreview(preview: Annotations | undefined): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setAnnotationPreview(preview);
  }

  /**
   * Where a local position appears on the canvas, in CSS pixels from its
   * top-left corner, for placing HTML labels. `visible` is false when the
   * position is behind the camera.
   */
  public projectToCanvas(position: readonly [number, number, number]): { x: number; y: number; visible: boolean } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const projected = new Vector3(...position).project(this.camera);
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
      visible: projected.z > -1 && projected.z < 1,
    };
  }

  /** Called after every rendered frame, for keeping HTML overlays in step with the camera. */
  public onFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Frames the whole scan again, as when it was first loaded. */
  public resetView(): void {
    this.assertNotDisposed();
    this.frameActiveCloud();
  }

  /** Whether double-clicking flies the camera to the point clicked; off while clicks place measurement points. */
  public setDoubleClickToFly(enabled: boolean): void {
    this.assertNotDisposed();
    this.controls.enableDoubleClick = enabled;
  }

  /** Slowly circles the scan, for a showcase view no one is steering. */
  public setAutoRotate(enabled: boolean, speed = 0.6): void {
    this.assertNotDisposed();
    this.controls.autoRotate = enabled;
    this.controls.autoRotateSpeed = speed;
  }

  /**
   * Turns wheel and pinch zoom, and keyboard movement, on or off. A viewer
   * embedded in a scrolling page must let the wheel scroll the page and the
   * arrow keys reach it instead of trapping them.
   */
  public setZoomEnabled(enabled: boolean): void {
    this.assertNotDisposed();
    this.controls.enableZoom = enabled;
    this.controls.enableKeys = enabled;
  }

  public setColorMode(mode: PointCloudColorMode): void {
    this.assertNotDisposed();
    this.colorMode = mode;
    this.pointCloudRenderer.setColorMode(mode);
  }

  public resize(width: number, height: number, pixelRatio = Math.min(window.devicePixelRatio, 2)): void {
    this.assertNotDisposed();
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.pointCloudRenderer.setSize(width * pixelRatio, height * pixelRatio);
  }

  public start(): void {
    this.assertNotDisposed();
    if (this.frameHandle !== undefined) return;
    let previous = performance.now();
    const tick = (now: number) => {
      this.controls.update((now - previous) / 1000);
      previous = now;
      this.fitClippingPlanes();
      if (this.distanceBasedLodEnabled && this.activeTiledPyramid !== undefined) {
        this.pointCloudRenderer.applyScreenSpaceLod(this.activeTiledPyramid, this.lodGapPixels, this.pointBudget);
        this.notifySummary();
      }
      this.snapDraggedMarker();
      this.pickHover(now);
      this.pointCloudRenderer.render();
      for (const listener of this.frameListeners) listener();
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  public stop(): void {
    if (this.frameHandle === undefined) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.renderer.domElement.removeEventListener("pointerdown", this.onHandlePointerDown, { capture: true });
    this.renderer.domElement.removeEventListener("pointermove", this.onHandlePointerMove, { capture: true });
    this.renderer.domElement.removeEventListener("pointerup", this.onHandlePointerUp, { capture: true });
    this.renderer.domElement.removeEventListener("pointercancel", this.onHandlePointerUp, { capture: true });
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    this.clickListeners.clear();
    this.markerDragListeners.clear();
    this.axisDragListeners.clear();
    this.handleClickListeners.clear();
    this.dragStartListeners.clear();
    this.secondaryClickListeners.clear();
    this.hoverListeners.clear();
    this.frameListeners.clear();
    this.session.cancelPendingLoad();
    this.controls.dispose();
    this.buildPool?.dispose();
    this.pointCloudRenderer.dispose();
    this.renderer.dispose();
    this.disposed = true;
  }

  private applyLodForCurrentMode(): void {
    if (this.activeTiledPyramid === undefined) return;
    if (this.distanceBasedLodEnabled) {
      this.pointCloudRenderer.applyScreenSpaceLod(this.activeTiledPyramid, this.lodGapPixels, this.pointBudget);
    } else {
      this.pointCloudRenderer.applyPointBudget(this.pointBudget, this.activeTiledPyramid);
    }
    this.notifySummary();
  }

  private notifySummary(): void {
    if (this.activeTiledPyramid === undefined) return;
    const summary = this.pointCloudRenderer.getRenderSummary(this.camera.position.x, this.camera.position.y, this.camera.position.z, this.activeTiledPyramid);
    const previous = this.lastSummary;
    if (
      previous !== undefined &&
      previous.focusTierId === summary.focusTierId &&
      previous.drawnPointCount === summary.drawnPointCount &&
      previous.tileCount === summary.tileCount &&
      previous.tiers.map((tier) => tier.tiles).join() === summary.tiers.map((tier) => tier.tiles).join()
    ) {
      return;
    }
    this.lastSummary = summary;
    for (const listener of this.summaryListeners) listener(summary);
  }

  /**
   * Keeps the near and far planes hugging the scan from wherever the camera is.
   *
   * A depth buffer spends its precision in proportion to the ratio of far to
   * near. Planes fixed when a scan loads have to allow for the camera coming
   * right up to a wall and for it pulling far back, a ratio in the tens of
   * thousands, which at a normal viewing distance leaves depth steps tens of
   * centimetres deep - enough for points behind a wall to win the depth test
   * against the wall and show through it. Measured every frame, the planes
   * bracket just the scan: the near plane stays in front of its closest point
   * and the far plane just behind its farthest corner.
   */
  private fitClippingPlanes(): void {
    const bounds = this.activePyramid?.tiers[0]?.cloud.bounds;
    if (bounds === undefined) return;
    const { x, y, z } = this.camera.position;
    let farthest = 0;
    for (let corner = 0; corner < 8; corner += 1) {
      farthest = Math.max(
        farthest,
        Math.hypot(
          x - (corner & 1 ? bounds.max[0] : bounds.min[0]),
          y - (corner & 2 ? bounds.max[1] : bounds.min[1]),
          z - (corner & 4 ? bounds.max[2] : bounds.min[2]),
        ),
      );
    }
    const far = farthest * 1.05 + 1;
    // Inside the bounds the nearest point could be anywhere, so the near plane
    // falls back to a fixed share of the far one - still far tighter than a
    // plane chosen for every possible camera position at once.
    const near = Math.max(distanceToBounds(x, y, z, bounds) * 0.5, far / 20_000, 0.01);
    if (Math.abs(near - this.camera.near) < near * 0.01 && Math.abs(far - this.camera.far) < far * 0.01) return;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  private frameActiveCloud(): void {
    const cloud = this.activePyramid?.tiers[0]?.cloud;
    if (cloud === undefined) return;
    const { center, diagonal } = cloud.bounds;
    const distance = diagonal > 0 ? diagonal * (this.framingDistance ?? viewerConfig().camera.framingDistance) : 1;
    const target = new Vector3(...center);
    this.controls.setScene(target, diagonal / 2, cloud.bounds.min[1]);
    this.controls.setView(new Vector3(center[0] + distance, center[1] + distance * 0.55, center[2] + distance), target);
    this.camera.near = Math.max(0.01, distance / 10_000);
    this.camera.far = Math.max(100, distance * 8);
    this.camera.updateProjectionMatrix();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("LidarViewer has already been disposed");
  }
}

function distanceToSegment(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}
