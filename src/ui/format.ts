/** Number formatting shared by every part of the interface, so a length reads the same wherever it appears. */

export function formatNumber(value: number, digits: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatCoordinate(value: number): string {
  return formatNumber(value, 2);
}

export function formatLength(metres: number): string {
  return `${formatNumber(metres, 2)} m`;
}

/**
 * A height for a summary or a key: one decimal below ten metres, whole metres
 * above. The height ramp is square-root scaled, so its midpoint label sits at a
 * quarter of the top height rather than half of it.
 */
export function formatRampHeight(metres: number): string {
  return `${metres < 10 ? metres.toFixed(1) : Math.round(metres)} m`;
}

export function formatShare(count: number, total: number): string {
  const share = (count / total) * 100;
  if (share >= 10) return `${Math.round(share)}%`;
  if (share >= 1) return `${share.toFixed(1)}%`;
  return share > 0 ? "<1%" : "0%";
}

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/**
 * Positions are held relative to the cloud's origin so a projected coordinate
 * never has to survive a narrowing to Float32. Showing that offset is how a
 * user confirms a scan was recognised as georeferenced rather than local.
 */
export function formatOrigin(cloud: { origin: readonly [number, number, number]; isGeoreferenced: boolean }): string {
  if (!cloud.isGeoreferenced) return "Local";
  return cloud.origin.map((value) => value.toLocaleString("en-US", { maximumFractionDigits: 0 })).join(" / ");
}

export function ordinalSuffix(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return "th";
  return ["th", "st", "nd", "rd"][value % 10] ?? "th";
}
