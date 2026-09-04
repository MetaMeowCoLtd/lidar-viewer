import {
  BufferAttribute,
  BufferGeometry,
  Points,
  Scene,
  Vector2,
  type Camera,
  type WebGLRenderer,
} from "three";
import type { PointCloud, PointCloudColorMode, PointCloudPointShape } from "../core/point-cloud.js";
import type { PointCloudLodPyramid, PointCloudLodTier } from "../core/lod-pyramid.js";
import { PointCloudShaderMaterial } from "./point-cloud-shader-material.js";
import { EyeDomeLighting } from "./eye-dome-lighting.js";
import { viewerConfig } from "../config.js";

/**
 * Imperative Three.js boundary. It is deliberately not a React component: UI
 * state can call these methods without rebuilding scene objects or GPU buffers.
 */
export class ThreePointCloudRenderer {
  private readonly geometries = new Map<string, BufferGeometry>();
  private activeTier: PointCloudLodTier | undefined;
  private material: PointCloudShaderMaterial | undefined;
  private points: Points | undefined;
  private eyeDome: EyeDomeLighting | undefined;
  private reliefEnabled = false;

  public constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly camera: Camera,
  ) {}

  public setPyramid(pyramid: PointCloudLodPyramid): void {
    this.disposeCloudResources();
    for (const tier of pyramid.tiers) this.geometries.set(tier.id, createGeometry(tier.cloud));
    const source = pyramid.tiers[0]!.cloud;
    const intensityRange = findRange(source.intensity);
    this.material = new PointCloudShaderMaterial({
      worldScale: source.bounds.diagonal,
      minHeight: source.bounds.min[1],
      maxHeight: source.bounds.max[1],
      ...(intensityRange === undefined ? {} : { minIntensity: intensityRange.min, maxIntensity: intensityRange.max }),
    });
    this.material.setHasRgb(source.supportsColorMode("rgb"));
    this.points = new Points(this.geometries.get(pyramid.tiers[0]!.id)!, this.material);
    this.scene.add(this.points);
    this.activeTier = pyramid.tiers[0];
  }

  public setPointBudget(pointBudget: number, pyramid: PointCloudLodPyramid): PointCloudLodTier {
    const nextTier = pyramid.selectForPointBudget(pointBudget);
    if (this.points !== undefined && this.activeTier?.id !== nextTier.id) {
      this.points.geometry = this.geometries.get(nextTier.id)!;
      this.activeTier = nextTier;
    }
    return nextTier;
  }

  public setPointSize(pointSize: number): void {
    this.material?.setPointSize(pointSize);
  }

  public setPointShape(shape: PointCloudPointShape): void {
    this.material?.setPointShape(shape);
  }

  public setColorMode(mode: PointCloudColorMode): void {
    const supportedMode = this.activeTier?.cloud.supportsColorMode(mode) === false ? "height" : mode;
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

  private disposeCloudResources(): void {
    if (this.points !== undefined) this.scene.remove(this.points);
    this.points = undefined;
    this.activeTier = undefined;
    this.material?.dispose();
    this.material = undefined;
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
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
