export interface LodDivisors {
  readonly fine: number;
  readonly balanced: number;
  readonly lean: number;
}

export interface ViewerConfig {
  readonly maxImportSizeMb: number;
  readonly defaultPointBudget: number;
  readonly lodDivisors: LodDivisors;
}

const fallback: ViewerConfig = {
  maxImportSizeMb: 500,
  defaultPointBudget: 1_000_000,
  lodDivisors: { fine: 900, balanced: 350, lean: 130 },
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
        lodDivisors: { ...fallback.lodDivisors, ...parsed.lodDivisors },
      };
    }
  } catch {
    active = fallback;
  }
  return active;
}
