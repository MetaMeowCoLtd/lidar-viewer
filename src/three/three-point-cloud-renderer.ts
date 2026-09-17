import {
  BufferAttribute,
  BufferGeometry,
  Points,
  Scene,
  Vector2,
  type Camera,
  type WebGLRenderer,
} from "three";
import type { PointCloud, PointCloudBounds, PointCloudColorMode, PointCloudPointShape } from "../core/point-cloud.js";
import type { PointCloudLodTier } from "../core/lod-pyramid.js";
import { distanceToBounds, type TiledPointCloudLodPyramid } from "../core/tiled-lod-pyramid.js";
import { PointCloudShaderMaterial } from "./point-cloud-shader-material.js";
import { EyeDomeLighting } from "./eye-dome-lighting.js";
import { viewerConfig } from "../config.js";
import { heightAboveGroundRampTop } from "../core/statistics.js";
import type { DetectedObject } from "../core/object-detection.js";
import { ObjectOutlines } from "./object-outlines.js";

export interface LodRenderSummary {
  readonly tileCount: number;
  readonly drawnPointCount: number;
  readonly totalPointCount: number;
  /** Tier id of whichever tile is currently closest to the camera. */
  readonly focusTierId: string | undefined;
}

interface TileRenderState {
  readonly id: string;
  readonly bounds: PointCloudBounds;
  readonly points: Points;
  activeTier: PointCloudLodTier | undefined;
}

interface CachedGeometry {
  readonly geometry: BufferGeometry;
  readonly pointCount: number;
}

/**
 * Imperative Three.js boundary. It is deliberately not a React component: UI
 * state can call these methods without rebuilding scene objects or GPU buffers.
 * Each spatial tile gets its own `Points` mesh so tiers can be swapped
 * independently per tile as the camera moves, while sharing one material.
 * Tier geometry is uploaded the first time a tier is actually shown and held
 * in a least-recently-used cache, so a scene never costs more GPU memory than
 * the tiers it has really drawn.
 */
export class ThreePointCloudRenderer {
  private readonly tileStates = new Map<string, TileRenderState>();
  private readonly geometryCache = new Map<string, CachedGeometry>();
  private readonly emptyGeometry = new BufferGeometry();
  private cachedPointCount = 0;
  private material: PointCloudShaderMaterial | undefined;
  private eyeDome: EyeDomeLighting | undefined;
  private reliefEnabled = false;
  private hasRgb = false;
  private hasClassification = false;
  private hasHeightAboveGround = false;
  private hasObjects = false;
  private readonly outlines = new ObjectOutlines();

