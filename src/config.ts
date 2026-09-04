import type { PointCloudPointShape } from "./core/point-cloud.js";

export interface LodDivisors {
  readonly fine: number;
  readonly balanced: number;
  readonly lean: number;
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
  readonly damping: number;
}

export interface DistanceLodThresholds {
  readonly full: number;
  readonly fine: number;
  readonly balanced: number;
  readonly lean: number;
}

export interface DistanceLodConfig {
  /** Whether camera-distance-driven LOD selection starts enabled instead of the manual point budget. */
  readonly enabledByDefault: boolean;
  /**
   * Multipliers of the cloud's bounding diagonal at which each tier becomes
   * preferred as the camera moves away. Must be non-decreasing for a sane
   * near-to-far progression (full detail up close, coarser tiers far away).
   */
  readonly distanceMultipliers: DistanceLodThresholds;
}

export interface TilingConfig {
  /** Whether the dataset is partitioned into spatial tiles before LOD is applied. */
  readonly enabled: boolean;
  /** World-space edge length of one square XZ tile column. */
  readonly tileSize: number;
}

export interface ViewerConfig {
  readonly backgroundColor: string;
  readonly maxImportSizeMb: number;
  readonly defaultPointBudget: number;
  readonly pointShape: PointCloudPointShape;
  readonly pointSize: PointSizeConfig;
  readonly lodDivisors: LodDivisors;
  readonly eyeDomeLighting: EyeDomeLightingConfig;
  readonly camera: CameraConfig;
  readonly distanceLod: DistanceLodConfig;
  readonly tiling: TilingConfig;
}

const fallback: ViewerConfig = {
  backgroundColor: "#000000",
  maxImportSizeMb: 1200,
  defaultPointBudget: 1_000_000,
  pointShape: "circle",
  pointSize: { default: 2.4, min: 1, max: 7 },
  lodDivisors: { fine: 900, balanced: 350, lean: 130 },
  eyeDomeLighting: { strength: 40, radius: 1.4 },
  camera: { fieldOfView: 55, framingDistance: 1.15, damping: 0.08 },
  distanceLod: {
    enabledByDefault: false,
    distanceMultipliers: { full: 0, fine: 0.5, balanced: 1.2, lean: 2.5 },
  },
  tiling: { enabled: true, tileSize: 25 },
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
        lodDivisors: { ...fallback.lodDivisors, ...parsed.lodDivisors },
        eyeDomeLighting: { ...fallback.eyeDomeLighting, ...parsed.eyeDomeLighting },
        camera: { ...fallback.camera, ...parsed.camera },
        distanceLod: {
          ...fallback.distanceLod,
          ...parsed.distanceLod,
          distanceMultipliers: {
            ...fallback.distanceLod.distanceMultipliers,
            ...parsed.distanceLod?.distanceMultipliers,
          },
        },
        tiling: { ...fallback.tiling, ...parsed.tiling },
      };
    }
  } catch {
    active = fallback;
  }
  document.documentElement.style.setProperty("--viewer-background", active.backgroundColor);
  return active;
}
