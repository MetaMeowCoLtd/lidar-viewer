/** The building blocks every part of the procedural scene is made from. */

export type Random = () => number;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type Vec3 = readonly [number, number, number];

export function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b };
}

/**
 * Something the scanner sees. `weight` is its share of the points - roughly
 * its visible area, scaled by how densely a laser samples that kind of
 * surface - and `emit` places exactly one point on it.
 */
export interface Surface {
  readonly weight: number;
  emit(random: Random, out: PointWriter): void;
}

export class PointWriter {
  public readonly positions: Float32Array;
  public readonly colors: Uint8Array;
  private offset = 0;

  public constructor(count: number) {
    this.positions = new Float32Array(count * 3);
    this.colors = new Uint8Array(count * 3);
  }

  /** Writes one point, its colour darkened or lit by `shade` and roughened by `spread`. */
  public put(x: number, y: number, z: number, colour: Rgb, shade: number, random: Random, spread = 12): void {
    const offset = this.offset;
    this.positions[offset] = x;
    this.positions[offset + 1] = y;
    this.positions[offset + 2] = z;
    this.colors[offset] = clampByte(colour.r * shade + (random() - 0.5) * spread);
    this.colors[offset + 1] = clampByte(colour.g * shade + (random() - 0.5) * spread);
    this.colors[offset + 2] = clampByte(colour.b * shade + (random() - 0.5) * spread);
    this.offset = offset + 3;
  }
}

// Afternoon sun from the north-west, high in the sky (x east, y up, z south).
const lightLength = Math.hypot(0.5, 0.8, 0.4);
const lightX = -0.5 / lightLength;
const lightY = 0.8 / lightLength;
const lightZ = -0.4 / lightLength;

/**
 * How brightly the sun lights a surface facing along a normal. Baking this
 * into the colours is what makes hills, roof pitches and facades read as
 * shapes in the RGB view, the way they do in a real orthophoto-coloured scan.
 */
export function sunShade(nx: number, ny: number, nz: number): number {
  const length = Math.hypot(nx, ny, nz) || 1;
  const facing = (nx * lightX + ny * lightY + nz * lightZ) / length;
  return 0.42 + 0.68 * Math.max(0, facing);
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function jitter(random: Random, spread: number): number {
  return (random() - 0.5) * spread;
}

export function pick<T>(random: Random, items: ReadonlyArray<T>): T {
  return items[Math.floor(random() * items.length)]!;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

/** A cheap, smooth, deterministic field in [0, 1] for patchy grass, forest edges and the like. */
export function patchiness(x: number, z: number): number {
  return 0.5 + 0.25 * Math.sin(x * 0.061 + 1.7 * Math.sin(z * 0.043)) + 0.25 * Math.sin(z * 0.057 + 1.3 * Math.sin(x * 0.037));
}

export function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
