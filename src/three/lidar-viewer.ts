import { Matrix4, PerspectiveCamera, Scene, Vector2, Vector3, WebGLRenderer } from "three";
import { NavigationControls } from "./navigation-controls.js";
import type { PointCloud, PointCloudColorMode, PointCloudPointShape } from "../core/point-cloud.js";
import { PointCloudLodPyramid, type LodTierSpec } from "../core/lod-pyramid.js";
import { PointCloudSession } from "../core/point-cloud-session.js";
import { TiledPointCloudLodPyramid, distanceToBounds } from "../core/tiled-lod-pyramid.js";
import { LodBuildPool } from "../core/lod-build-pool.js";
import { ThreePointCloudRenderer } from "./three-point-cloud-renderer.js";
import { viewerConfig } from "../config.js";
import type { DetectedObject } from "../core/object-detection.js";
import { pickPoint, type PointHit } from "../core/point-picking.js";
import { maxDotSize, type NoiseDisplay } from "./point-cloud-shader-material.js";
import { isNoiseClass } from "../core/noise-detection.js";
import type { Annotations } from "./measurement-overlay.js";
import type { TerrainModel } from "../core/terrain.js";
import type { ContourSet } from "../core/contours.js";

export type { LodRenderSummary } from "./three-point-cloud-renderer.js";
export type { Annotations, MarkerAnnotation, MarkerTone } from "./measurement-overlay.js";
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

