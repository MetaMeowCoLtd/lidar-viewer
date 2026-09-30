import { defaultNoiseDetectionOptions, type NoiseDetectionOptions } from "./core/noise-detection.js";
import type { PointCloudPointShape } from "./core/point-cloud.js";
import { defaultGroundDetectionOptions, type GroundDetectionOptions } from "./core/ground-detection.js";
import { defaultObjectDetectionOptions, type ObjectDetectionOptions } from "./core/object-detection.js";
import { defaultTerrainOptions, type TerrainOptions } from "./core/terrain.js";

/** How many lighter levels are built below full resolution, and the share of points each keeps of the one above. */
export interface LodLevelsConfig {
  readonly count: number;
  readonly pointFraction: number;
}

export interface PointSizeConfig {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export interface EyeDomeLightingConfig {
  readonly strength: number;
  readonly radius: number;
}

export interface CameraConfig {
  readonly fieldOfView: number;
  readonly framingDistance: number;
}

export interface DistanceLodConfig {
  /** Whether camera-distance-driven LOD selection starts enabled instead of the manual point budget. */
  readonly enabledByDefault: boolean;
  /**
   * The widest gap between neighbouring points on screen, in CSS pixels,
   * before a tile switches to a finer tier: the default, and the range the
   * Display menu offers.
   */
  readonly maxGapPixels: { readonly default: number; readonly min: number; readonly max: number };
}

export interface TilingConfig {
  /** Whether the dataset is partitioned into spatial tiles before LOD is applied. */
  readonly enabled: boolean;
  /** Tile edges are sized so a tile holds roughly this many points. */
  readonly targetPointsPerTile: number;
  /** Upper bound on the LOD build workers started for a load. */
  readonly buildWorkers: number;
}

export interface ViewerConfig {
  /**
   * The most points a scan loads with. Larger scans are thinned evenly to this
   * many, because every loaded point costs memory several times over - the
   * cloud, its tiles and their detail levels - and a tab that runs out of
   * memory simply crashes.
   */
  readonly maxImportPoints: number;
  readonly defaultPointBudget: number;
  readonly pointShape: PointCloudPointShape;
  readonly pointSize: PointSizeConfig;
  readonly lodLevels: LodLevelsConfig;
  readonly eyeDomeLighting: EyeDomeLightingConfig;
  readonly camera: CameraConfig;
  readonly distanceLod: DistanceLodConfig;
  readonly tiling: TilingConfig;
  /** Points allowed to stay resident in GPU buffers before unused tiers are released. */
  readonly gpuPointBudget: number;
  /** Ground detection tuning, in the scan's units; see {@link GroundDetectionOptions}. */
  readonly groundDetection: GroundDetectionOptions;
  /** Building and tree detection tuning, in the scan's units; see {@link ObjectDetectionOptions}. */
  readonly objectDetection: ObjectDetectionOptions;
  /** Terrain model grid, in the scan's units; see {@link TerrainOptions}. */
  readonly terrain: TerrainOptions;
  /** Noise tests, in the scan's units; see {@link NoiseDetectionOptions}. */
  readonly noiseDetection: NoiseDetectionOptions;
}

const fallback: ViewerConfig = {
  maxImportPoints: 60_000_000,
  defaultPointBudget: 1_000_000,
  pointShape: "circle",
  pointSize: { default: 2.4, min: 1, max: 7 },
  lodLevels: { count: 5, pointFraction: 0.25 },
  eyeDomeLighting: { strength: 40, radius: 1.4 },
  camera: { fieldOfView: 55, framingDistance: 1.15 },
  distanceLod: {
    enabledByDefault: false,
    maxGapPixels: { default: 2, min: 0.5, max: 12 },
  },
  tiling: { enabled: true, targetPointsPerTile: 100_000, buildWorkers: 16 },
  gpuPointBudget: 40_000_000,
  groundDetection: defaultGroundDetectionOptions,
  objectDetection: defaultObjectDetectionOptions,
  terrain: defaultTerrainOptions,
  noiseDetection: defaultNoiseDetectionOptions,
};

let active: ViewerConfig = fallback;

export function viewerConfig(): ViewerConfig {
  return active;
}

export async function loadViewerConfig(): Promise<ViewerConfig> {
  try {
    const response = await fetch("viewer-config.json", { cache: "no-cache" });
    if (response.ok) {
      const parsed = (await response.json()) as Partial<ViewerConfig>;
      active = {
        ...fallback,
        ...parsed,
        pointSize: { ...fallback.pointSize, ...parsed.pointSize },
        lodLevels: { ...fallback.lodLevels, ...parsed.lodLevels },
        eyeDomeLighting: { ...fallback.eyeDomeLighting, ...parsed.eyeDomeLighting },
        camera: { ...fallback.camera, ...parsed.camera },
        distanceLod: {
          ...fallback.distanceLod,
          ...parsed.distanceLod,
          maxGapPixels: { ...fallback.distanceLod.maxGapPixels, ...parsed.distanceLod?.maxGapPixels },
        },
        tiling: { ...fallback.tiling, ...parsed.tiling },
        groundDetection: { ...fallback.groundDetection, ...parsed.groundDetection },
        objectDetection: { ...fallback.objectDetection, ...parsed.objectDetection },
        terrain: { ...fallback.terrain, ...parsed.terrain },
        noiseDetection: { ...fallback.noiseDetection, ...parsed.noiseDetection },
      };
    }
  } catch {
    active = fallback;
  }
  return active;
}
