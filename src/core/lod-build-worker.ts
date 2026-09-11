import { PointCloud, definedChannels, pointCloudChannelNames } from "./point-cloud.js";
import { PointCloudLodPyramid } from "./lod-pyramid.js";
import type { LodBuildRequest, LodBuildResponse, SerializedTier } from "./lod-build-protocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LodBuildRequest>) => void) | null;
  postMessage: (message: LodBuildResponse, transfer: ArrayBuffer[]) => void;
};

scope.onmessage = (event: MessageEvent<LodBuildRequest>) => {
  const { tileId, name, positions, origin, specs } = event.data;
  const cloud = new PointCloud({ positions, ...definedChannels(event.data), origin, name });
  const pyramid = PointCloudLodPyramid.build(cloud, specs);

  const transfer: ArrayBuffer[] = [];
  const tiers: SerializedTier[] = pyramid.tiers.map((tier) => {
    transfer.push(tier.cloud.positions.buffer as ArrayBuffer);
    for (const name of pointCloudChannelNames) {
      const channel = tier.cloud[name];
      if (channel !== undefined) transfer.push(channel.buffer as ArrayBuffer);
    }
    return {
      id: tier.id,
      voxelSize: tier.voxelSize,
      name: tier.cloud.name,
      positions: tier.cloud.positions,
      bounds: tier.cloud.bounds,
      origin: tier.cloud.origin,
      ...definedChannels(tier.cloud),
      ...(tier.minCameraDistance === undefined ? {} : { minCameraDistance: tier.minCameraDistance }),
    };
  });

  const response: LodBuildResponse = { tileId, tiers };
  scope.postMessage(response, transfer);
};
