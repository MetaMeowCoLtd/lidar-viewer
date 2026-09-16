/**
 * The value below which `fraction` of the entries fall, estimated from an
 * evenly spaced sample so it stays cheap on tens of millions of points.
 *
 * Colour ramps use it as their top end. Scaling to the true maximum lets a
 * single crane or a tall tree squash every building into the bottom of the
 * ramp; the 98th percentile keeps the ramp spent on what the scan is mostly
 * made of.
 */
export function upperPercentile(values: ArrayLike<number>, fraction: number, sampleLimit = 200_000): number {
  if (values.length === 0) return 0;
  if (!(fraction >= 0 && fraction <= 1)) throw new Error("fraction must be between 0 and 1");
  const step = Math.max(1, Math.floor(values.length / sampleLimit));
  const sample: number[] = [];
  for (let index = 0; index < values.length; index += step) sample.push(values[index]!);
  sample.sort((a, b) => a - b);
  return sample[Math.floor(fraction * (sample.length - 1))]!;
}

/**
 * Where the height-above-ground colour ramp tops out, in whole metres. The
 * renderer and the legend both read it from here, so the numbers printed
 * under the key are the ones the shader actually used.
 */
export function heightAboveGroundRampTop(heights: ArrayLike<number>): number {
  return Math.max(1, Math.round(upperPercentile(heights, 0.98)));
}