/** A marker the user can drag to another spot on the scan. */
export interface DraggableMarker {
  readonly id: string;
  readonly position: readonly [number, number, number];
}

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
  private lastSummary: LodRenderSummary | undefined;
  private readonly summaryListeners = new Set<(summary: LodRenderSummary) => void>();
  private buildPool: LodBuildPool | undefined;
  /** Set by {@link LidarViewer.replaceCloud}, so the next ready cloud keeps the current view. */
  private keepCameraOnNextReady = false;
  private readonly clickListeners = new Set<(hit: PointHit | undefined) => void>();
  private readonly frameListeners = new Set<() => void>();
  private pointsVisible = true;
  private readonly framingDistance: number | undefined;
  private pressed: { x: number; y: number; time: number; pointerId: number } | undefined;
  private draggableMarkers: readonly DraggableMarker[] = [];
  private readonly markerDragListeners = new Set<(id: string, hit: PointHit, done: boolean) => void>();
  private markerDrag: { id: string; pointerId: number; x: number; y: number; pending: boolean } | undefined;
  /**
   * A press on a marker starts dragging it instead of moving the camera: the
   * press is caught before the navigation controls see it. Anywhere else, the
   * press goes on to them untouched.
   */
  private readonly onHandlePointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
    const id = this.markerAt(event.clientX, event.clientY);
    if (id === undefined) return;
    event.stopImmediatePropagation();
    // Also keeps the browser from firing the mousedown the controls listen for.
    event.preventDefault();
    this.pressed = undefined;
    this.markerDrag = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, pending: false };
    // Keeps the drag when the cursor leaves the canvas; a pointer the browser no longer tracks cannot be captured.
    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // The drag still works while the cursor stays over the scan.
    }
    this.renderer.domElement.style.cursor = "grabbing";
  };
  private readonly onHandlePointerMove = (event: PointerEvent) => {
    const drag = this.markerDrag;
    if (drag === undefined) {
      // Only hovering: say that the marker under the cursor can be picked up.
      if (event.buttons === 0 && this.draggableMarkers.length > 0) {
        const over = this.markerAt(event.clientX, event.clientY) !== undefined;
        const style = this.renderer.domElement.style;
        if (over) style.cursor = "grab";
        else if (style.cursor === "grab") style.cursor = "";
      }
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    event.stopImmediatePropagation();
    // Snapping searches the whole scan, so it runs once per frame on the latest position rather than on every move.
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.pending = true;
  };
  private readonly onHandlePointerUp = (event: PointerEvent) => {
    const drag = this.markerDrag;
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    event.stopImmediatePropagation();
    this.markerDrag = undefined;
    this.renderer.domElement.style.cursor = "";
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
    const hit = this.pickAt(event.clientX, event.clientY);
    if (hit !== undefined) for (const listener of this.markerDragListeners) listener(drag.id, hit, true);
  };
  private readonly onPointerDown = (event: PointerEvent) => {
    this.pressed = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, time: event.timeStamp, pointerId: event.pointerId } : undefined;
  };
  /**
   * A press and release close together in place and time is a click; anything
   * else was the user orbiting or panning, and must not pick a point.
   */
  private readonly onPointerUp = (event: PointerEvent) => {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (pressed === undefined || pressed.pointerId !== event.pointerId || this.clickListeners.size === 0) return;
    // The controls count the travel too: a drag under the pointer lock ends where it began on screen.
    const moved = Math.max(Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y), this.controls.dragDistance);
    if (moved > clickSlop || event.timeStamp - pressed.time > clickDuration) return;
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
    await this.session.load(source, specs.filter((spec) => spec.voxelSize === 0), (cloud) =>
      TiledPointCloudLodPyramid.buildWithPool(cloud, specs, tiling, pool, onProgress),
    );
  }

  public setPointBudget(pointBudget: number): void {
    this.assertNotDisposed();
    this.pointBudget = pointBudget;
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
        dotRadius: (depth) => this.pointCloudRenderer.dotRadius(depth),
        maxDotRadius: maxDotSize / 2,
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
    if (this.activeTiledPyramid === undefined || !this.pointsVisible) return undefined;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const scale = size.x / rect.width;
    this.camera.updateMatrixWorld();
    const viewProjection = new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const hit = pickPoint(this.pointCloudRenderer.drawnClouds(), {
      viewProjection: viewProjection.elements,
      width: size.x,
      height: size.y,
      cursorX: (clientX - rect.left) * scale,
      cursorY: (clientY - rect.top) * scale,
      dotRadius: (depth) => this.pointCloudRenderer.dotRadius(depth),
      maxDotRadius: maxDotSize / 2,
      tolerance: pivotTolerance * this.renderer.getPixelRatio(),
      skip: this.hiddenPoint(),
    });
    if (hit === undefined) return undefined;
    const offset = hit.index * 3;
    return new Vector3(hit.cloud.positions[offset], hit.cloud.positions[offset + 1], hit.cloud.positions[offset + 2]);
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
   * scan's surface under the cursor - it snaps to the nearest real point, so a
   * measurement always runs between measured points - and listeners hear every
   * new spot, the last with `done` set.
   */
  public setDraggableMarkers(markers: readonly DraggableMarker[]): void {
    this.draggableMarkers = markers;
  }

  public onMarkerDrag(listener: (id: string, hit: PointHit, done: boolean) => void): () => void {
    this.markerDragListeners.add(listener);
    return () => this.markerDragListeners.delete(listener);
  }

  /** The draggable marker nearest the cursor, if one is close enough to grab. */
  private markerAt(clientX: number, clientY: number): string | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    let best: string | undefined;
    let bestDistance = handleRadius;
    for (const marker of this.draggableMarkers) {
      const spot = this.projectToCanvas(marker.position);
      if (!spot.visible) continue;
      const distance = Math.hypot(clientX - rect.left - spot.x, clientY - rect.top - spot.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = marker.id;
      }
    }
    return best;
  }

  private snapDraggedMarker(): void {
    const drag = this.markerDrag;
    if (drag === undefined || !drag.pending) return;
    drag.pending = false;
    const hit = this.pickAt(drag.x, drag.y);
    if (hit !== undefined) for (const listener of this.markerDragListeners) listener(drag.id, hit, false);
  }

  /** Markers and measurement lines drawn over the scan; they stay until replaced. */
  public setAnnotations(annotations: Annotations): void {
    this.assertNotDisposed();
    this.pointCloudRenderer.setAnnotations(annotations);
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
        this.pointCloudRenderer.applyCameraDistanceLod(this.camera.position.x, this.camera.position.y, this.camera.position.z, this.activeTiledPyramid);
        this.notifySummary();
      }
      this.snapDraggedMarker();
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
    this.clickListeners.clear();
    this.markerDragListeners.clear();
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
      this.pointCloudRenderer.applyCameraDistanceLod(this.camera.position.x, this.camera.position.y, this.camera.position.z, this.activeTiledPyramid);
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
      previous.tileCount === summary.tileCount
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
