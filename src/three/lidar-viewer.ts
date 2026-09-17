import { Matrix4, PerspectiveCamera, Scene, Vector2, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PointCloud, PointCloudColorMode, PointCloudPointShape } from "../core/point-cloud.js";
import { PointCloudLodPyramid, type LodTierSpec } from "../core/lod-pyramid.js";
import { PointCloudSession } from "../core/point-cloud-session.js";
import { TiledPointCloudLodPyramid, distanceToBounds } from "../core/tiled-lod-pyramid.js";
import { LodBuildPool } from "../core/lod-build-pool.js";
import { ThreePointCloudRenderer } from "./three-point-cloud-renderer.js";
import { viewerConfig } from "../config.js";
import type { DetectedObject } from "../core/object-detection.js";
import { pickPoint, type PointHit } from "../core/point-picking.js";
import { maxDotSize } from "./point-cloud-shader-material.js";
import type { Annotations } from "./measurement-overlay.js";

export type { LodRenderSummary } from "./three-point-cloud-renderer.js";
export type { Annotations, MarkerAnnotation, MarkerTone } from "./measurement-overlay.js";
import type { LodRenderSummary } from "./three-point-cloud-renderer.js";

/** How far, in CSS pixels, a press may travel and still count as a click. */
const clickSlop = 5;
/** How long, in milliseconds, a press may last and still count as a click. */
const clickDuration = 600;
/** How far from the cursor, in CSS pixels, a click in a gap between dots still finds a point. */
const pickTolerance = 8;

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
  private readonly controls: OrbitControls;
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
  private pressed: { x: number; y: number; time: number; pointerId: number } | undefined;
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
    const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
    if (moved > clickSlop || event.timeStamp - pressed.time > clickDuration) return;
    const hit = this.pickAt(event.clientX, event.clientY);
    for (const listener of this.clickListeners) listener(hit);
  };

  public constructor(canvas: HTMLCanvasElement, options: LidarViewerOptions = {}) {
    this.pointBudget = options.pointBudget ?? 500_000;
    this.pointSize = options.pointSize ?? 2.4;
    this.distanceBasedLodEnabled = options.distanceBasedLod ?? false;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(options.clearColor ?? 0x07111f, 0);
    this.renderer.setPixelRatio(options.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = viewerConfig().camera.damping;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.pointCloudRenderer = new ThreePointCloudRenderer(this.scene, this.renderer, this.camera);
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

  public async load(source: PointCloud | Promise<PointCloud>, specs: readonly LodTierSpec[]): Promise<void> {
    this.assertNotDisposed();
    this.keepCameraOnNextReady = false;
    await this.build(source, specs);
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

  private async build(source: PointCloud | Promise<PointCloud>, specs: readonly LodTierSpec[]): Promise<void> {
    this.lastSpecs = specs;
    const tiling = viewerConfig().tiling;
    this.buildPool ??= new LodBuildPool(Math.min(navigator.hardwareConcurrency || 4, tiling.buildWorkers));
    const pool = this.buildPool;
    await this.session.load(source, specs.filter((spec) => spec.voxelSize === 0), (cloud) =>
      TiledPointCloudLodPyramid.buildWithPool(cloud, specs, tiling, pool),
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
    if (tiled === undefined) return undefined;
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
      },
    );
  }

  /** Notified with the picked point, or undefined for a click on empty space. Drags never notify. */
  public onPointClick(listener: (hit: PointHit | undefined) => void): () => void {
    this.clickListeners.add(listener);
    return () => this.clickListeners.delete(listener);
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
    const tick = () => {
      this.controls.update();
      this.fitClippingPlanes();
      if (this.distanceBasedLodEnabled && this.activeTiledPyramid !== undefined) {
        this.pointCloudRenderer.applyCameraDistanceLod(this.camera.position.x, this.camera.position.y, this.camera.position.z, this.activeTiledPyramid);
        this.notifySummary();
      }
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
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.clickListeners.clear();
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
    const distance = diagonal > 0 ? diagonal * viewerConfig().camera.framingDistance : 1;
    this.controls.target.set(...center);
    this.camera.position.set(center[0] + distance, center[1] + distance * 0.55, center[2] + distance);
    this.camera.near = Math.max(0.01, distance / 10_000);
    this.camera.far = Math.max(100, distance * 8);
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = Math.max(diagonal / 5_000, 0.01);
    this.controls.maxDistance = distance * 4;
    this.controls.update();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("LidarViewer has already been disposed");
  }
}
