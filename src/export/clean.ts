import { PointCloud, pointCloudChannelNames, type PointCloudAttributes } from "../core/point-cloud.js";
import { isNoiseClass } from "../core/noise-detection.js";

/**
 * The cloud without the points labelled as noise, every channel carried
 * across - what a "cleaned" deliverable is. The scan in the viewer keeps its
 * noise, labelled, so the decision can always be revisited.
 */
export function withoutNoise(cloud: PointCloud): PointCloud {
  const classification = cloud.classification;
  if (classification === undefined) return cloud;
  let kept = 0;
  for (let point = 0; point < cloud.pointCount; point += 1) if (!isNoiseClass(classification[point]!)) kept += 1;
  if (kept === cloud.pointCount) return cloud;

  const positions = new Float32Array(kept * 3);
  const channels: Record<string, ArrayLike<number> & { length: number }> = {};
  const targets: Record<string, { set(index: number, value: number): void; array: PointCloudAttributes[keyof PointCloudAttributes]; width: number }> = {};
  for (const name of pointCloudChannelNames) {
    const source = cloud[name];
    if (source === undefined) continue;
    const width = source.length / cloud.pointCount;
    const Constructor = source.constructor as new (length: number) => typeof source;
    const array = new Constructor(kept * width);
    channels[name] = source;
    targets[name] = { array, width, set: (index, value) => ((array as unknown as number[])[index] = value) };
  }
  let target = 0;
  for (let point = 0; point < cloud.pointCount; point += 1) {
    if (isNoiseClass(classification[point]!)) continue;
    positions[target * 3] = cloud.positions[point * 3]!;
    positions[target * 3 + 1] = cloud.positions[point * 3 + 1]!;
    positions[target * 3 + 2] = cloud.positions[point * 3 + 2]!;
    for (const name in targets) {
      const { width, set } = targets[name]!;
      const source = channels[name]!;
      for (let lane = 0; lane < width; lane += 1) set(target * width + lane, source[point * width + lane]!);
    }
    target += 1;
  }
  const attributes: Record<string, unknown> = {};
  for (const name in targets) attributes[name] = targets[name]!.array;
  return new PointCloud({
    positions,
    ...(attributes as PointCloudAttributes),
    origin: cloud.origin,
    spatialReference: cloud.spatialReference,
    name: cloud.name,
  });
}
