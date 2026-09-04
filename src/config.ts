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

export interface ViewerConfig {
  readonly backgroundColor: string;
  readonly maxImportSizeMb: number;
  readonly defaultPointBudget: number;
  readonly pointSize: PointSizeConfig;
  readonly lodDivisors: LodDivisors;
  readonly eyeDomeLighting: EyeDomeLightingConfig;
  readonly camera: CameraConfig;
}

const fallback: ViewerConfig = {
  backgroundColor: "#000000",
  maxImportSizeMb: 1200,
  defaultPointBudget: 1_000_000,
  pointSize: { default: 2.4, min: 1, max: 7 },
  lodDivisors: { fine: 900, balanced: 350, lean: 130 },
  eyeDomeLighting: { strength: 40, radius: 1.4 },
  camera: { fieldOfView: 55, framingDistance: 1.15, damping: 0.08 },
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
      };
    }
  } catch {
    active = fallback;
  }
  document.documentElement.style.setProperty("--viewer-background", active.backgroundColor);
  return active;
}
