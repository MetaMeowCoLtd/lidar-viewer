import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Frustum,
  Matrix4,
  Vector3,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  PerspectiveCamera,
  Points,
  Scene,
  Vector2,
  type Camera,
  type WebGLRenderer,
} from "three";
import type { PointCloud, PointCloudBounds, PointCloudColorMode, PointCloudPointShape, PointSizeMode } from "../core/point-cloud.js";
import type { PointCloudLodTier } from "../core/lod-pyramid.js";
import { distanceToBounds, pointSpacing, type TiledPointCloudLodPyramid } from "../core/tiled-lod-pyramid.js";
import { PointCloudShaderMaterial, maxDotSize, type NoiseDisplay } from "./point-cloud-shader-material.js";
import { MeasurementOverlay, type Annotations } from "./measurement-overlay.js";
import { TerrainLayer } from "./terrain-layer.js";
import type { TerrainModel } from "../core/terrain.js";
import type { ContourSet } from "../core/contours.js";
import { EyeDomeLighting } from "./eye-dome-lighting.js";
import { viewerConfig } from "../config.js";
import { heightAboveGroundRampTop, intensityRange } from "../core/statistics.js";
import type { DetectedObject } from "../core/object-detection.js";
import { ObjectOutlines } from "./object-outlines.js";

export interface LodRenderSummary {
  readonly tileCount: number;
  readonly drawnPointCount: number;
  readonly totalPointCount: number;
  /** Tier id of whichever tile is currently closest to the camera. */
  readonly focusTierId: string | undefined;
  /** Every detail level, finest first, with how many tiles draw it now and the points they draw. */
  readonly tiers: readonly LodTierUsage[];
}

export interface LodTierUsage {
  readonly id: string;
  /** Edge of its voxel grid; zero for full resolution. */
  readonly voxelSize: number;
  /** Typical distance between its points, across the tiles drawing it. */
  readonly spacing: number;
  readonly tiles: number;
  readonly points: number;
}

/**
 * Each detail level's colour in the level-of-detail view, a gradient from
 * green at full resolution through yellow and orange to red and violet at the
 * lightest, so how detail falls away with distance reads as a ramp.
 */