  public constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly camera: Camera,
  ) {
    const size = renderer.getDrawingBufferSize(new Vector2());
    this.outlines.setResolution(size.x, size.y);
  }

  public setTiledPyramid(source: PointCloud, tiled: TiledPointCloudLodPyramid): void {
    this.disposeCloudResources();
    this.material = new PointCloudShaderMaterial({
      worldScale: source.bounds.diagonal,
      minHeight: source.bounds.min[1],
      maxHeight: source.bounds.max[1],
      ...(source.heightAboveGround === undefined ? {} : { maxAboveGround: heightAboveGroundRampTop(source.heightAboveGround) }),
    });
    this.material.setHasRgb(source.supportsColorMode("rgb"));
    this.hasRgb = source.supportsColorMode("rgb");
    this.hasClassification = source.supportsColorMode("classification");
    this.hasHeightAboveGround = source.supportsColorMode("heightAboveGround");
    this.hasObjects = source.supportsColorMode("objects");

    for (const tile of tiled.tiles) {
      const points = new Points(this.emptyGeometry, this.material);
      this.scene.add(points);
      this.tileStates.set(tile.id, { id: tile.id, bounds: tile.bounds, points, activeTier: undefined });
    }
  }

  /** Distributes `pointBudget` across tiles and applies each tile's resulting tier. */
  public applyPointBudget(pointBudget: number, tiled: TiledPointCloudLodPyramid): void {
    for (const selection of tiled.selectForPointBudget(pointBudget)) this.applyTileTier(selection.tile.id, selection.tier);
  }

  /** Applies each tile's tier from its own distance to the camera. */
  public applyCameraDistanceLod(cameraX: number, cameraY: number, cameraZ: number, tiled: TiledPointCloudLodPyramid): void {
    for (const tile of tiled.tiles) {
      const distance = distanceToBounds(cameraX, cameraY, cameraZ, tile.bounds);
      this.applyTileTier(tile.id, tile.pyramid.selectForCameraDistance(distance));
    }
  }

  /** Reports the currently rendered tiers - independent of which apply method was last called. */
  public getRenderSummary(cameraX: number, cameraY: number, cameraZ: number, tiled: TiledPointCloudLodPyramid): LodRenderSummary {
    let drawnPointCount = 0;
    let focusTierId: string | undefined;
    let focusDistance = Number.POSITIVE_INFINITY;
    for (const state of this.tileStates.values()) {
      drawnPointCount += state.activeTier?.cloud.pointCount ?? 0;
      const distance = distanceToBounds(cameraX, cameraY, cameraZ, state.bounds);
      if (distance < focusDistance) {
        focusDistance = distance;
        focusTierId = state.activeTier?.id;
      }
    }
    return { tileCount: this.tileStates.size, drawnPointCount, totalPointCount: tiled.totalPointCount, focusTierId };
  }

  public setPointSize(pointSize: number): void {
    this.material?.setPointSize(pointSize);
  }

  public setPointShape(shape: PointCloudPointShape): void {
    this.material?.setPointShape(shape);
  }

  public setColorMode(mode: PointCloudColorMode): void {
    const unsupported =
      (mode === "rgb" && !this.hasRgb) ||
      (mode === "classification" && !this.hasClassification) ||
      (mode === "heightAboveGround" && !this.hasHeightAboveGround) ||
      (mode === "objects" && !this.hasObjects);
    const supportedMode = unsupported ? "height" : mode;
    this.reliefEnabled = supportedMode === "relief";
    this.material?.setColorMode(supportedMode);
  }

  public setSize(width: number, height: number): void {
    this.eyeDome?.setSize(width, height);
    this.outlines.setResolution(width, height);
  }

  /**
   * Outlines and object colours for the buildings and trees found in the
   * current cloud. Call after the cloud carrying their ids is in place; a new
   * cloud clears them.
   */
  public setObjects(objects: readonly DetectedObject[] | undefined): void {
    this.outlines.setObjects(objects);
    this.material?.setBuildingCount(objects?.filter((object) => object.kind === "building").length ?? 0);
  }

  public setOutlineVisibility(buildings: boolean, trees: boolean): void {
    this.outlines.setVisibility(buildings, trees);
  }

  /** Call from the host application's single requestAnimationFrame loop. */
  public render(): void {
    if (!this.reliefEnabled) {
      this.renderer.render(this.scene, this.camera);
      this.outlines.render(this.renderer, this.camera);
      return;
    }
    if (this.eyeDome === undefined) {
      this.eyeDome = new EyeDomeLighting(this.renderer);
      const size = this.renderer.getDrawingBufferSize(new Vector2());
      this.eyeDome.setSize(size.x, size.y);
      this.eyeDome.setStrength(viewerConfig().eyeDomeLighting.strength);
      this.eyeDome.setRadius(viewerConfig().eyeDomeLighting.radius);
    }
    this.eyeDome.render(this.scene, this.camera);
    this.outlines.render(this.renderer, this.camera);
  }

  public dispose(): void {
    this.disposeCloudResources();
    this.outlines.dispose();
    this.emptyGeometry.dispose();
    this.eyeDome?.dispose();
    this.eyeDome = undefined;
  }

  private applyTileTier(tileId: string, nextTier: PointCloudLodTier): void {
    const state = this.tileStates.get(tileId);
    if (state === undefined || state.activeTier?.id === nextTier.id) return;
    state.points.geometry = this.geometryFor(tileId, nextTier);
    state.activeTier = nextTier;
  }

  private geometryFor(tileId: string, tier: PointCloudLodTier): BufferGeometry {
    const key = `${tileId}/${tier.id}`;
    const cached = this.geometryCache.get(key);
    if (cached !== undefined) {
      this.geometryCache.delete(key);
      this.geometryCache.set(key, cached);
      return cached.geometry;
    }
    const geometry = createGeometry(tier.cloud);
    this.geometryCache.set(key, { geometry, pointCount: tier.cloud.pointCount });
    this.cachedPointCount += tier.cloud.pointCount;
    this.releaseUnusedGeometry(key);
    return geometry;
  }

  /**
   * Drops the oldest geometry that no tile is currently drawing until the
   * budget is met. `keepKey` is the geometry the caller is about to draw, which
   * no tile references yet and so would otherwise look evictable.
   */
  private releaseUnusedGeometry(keepKey: string): void {
    const budget = viewerConfig().gpuPointBudget;
    if (this.cachedPointCount <= budget) return;
    const drawn = new Set<BufferGeometry>();
    for (const state of this.tileStates.values()) drawn.add(state.points.geometry);
    for (const [key, entry] of this.geometryCache) {
      if (this.cachedPointCount <= budget) return;
      if (key === keepKey || drawn.has(entry.geometry)) continue;
      entry.geometry.dispose();
      this.geometryCache.delete(key);
      this.cachedPointCount -= entry.pointCount;
    }
  }

  private disposeCloudResources(): void {
    for (const state of this.tileStates.values()) this.scene.remove(state.points);
    this.tileStates.clear();
    for (const entry of this.geometryCache.values()) entry.geometry.dispose();
    this.geometryCache.clear();
    this.cachedPointCount = 0;
    this.material?.dispose();
    this.material = undefined;
    this.hasRgb = false;
    this.hasClassification = false;
    this.hasHeightAboveGround = false;
    this.hasObjects = false;
    this.outlines.setObjects(undefined);
  }
}

function createGeometry(cloud: PointCloud): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(cloud.positions, 3));
  if (cloud.colors !== undefined) {
    geometry.setAttribute("color", new BufferAttribute(cloud.colors, 3, true));
  }
  if (cloud.classification !== undefined) {
    // Not normalized: the shader wants the class code itself, 0 to 255, not a
    // fraction of the byte range.
    geometry.setAttribute("classification", new BufferAttribute(cloud.classification, 1, false));
  }
  if (cloud.heightAboveGround !== undefined) {
    geometry.setAttribute("heightAboveGround", new BufferAttribute(cloud.heightAboveGround, 1));
  }
  if (cloud.objectId !== undefined) {
    // Three.js binds a Uint32Array as an integer attribute, and WebGL refuses
    // to draw when an integer attribute feeds a shader input declared as a
    // float - every point in the scan silently disappears. The GPU gets a float
    // copy instead, which holds ids exactly up to sixteen million objects.
    geometry.setAttribute("objectId", new BufferAttribute(Float32Array.from(cloud.objectId), 1));
  }
  geometry.computeBoundingSphere();
  return geometry;
}
