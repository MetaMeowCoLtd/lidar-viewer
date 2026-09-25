/**
 * The colour of a flight line, shared by the shader that draws it and the
 * legend that names it. Hues advance by the golden ratio, so lines numbered
 * one after the other - neighbouring passes, as a drone flies them - land far
 * apart on the colour wheel, and their overlap reads as a speckle of both.
 */
export const flightLineHueStep = 0.6180339887;
export const flightLineSaturation = 0.72;
export const flightLineLightness = 0.56;

export function flightLineHue(id: number): number {
  const turn = id * flightLineHueStep;
  return turn - Math.floor(turn);
}

/** The CSS colour of a flight line, matching the shader's. */
export function flightLineCss(id: number): string {
  return `hsl(${(flightLineHue(id) * 360).toFixed(1)} ${flightLineSaturation * 100}% ${flightLineLightness * 100}%)`;
}