export const lodTierColors: Readonly<Record<string, string>> = {
  full: "#2fcf7f",
  lod1: "#9bd23c",
  lod2: "#f2d23a",
  lod3: "#f59a3a",
  lod4: "#ec4f4f",
  lod5: "#a855f7",
};
const otherTierColor = "#a4aebb";



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
  private hasIntensity = false;
  private hasObjects = false;
  private hasFlightLines = false;
  private flightLineMode = false;
  private hiddenFlightLines: ReadonlySet<number> = new Set();
  private readonly outlines = new ObjectOutlines();
  private readonly annotations = new MeasurementOverlay();
  private readonly drawingSize = new Vector2();
  private readonly terrain: TerrainLayer;
  private pointsVisible = true;
  private noiseDisplay: NoiseDisplay = "shown";
  private sizeMode: PointSizeMode = "adaptive";
  private readonly frustum = new Frustum();
  private readonly viewProjection = new Matrix4();
  private readonly box = new Box3();
  private readonly boxMin = new Vector3();
  private readonly boxMax = new Vector3();
  /** How far apart the points of every tier of every tile lie, for sizing their dots and picking them. */
  private spacings = new WeakMap<PointCloud, number>();
  private lodDebug = false;
  private readonly tierTints = new Map<string, Color>();
  private tileBoxes: LineSegments | undefined;
  private tileBoxesStale = true;
  private readonly tileBoxMaterial = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false });

  public constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly camera: Camera,
  ) {
    this.terrain = new TerrainLayer(scene);
    const size = renderer.getDrawingBufferSize(new Vector2());
    this.outlines.setResolution(size.x, size.y);
    this.terrain.setResolution(size.x, size.y);
    this.annotations.setResolution(size.x, size.y, renderer.getPixelRatio());
    for (const [id, color] of Object.entries(lodTierColors)) this.tierTints.set(id, new Color(color));
  }

  public setTiledPyramid(source: PointCloud, tiled: TiledPointCloudLodPyramid): void {
    this.disposeCloudResources();
    this.material = new PointCloudShaderMaterial({
      worldScale: source.bounds.diagonal,
      minHeight: source.bounds.min[1],
      maxHeight: source.bounds.max[1],
      ...(source.heightAboveGround === undefined ? {} : { maxAboveGround: heightAboveGroundRampTop(source.heightAboveGround) }),
      ...(source.intensity === undefined ? {} : { intensityRange: intensityRange(source.intensity) }),
    });
    this.material.setHasRgb(source.supportsColorMode("rgb"));
    this.material.setSizeMode(this.sizeMode);
    this.material.setPixelRatio(this.renderer.getPixelRatio());
    this.material.setNoiseDisplay(this.noiseDisplay);
    this.applyFlightLineFilter();
    this.hasRgb = source.supportsColorMode("rgb");
    this.hasClassification = source.supportsColorMode("classification");
    this.hasHeightAboveGround = source.supportsColorMode("heightAboveGround");
    this.hasIntensity = source.supportsColorMode("intensity");
    this.hasObjects = source.supportsColorMode("objects");
    this.hasFlightLines = source.supportsColorMode("flightLine");

    const material = this.material;
    this.spacings = new WeakMap();
    for (const tile of tiled.tiles) {
      for (const tier of tile.pyramid.tiers) this.spacings.set(tier.cloud, pointSpacing(tile.bounds, tier.cloud.pointCount));
      const points = new Points(this.emptyGeometry, material);
      points.visible = this.pointsVisible;
      const state: TileRenderState = { id: tile.id, bounds: tile.bounds, points, activeTier: undefined };
      points.onBeforeRender = () => {
        const tier = state.activeTier;
        material.setTile(tier === undefined ? 1 : this.spacingOf(tier.cloud), this.lodDebug && tier !== undefined ? this.tintFor(tier.id) : undefined);
      };
      this.scene.add(points);
      this.tileStates.set(tile.id, state);
    }
    this.tileBoxesStale = true;
  }

  /** How dots are sized: by the spacing of their points in the world, or the same pixels everywhere. */
  public setPointSizeMode(mode: PointSizeMode): void {
    this.sizeMode = mode;
    this.material?.setSizeMode(mode);
  }

  /**
   * The level-of-detail view: each tile tinted by the tier it draws, with its
   * bounding box in the same colour, to see where detail goes as the camera
   * moves and the budget changes.
   */
  public setLodDebug(enabled: boolean): void {
    this.lodDebug = enabled;
    this.tileBoxesStale = true;
  }

  private tintFor(tierId: string): Color {
    let tint = this.tierTints.get(tierId);
    if (tint === undefined) {
      tint = new Color(otherTierColor);
      this.tierTints.set(tierId, tint);
    }
    return tint;
  }

  private spacingOf(cloud: PointCloud): number {
    return this.spacings.get(cloud) ?? pointSpacing(cloud.bounds, cloud.pointCount);
  }

  /** Every tile's bounding box as twelve edges in its tier's colour, rebuilt when a tile changes tier. */
  private updateTileBoxes(): void {
    if (!this.tileBoxesStale) return;
    this.tileBoxesStale = false;
    if (this.tileBoxes !== undefined) {
      this.scene.remove(this.tileBoxes);
      this.tileBoxes.geometry.dispose();
      this.tileBoxes = undefined;
    }
    if (!this.lodDebug || this.tileStates.size === 0) return;
    const positions: number[] = [];
    const colors: number[] = [];
    for (const state of this.tileStates.values()) {
      const { min, max } = state.bounds;
      const tint = this.tintFor(state.activeTier?.id ?? "");
      const corner = (i: number): [number, number, number] => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
      for (const [a, b] of boxEdges) {
        positions.push(...corner(a), ...corner(b));
        colors.push(tint.r, tint.g, tint.b, tint.r, tint.g, tint.b);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(Float32Array.from(positions), 3));
    geometry.setAttribute("color", new BufferAttribute(Float32Array.from(colors), 3));
    this.tileBoxes = new LineSegments(geometry, this.tileBoxMaterial);
    this.tileBoxes.frustumCulled = false;
    this.tileBoxes.renderOrder = 10;
    this.scene.add(this.tileBoxes);
  }

  /** Distributes `pointBudget` across tiles and applies each tile's resulting tier. */
  public applyPointBudget(pointBudget: number, tiled: TiledPointCloudLodPyramid): void {
    for (const selection of tiled.selectForPointBudget(pointBudget)) this.applyTileTier(selection.tile.id, selection.tier);
  }

  /**
   * Applies each tile's tier from how far apart its points would sit on
   * screen: the leanest tier whose gaps stay within `maxGapPixels`, and the
   * leanest of all for a tile out of view.
   */
  public applyScreenSpaceLod(tiled: TiledPointCloudLodPyramid, maxGapPixels: number, pointBudget: number): void {
    if (!(this.camera instanceof PerspectiveCamera)) return;
    const camera = this.camera;
    this.updateFrustum();
    const cssHeight = this.renderer.getDrawingBufferSize(this.drawingSize).y / this.renderer.getPixelRatio();
    const selections = tiled.selectForScreenSpace({
      cameraX: camera.position.x,
      cameraY: camera.position.y,
      cameraZ: camera.position.z,
      pixelsPerUnit: cssHeight / (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2)),
      maxGapPixels,
      pointBudget,
      inView: (bounds) => this.inView(bounds),
    });
    for (const selection of selections) this.applyTileTier(selection.tile.id, selection.tier);
  }

  /** The detail level each tile is drawing right now - what is actually on screen. */
  public drawnClouds(): PointCloud[] {
    const clouds: PointCloud[] = [];
    for (const state of this.tileStates.values()) if (state.activeTier !== undefined) clouds.push(state.activeTier.cloud);
    return clouds;
  }

  private updateFrustum(): void {
    this.camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
  }

  private inView(bounds: PointCloudBounds): boolean {
    return this.frustum.intersectsBox(this.box.set(this.boxMin.set(...bounds.min), this.boxMax.set(...bounds.max)));
  }

  /** Reports the currently rendered tiers - independent of which apply method was last called. */
  public getRenderSummary(cameraX: number, cameraY: number, cameraZ: number, tiled: TiledPointCloudLodPyramid): LodRenderSummary {
    let drawnPointCount = 0;
    let focusTierId: string | undefined;
    let focusDistance = Number.POSITIVE_INFINITY;
    this.updateFrustum();
    const usage = new Map<string, { id: string; voxelSize: number; spacing: number; tiles: number; points: number }>();
    for (const tier of tiled.tiles[0]?.pyramid.tiers ?? []) usage.set(tier.id, { id: tier.id, voxelSize: tier.voxelSize, spacing: 0, tiles: 0, points: 0 });
    for (const state of this.tileStates.values()) {
      const tier = state.activeTier;
      if (tier !== undefined) {
        const entry = usage.get(tier.id) ?? { id: tier.id, voxelSize: tier.voxelSize, spacing: 0, tiles: 0, points: 0 };
        // A mean over the tiles, weighted by points, so a sliver of a tile at the scan's edge does not skew it.
        entry.spacing = (entry.spacing * entry.points + this.spacingOf(tier.cloud) * tier.cloud.pointCount) / Math.max(1, entry.points + tier.cloud.pointCount);
        entry.tiles += 1;
        entry.points += tier.cloud.pointCount;
        usage.set(tier.id, entry);
      }
      drawnPointCount += state.activeTier?.cloud.pointCount ?? 0;
      // The nearest tile the camera can see: one behind it is drawn at its lightest and says nothing of the view.
      const distance = distanceToBounds(cameraX, cameraY, cameraZ, state.bounds);
      if (distance < focusDistance && this.inView(state.bounds)) {
        focusDistance = distance;
        focusTierId = state.activeTier?.id;
      }
    }
    return { tileCount: this.tileStates.size, drawnPointCount, totalPointCount: tiled.totalPointCount, focusTierId, tiers: [...usage.values()] };
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
      (mode === "intensity" && !this.hasIntensity) ||
      (mode === "classification" && !this.hasClassification) ||
      (mode === "heightAboveGround" && !this.hasHeightAboveGround) ||
      (mode === "objects" && !this.hasObjects) ||
      (mode === "flightLine" && !this.hasFlightLines);
    const supportedMode = unsupported ? "height" : mode;
    this.reliefEnabled = supportedMode === "relief";
    this.material?.setColorMode(supportedMode);
    this.flightLineMode = supportedMode === "flightLine";
    this.applyFlightLineFilter();
  }

  public setSize(width: number, height: number): void {
    this.eyeDome?.setSize(width, height);
    this.outlines.setResolution(width, height);
    this.terrain.setResolution(width, height);
    this.annotations.setResolution(width, height, this.renderer.getPixelRatio());
    this.material?.setPixelRatio(this.renderer.getPixelRatio());
  }

  /**
   * The terrain surface and contour lines; undefined clears them. They belong
   * to the scan rather than to a particular version of its cloud, so replacing
   * the cloud leaves them in place.
   */
  public setTerrain(model: TerrainModel | undefined, contours: ContourSet | undefined): void {
    this.terrain.setTerrain(model, contours);
  }

  public setTerrainVisibility(surface: boolean, contours: boolean): void {
    this.terrain.setVisibility(surface, contours);
  }

  /** Hides the points, to look at the terrain or the outlines on their own. */
  public setNoiseDisplay(display: NoiseDisplay): void {
    this.noiseDisplay = display;
    this.material?.setNoiseDisplay(display);
  }

  /**
   * Flight lines to leave out while the scan is coloured by flight line. The
   * choice is made in that view, from its legend, so it applies only there;
   * every other view draws every line.
   */
  public setHiddenFlightLines(hidden: ReadonlySet<number>): void {
    this.hiddenFlightLines = hidden;
    this.applyFlightLineFilter();
  }

  /** The flight lines not on screen right now, if any are left out. */
  public getHiddenFlightLines(): ReadonlySet<number> | undefined {
    return this.flightLineMode && this.hiddenFlightLines.size > 0 ? this.hiddenFlightLines : undefined;
  }

  private applyFlightLineFilter(): void {
    this.material?.setHiddenFlightLines(this.getHiddenFlightLines() ?? new Set());
  }

  public getNoiseDisplay(): NoiseDisplay {
    return this.noiseDisplay;
  }

  public setPointsVisible(visible: boolean): void {
    this.pointsVisible = visible;
    for (const state of this.tileStates.values()) state.points.visible = visible;
  }

  /** Picked points and measurements. They belong to the view, not the cloud, so a new cloud keeps them. */
  public setAnnotations(annotations: Annotations): void {
    this.annotations.setAnnotations(annotations);
  }

  /** What the cursor is about to do, drawn over the annotations; undefined clears it. */
  public setAnnotationPreview(preview: Annotations | undefined): void {
    this.annotations.setPreview(preview);
  }

  /** Lights up the handle with this id. */
  public setAnnotationHighlight(id: string | undefined): void {
    this.annotations.setHighlight(id);
  }

  /** Radius in drawing-surface pixels of the dot drawn for a point of this cloud at this depth. */
  public dotRadius(depth: number, cloud: PointCloud): number {
    return this.material?.dotRadius(depth, this.spacingOf(cloud)) ?? this.maxDotRadius();
  }

  /** The largest a dot's radius can be, in drawing-surface pixels. */
  public maxDotRadius(): number {
    return this.material?.maxDotRadius() ?? (maxDotSize * this.renderer.getPixelRatio()) / 2;
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
    if (this.material !== undefined && this.camera instanceof PerspectiveCamera) {
      const height = this.renderer.getDrawingBufferSize(this.drawingSize).y;
      this.material.setPixelsPerUnit(height / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2)));
    }
    this.updateTileBoxes();
    if (!this.reliefEnabled) {
      this.renderer.render(this.scene, this.camera);
      this.drawDepthTestedLines();
      this.annotations.render(this.renderer, this.camera);
      return;
    }
    if (this.eyeDome === undefined) {
      this.eyeDome = new EyeDomeLighting(this.renderer);
      const size = this.renderer.getDrawingBufferSize(new Vector2());
      this.eyeDome.setSize(size.x, size.y);
      this.eyeDome.setStrength(viewerConfig().eyeDomeLighting.strength);
      this.eyeDome.setRadius(viewerConfig().eyeDomeLighting.radius);
    }
    // Outlines are depth tested, so they go into the lighting pass while the
    // points' depth is still bound; the screen itself holds no depth for them.
    this.eyeDome.render(this.scene, this.camera, () => this.drawDepthTestedLines());
    this.annotations.render(this.renderer, this.camera);
  }

  /** Lines laid on the scan, which must be drawn while its depth is still bound. */
  private drawDepthTestedLines(): void {
    this.terrain.renderContours(this.renderer, this.camera);
    this.outlines.render(this.renderer, this.camera);
  }

  public dispose(): void {
    this.disposeCloudResources();
    this.terrain.dispose();
    this.outlines.dispose();
    this.annotations.dispose();
    this.emptyGeometry.dispose();
    this.tileBoxes?.geometry.dispose();
    this.tileBoxMaterial.dispose();
    this.eyeDome?.dispose();
    this.eyeDome = undefined;
  }

  private applyTileTier(tileId: string, nextTier: PointCloudLodTier): void {
    const state = this.tileStates.get(tileId);
    if (state === undefined || state.activeTier?.id === nextTier.id) return;
    state.points.geometry = this.geometryFor(tileId, nextTier);
    state.activeTier = nextTier;
    this.tileBoxesStale = true;
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
    this.hasFlightLines = false;
    this.outlines.setObjects(undefined);
  }
}

/** The twelve edges of a box, as pairs of corner indices where bit 0 is x, bit 1 y and bit 2 z. */
const boxEdges = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
] as const;

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
  if (cloud.intensity !== undefined) {
    geometry.setAttribute("intensity", new BufferAttribute(cloud.intensity, 1));
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
  if (cloud.pointSourceId !== undefined) {
    geometry.setAttribute("pointSourceId", new BufferAttribute(cloud.pointSourceId, 1, false));
  }
  geometry.computeBoundingSphere();
  return geometry;
}
