import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { PointCloud } from "../core/point-cloud.js";
import { viewerConfig } from "../config.js";
import { readBinaryPly } from "./binary-ply-reader.js";

/** Converts a local PLY export into the core's tightly packed point-cloud contract. */
export async function importPlyFile(file: File): Promise<PointCloud> {
  if (!file.name.toLowerCase().endsWith(".ply")) {
    throw new Error("Select a .ply point-cloud file");
  }
  if (file.size === 0) throw new Error("The selected PLY file is empty");
  const maxImportSizeMb = viewerConfig().maxImportSizeMb;
  if (file.size > maxImportSizeMb * 1024 * 1024) {
    throw new Error(`This demo accepts PLY files up to ${maxImportSizeMb} MB. Larger scans need the planned streaming pipeline.`);
  }

  const name = file.name.replace(/\.ply$/i, "");
  const buffer = await file.arrayBuffer();
  const fastPath = readBinaryPly(buffer, name);
  if (fastPath !== undefined) return fastPath;

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

  for (let point = 0, offset = 0; point < position.count; point += 1, offset += 3) {
    positions[offset] = position.getX(point);
    positions[offset + 1] = position.getY(point);
    positions[offset + 2] = position.getZ(point);
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
    name,
  });
}

function asByte(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}
