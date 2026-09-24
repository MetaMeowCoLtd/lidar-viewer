import { useCallback, useEffect, useState } from "react";

/** What the user asked for: follow the system, or always light, or always dark. */
export type ThemePreference = "system" | "light" | "dark";

const storageKey = "vertex-lidar-theme";

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the system theme is a fine default.
  }
  return "system";
}

/**
 * Puts the preference on the root element. Following the system leaves the
 * attribute off, so the stylesheet's prefers-color-scheme query decides; an
 * explicit choice sets it, and the tokens for that theme win.
 */
export function applyTheme(preference: ThemePreference = readPreference()): void {
  if (preference === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
}

const order: readonly ThemePreference[] = ["system", "light", "dark"];

/** The theme preference, and a way to step through system, light and dark. */
export function useTheme(): { preference: ThemePreference; setPreference: (next: ThemePreference) => void; cycle: () => void } {
  const [preference, setState] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    applyTheme(preference);
    try {
      window.localStorage.setItem(storageKey, preference);
    } catch {
      // Not remembered, but still applied for this visit.
    }
  }, [preference]);

  const cycle = useCallback(() => setState((current) => order[(order.indexOf(current) + 1) % order.length]!), []);
  return { preference, setPreference: setState, cycle };
}

export const themeLabels: Record<ThemePreference, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };
