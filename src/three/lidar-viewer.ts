import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PointCloud, PointCloudColorMode, PointCloudPointShape } from "../core/point-cloud.js";
import { PointCloudLodPyramid, type LodTierSpec, type PointCloudLodTier } from "../core/lod-pyramid.js";
import { PointCloudSession } from "../core/point-cloud-session.js";
import { ThreePointCloudRenderer } from "./three-point-cloud-renderer.js";
import { viewerConfig } from "../config.js";

export interface LidarViewerOptions {
  readonly pointBudget?: number;
  readonly pointSize?: number;
  readonly clearColor?: number;
  readonly pixelRatio?: number;
  /**
   * When true, the active LOD tier is chosen every frame from the camera's
   * distance to the orbit target instead of the manual point budget. Off by
   * default so existing integrations keep their current behavior.
   */
  readonly distanceBasedLod?: boolean;
}

/**
 * Browser composition root for the renderer. It owns the only animation loop,
 * camera controls, and GPU lifecycle, while keeping UI framework state outside
 * the Three.js scene graph.
 */
export class LidarViewer {
  public readonly scene = new Scene();
  public readonly camera = new PerspectiveCamera(viewerConfig().camera.fieldOfView, 1, 0.05, 10_000);
  public readonly session = new PointCloudSession();

  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly pointCloudRenderer: ThreePointCloudRenderer;
  private activePyramid: PointCloudLodPyramid | undefined;
  private pointBudget: number;
  private pointSize: number;
  private colorMode: PointCloudColorMode = "height";
  private pointShape: PointCloudPointShape = viewerConfig().pointShape;
  private frameHandle: number | undefined;
  private disposed = false;
  private distanceBasedLodEnabled: boolean;
  private lastNotifiedTierId: string | undefined;
  private readonly tierChangeListeners = new Set<(tier: PointCloudLodTier) => void>();

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
      this.pointCloudRenderer.setPyramid(state.pyramid);
      this.frameActiveCloud();
      this.applyLodForCurrentMode(state.pyramid);
      this.pointCloudRenderer.setPointSize(this.pointSize);
      this.pointCloudRenderer.setColorMode(this.colorMode);
      this.pointCloudRenderer.setPointShape(this.pointShape);
    });
  }

  public async load(source: PointCloud | Promise<PointCloud>, specs: readonly LodTierSpec[]): Promise<void> {
    this.assertNotDisposed();
    await this.session.load(source, specs);
  }

  public setPointBudget(pointBudget: number): void {
    this.assertNotDisposed();
    this.pointBudget = pointBudget;
    if (this.activePyramid !== undefined && !this.distanceBasedLodEnabled) {
      this.notifyActiveTier(this.pointCloudRenderer.setPointBudget(pointBudget, this.activePyramid));
    }
  }

  /** Toggles automatic, camera-distance-driven LOD selection on or off. */
  public setDistanceBasedLodEnabled(enabled: boolean): void {
    this.assertNotDisposed();
    if (this.distanceBasedLodEnabled === enabled) return;
    this.distanceBasedLodEnabled = enabled;
    if (this.activePyramid !== undefined) this.applyLodForCurrentMode(this.activePyramid);
  }

  public isDistanceBasedLodEnabled(): boolean {
    return this.distanceBasedLodEnabled;
  }

  /** Notified whenever the rendered LOD tier changes, from either selection mode. */
  public onActiveTierChange(listener: (tier: PointCloudLodTier) => void): () => void {
    this.tierChangeListeners.add(listener);
    return () => this.tierChangeListeners.delete(listener);
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
      if (this.distanceBasedLodEnabled && this.activePyramid !== undefined) {
        const distance = this.camera.position.distanceTo(this.controls.target);
        this.notifyActiveTier(this.pointCloudRenderer.setActiveTierByCameraDistance(distance, this.activePyramid));
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

  private applyLodForCurrentMode(pyramid: PointCloudLodPyramid): void {
    if (this.distanceBasedLodEnabled) {
      const distance = this.camera.position.distanceTo(this.controls.target);
      this.notifyActiveTier(this.pointCloudRenderer.setActiveTierByCameraDistance(distance, pyramid));
    } else {
      this.notifyActiveTier(this.pointCloudRenderer.setPointBudget(this.pointBudget, pyramid));
    }
  }

  private notifyActiveTier(tier: PointCloudLodTier): void {
    if (tier.id === this.lastNotifiedTierId) return;
    this.lastNotifiedTierId = tier.id;
    for (const listener of this.tierChangeListeners) listener(tier);
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
