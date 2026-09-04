import { PointCloud } from "./point-cloud.js";
import { PointCloudLodPyramid } from "./lod-pyramid.js";
import type { LodBuildRequest, LodBuildResponse, SerializedTier } from "./lod-build-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LodBuildRequest>) => void) | null;
  postMessage: (message: LodBuildResponse, transfer: ArrayBuffer[]) => void;
};

scope.onmessage = (event: MessageEvent<LodBuildRequest>) => {
  const { tileId, name, positions, colors, intensity, specs } = event.data;
  const cloud = new PointCloud({
    positions,
    ...(colors === undefined ? {} : { colors }),
    ...(intensity === undefined ? {} : { intensity }),
    name,
  });
  const pyramid = PointCloudLodPyramid.build(cloud, specs);

  const transfer: ArrayBuffer[] = [];
  const tiers: SerializedTier[] = pyramid.tiers.map((tier) => {
    transfer.push(tier.cloud.positions.buffer as ArrayBuffer);
    if (tier.cloud.colors !== undefined) transfer.push(tier.cloud.colors.buffer as ArrayBuffer);
    if (tier.cloud.intensity !== undefined) transfer.push(tier.cloud.intensity.buffer as ArrayBuffer);
    return {
      id: tier.id,
      voxelSize: tier.voxelSize,
      name: tier.cloud.name,
      positions: tier.cloud.positions,
      bounds: tier.cloud.bounds,
      ...(tier.cloud.colors === undefined ? {} : { colors: tier.cloud.colors }),
      ...(tier.cloud.intensity === undefined ? {} : { intensity: tier.cloud.intensity }),
      ...(tier.minCameraDistance === undefined ? {} : { minCameraDistance: tier.minCameraDistance }),
    };
  });

  const response: LodBuildResponse = { tileId, tiers };
  scope.postMessage(response, transfer);
};
