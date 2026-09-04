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
  readonly geometries: Map<string, BufferGeometry>;
  readonly points: Points;
  activeTier: PointCloudLodTier;
}

/**
 * Imperative Three.js boundary. It is deliberately not a React component: UI
 * state can call these methods without rebuilding scene objects or GPU buffers.
 * Each spatial tile gets its own `Points` mesh so tiers can be swapped
 * independently per tile as the camera moves, while sharing one material.
 */
export class ThreePointCloudRenderer {
  private readonly tileStates = new Map<string, TileRenderState>();
  private material: PointCloudShaderMaterial | undefined;
  private eyeDome: EyeDomeLighting | undefined;
  private reliefEnabled = false;
  private hasRgb = false;

  public constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly camera: Camera,
  ) {}

  public setTiledPyramid(source: PointCloud, tiled: TiledPointCloudLodPyramid): void {
    this.disposeCloudResources();
    const intensityRange = findRange(source.intensity);
    this.material = new PointCloudShaderMaterial({
      worldScale: source.bounds.diagonal,
      minHeight: source.bounds.min[1],
      maxHeight: source.bounds.max[1],
      ...(intensityRange === undefined ? {} : { minIntensity: intensityRange.min, maxIntensity: intensityRange.max }),
    });
    this.material.setHasRgb(source.supportsColorMode("rgb"));
    this.hasRgb = source.supportsColorMode("rgb");

    for (const tile of tiled.tiles) {
      const geometries = new Map<string, BufferGeometry>();
      for (const tier of tile.pyramid.tiers) geometries.set(tier.id, createGeometry(tier.cloud));
      const activeTier = tile.pyramid.tiers[0]!;
      const points = new Points(geometries.get(activeTier.id)!, this.material);
      this.scene.add(points);
      this.tileStates.set(tile.id, { id: tile.id, bounds: tile.bounds, geometries, points, activeTier });
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
      drawnPointCount += state.activeTier.cloud.pointCount;
      const distance = distanceToBounds(cameraX, cameraY, cameraZ, state.bounds);
      if (distance < focusDistance) {
        focusDistance = distance;
        focusTierId = state.activeTier.id;
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
    const supportedMode = mode === "rgb" && !this.hasRgb ? "height" : mode;
    this.reliefEnabled = supportedMode === "relief";
    this.material?.setColorMode(supportedMode);
  }

  public setSize(width: number, height: number): void {
    this.eyeDome?.setSize(width, height);
  }

  /** Call from the host application's single requestAnimationFrame loop. */
  public render(): void {
    if (!this.reliefEnabled) {
      this.renderer.render(this.scene, this.camera);
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
  }

  public dispose(): void {
    this.disposeCloudResources();
    this.eyeDome?.dispose();
    this.eyeDome = undefined;
  }

  private applyTileTier(tileId: string, nextTier: PointCloudLodTier): void {
    const state = this.tileStates.get(tileId);
    if (state === undefined || state.activeTier.id === nextTier.id) return;
    state.points.geometry = state.geometries.get(nextTier.id)!;
    state.activeTier = nextTier;
  }

  private disposeCloudResources(): void {
    for (const state of this.tileStates.values()) {
      this.scene.remove(state.points);
      for (const geometry of state.geometries.values()) geometry.dispose();
    }
    this.tileStates.clear();
    this.material?.dispose();
    this.material = undefined;
    this.hasRgb = false;
  }
}

function createGeometry(cloud: PointCloud): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(cloud.positions, 3));
  geometry.setAttribute("color", new BufferAttribute(cloud.colors ?? fallbackColors(cloud.pointCount), 3, true));
  geometry.setAttribute("intensity", new BufferAttribute(cloud.intensity ?? new Float32Array(cloud.pointCount), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function fallbackColors(pointCount: number): Uint8Array {
  const colors = new Uint8Array(pointCount * 3);
  colors.fill(255);
  return colors;
}

function findRange(values: Float32Array | undefined): { min: number; max: number } | undefined {
  if (values === undefined) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}
