import { Icon } from "./icons.js";
import { themeLabels, useTheme } from "./theme.js";

/** One button that steps through following the system, light and dark, showing which is in force. */
export function ThemeToggle() {
  const { preference, cycle } = useTheme();
  const icon = preference === "light" ? "sun" : preference === "dark" ? "moon" : "monitor";
  return (
    <button type="button" className="icon-btn theme-toggle" title={`${themeLabels[preference]} - click to change`} aria-label={themeLabels[preference]} onClick={cycle}>
      <Icon name={icon} />
    </button>
  );
}
