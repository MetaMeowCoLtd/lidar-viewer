import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PointCloud, PointCloudColorMode, PointCloudPointShape } from "../core/point-cloud.js";
import { PointCloudLodPyramid, type LodTierSpec } from "../core/lod-pyramid.js";
import { PointCloudSession } from "../core/point-cloud-session.js";
import { TiledPointCloudLodPyramid } from "../core/tiled-lod-pyramid.js";
import { ThreePointCloudRenderer } from "./three-point-cloud-renderer.js";
import { viewerConfig } from "../config.js";

export type { LodRenderSummary } from "./three-point-cloud-renderer.js";
import type { LodRenderSummary } from "./three-point-cloud-renderer.js";

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

    this.session.subscribe((state) => {
      if (state.status !== "ready" || this.disposed) return;
      this.activePyramid = state.pyramid;
      const source = state.pyramid.tiers[0]!.cloud;
      this.activeTiledPyramid = TiledPointCloudLodPyramid.build(source, this.lastSpecs, viewerConfig().tiling);
      this.pointCloudRenderer.setTiledPyramid(source, this.activeTiledPyramid);
      this.frameActiveCloud();
      this.applyLodForCurrentMode();
      this.pointCloudRenderer.setPointSize(this.pointSize);
      this.pointCloudRenderer.setColorMode(this.colorMode);
      this.pointCloudRenderer.setPointShape(this.pointShape);
    });
  }

  public async load(source: PointCloud | Promise<PointCloud>, specs: readonly LodTierSpec[]): Promise<void> {
    this.assertNotDisposed();
    this.lastSpecs = specs;
    await this.session.load(source, specs);
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
      if (this.distanceBasedLodEnabled && this.activeTiledPyramid !== undefined) {
        this.pointCloudRenderer.applyCameraDistanceLod(this.camera.position.x, this.camera.position.y, this.camera.position.z, this.activeTiledPyramid);
        this.notifySummary();
      }
      this.pointCloudRenderer.render();
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
    this.session.cancelPendingLoad();
    this.controls.dispose();
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
