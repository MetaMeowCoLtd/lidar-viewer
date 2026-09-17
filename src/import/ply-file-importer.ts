import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { PointCloud, chooseOrigin } from "../core/point-cloud.js";
import { readBinaryPly } from "./binary-ply-reader.js";
import type { ByteSource } from "./byte-source.js";
import type { ReadProgress } from "./las-reader.js";

/**
 * ASCII and big-endian PLY go through Three's PLYLoader, which needs the whole
 * file in memory and builds plain arrays several times its size; past this the
 * tab runs out of memory before the loader finishes.
 */
const maxFallbackBytes = 512 * 1024 * 1024;

/** Reads a PLY scan: binary little-endian by streaming, anything else through Three's loader. */
export async function readPly(source: ByteSource, name: string, onProgress?: ReadProgress): Promise<PointCloud> {
  const fastPath = await readBinaryPly(source, name, onProgress);
  if (fastPath !== undefined) return fastPath;
  if (source.size > maxFallbackBytes) {
    throw new Error("PLY files over 512 MB need to be binary little-endian. Convert it, for example with CloudCompare, and load it again.");
  }
  const whole = await source.read(0, source.size);
  const buffer = whole.byteOffset === 0 && whole.byteLength === whole.buffer.byteLength ? whole.buffer : whole.slice().buffer;
  const cloud = parsePlyWithLoader(buffer as ArrayBuffer, name);
  onProgress?.(1);
  return cloud;
}

function parsePlyWithLoader(buffer: ArrayBuffer, name: string): PointCloud {
  const geometry = new PLYLoader().parse(buffer);
  const position = geometry.getAttribute("position");
  if (position === undefined || position.itemSize < 3 || position.count === 0) {
    throw new Error("The PLY file does not contain vertex positions");
  }

  const color = geometry.getAttribute("color");
  const intensity = geometry.getAttribute("intensity") ?? geometry.getAttribute("scalar_Intensity");
  const positions = new Float32Array(position.count * 3);
  const colors = color === undefined ? undefined : new Uint8Array(position.count * 3);
  const intensities = intensity === undefined ? undefined : new Float32Array(position.count);

  // The loader has already narrowed every coordinate to Float32, so precision
  // a georeferenced file carried is gone by this point and anchoring cannot
  // bring it back. Anchor anyway: it keeps the local frame consistent with the
  // fast path, keeps the camera and depth buffer out of six-digit territory,
  // and reports the offset instead of silently discarding it. Files that reach
  // this fallback are the ones the fast path could not parse.
  const origin = chooseOrigin(
    [position.getX(0), position.getY(0), position.getZ(0)],
    [position.getX(position.count - 1), position.getY(position.count - 1), position.getZ(position.count - 1)],
  );

  for (let point = 0, offset = 0; point < position.count; point += 1, offset += 3) {
    positions[offset] = position.getX(point) - origin[0];
    positions[offset + 1] = position.getY(point) - origin[1];
    positions[offset + 2] = position.getZ(point) - origin[2];
    if (color !== undefined && colors !== undefined) {
      colors[offset] = asByte(color.getX(point));
      colors[offset + 1] = asByte(color.getY(point));
      colors[offset + 2] = asByte(color.getZ(point));
    }
    if (intensity !== undefined && intensities !== undefined) intensities[point] = intensity.getX(point);
  }
  geometry.dispose();
  return new PointCloud({
    positions,
    ...(colors === undefined ? {} : { colors }),
    ...(intensities === undefined ? {} : { intensity: intensities }),
    origin,
    name,
  });
}

function asByte(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}
