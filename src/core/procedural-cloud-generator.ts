import { PointCloud } from "./point-cloud.js";

export interface ProceduralCloudOptions {
  readonly pointCount?: number;
  readonly seed?: number;
  readonly width?: number;
  readonly depth?: number;
  readonly name?: string;
}

/**
 * Generates an intentionally non-flat terrain/structure hybrid for renderer
 * development when a real scan is unavailable. It is deterministic per seed.
 */
export class ProceduralCloudGenerator {
  public generate(options: ProceduralCloudOptions = {}): PointCloud {
    const pointCount = options.pointCount ?? 500_000;
    const width = options.width ?? 80;
    const depth = options.depth ?? 80;
    if (!Number.isSafeInteger(pointCount) || pointCount < 1) throw new Error("pointCount must be a positive integer");
    if (width <= 0 || depth <= 0) throw new Error("width and depth must be positive");

    const random = mulberry32(options.seed ?? 0x1d4a11);
    const positions = new Float32Array(pointCount * 3);
    const colors = new Uint8Array(pointCount * 3);

    for (let point = 0, offset = 0; point < pointCount; point += 1, offset += 3) {
      const x = (random() - 0.5) * width;
      const z = (random() - 0.5) * depth;
      const ridge = Math.sin(x * 0.17) * 3 + Math.cos(z * 0.13) * 2;
      const mound = 9 * Math.exp(-((x - 13) ** 2 + (z + 7) ** 2) / 180);
      const building = x > -18 && x < -4 && z > -10 && z < 14 ? 6.5 : 0;
      const y = ridge + mound + building + (random() - 0.5) * 0.18;
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;

      const normalizedHeight = Math.max(0, Math.min(1, (y + 7) / 25));
      colors[offset] = Math.round(30 + normalizedHeight * 155);
      colors[offset + 1] = Math.round(70 + normalizedHeight * 140);
      colors[offset + 2] = Math.round(145 + normalizedHeight * 100);
    }

    return new PointCloud({ positions, colors, name: options.name ?? "procedural-terrain" });
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
