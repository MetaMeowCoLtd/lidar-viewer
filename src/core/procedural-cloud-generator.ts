import { PointCloud, type PointCloudOrigin } from "./point-cloud.js";
import { geoKeyDirectoryRecordId, projectionUserId, spatialReferenceFromRecords, type SpatialReference } from "./spatial-reference.js";
import { simulateSurvey } from "./procedural/lidar-simulator.js";
import { mulberry32 } from "./procedural/sampling.js";

export interface ProceduralCloudOptions {
  readonly pointCount?: number;
  readonly seed?: number;
  readonly name?: string;
  /** Called as the simulated flight progresses, from zero to one. */
  readonly onProgress?: (fraction: number) => void;
}

/** The sample sits in ETRS89 / UTM zone 30N, the way a survey delivered in Spain would. */
export const sampleEpsg = 25830;
/** Map coordinates of the local frame's origin: easting, elevation, and northing negated (z runs south). */
export const sampleOrigin: PointCloudOrigin = [451_200, 610, -4_473_600];

/** The raw channels of a generated sample, ready to cross a worker boundary. */
export interface ProceduralCloudData {
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
  readonly intensity: Float32Array;
  readonly returnNumber: Uint8Array;
  readonly numberOfReturns: Uint8Array;
}

/**
 * A synthetic drone LiDAR survey to open the app with: a 460 × 360 m block
 * over an aggregate quarry, its processing pad and stockpiles, a transmission
 * line through a forest, a plantation, a creek, a farm and a rural road.
 *
 * It is made by simulating the flight rather than by placing points - six
 * overlapping strips from a scanning laser, traced through the site - so it
 * has what real captures have: scan lines, overlap, LiDAR shadows, canopy
 * penetration with multiple returns, sparse hits on conductors, gaps over
 * water, intensity and camera colour. See {@link simulateSurvey}.
 *
 * It is georeferenced (ETRS89 / UTM 30N), so coordinates, exports and the
 * terrain model come out in real map units.
 */
export class ProceduralCloudGenerator {
  public generate(options: ProceduralCloudOptions = {}): PointCloud {
    const data = this.generateData(options);
    return new PointCloud({ ...data, name: options.name ?? "synthetic-quarry-survey", origin: sampleOrigin, spatialReference: sampleSpatialReference() });
  }

  public generateData(options: ProceduralCloudOptions = {}): ProceduralCloudData {
    const pointCount = options.pointCount ?? 1_200_000;
    if (!Number.isSafeInteger(pointCount) || pointCount < 1) throw new Error("pointCount must be a positive integer");
    const survey = simulateSurvey(pointCount, mulberry32(options.seed ?? 0x1d4a11), options.onProgress);
    return {
      positions: survey.positions,
      colors: survey.colors,
      intensity: survey.intensity,
      returnNumber: survey.returnNumber,
      numberOfReturns: survey.numberOfReturns,
    };
  }
}

/** A GeoTIFF key directory naming the sample's projected system, as a LAS file would carry it. */
export function sampleSpatialReference(): SpatialReference | undefined {
  // Version 1.1.0 with four keys: projected model, pixel-is-area, the EPSG system, metres.
  const keys = [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, sampleEpsg, 3076, 0, 1, 9001];
  const data = new Uint8Array(keys.length * 2);
  const view = new DataView(data.buffer);
  keys.forEach((key, index) => view.setUint16(index * 2, key, true));
  return spatialReferenceFromRecords([{ userId: projectionUserId, recordId: geoKeyDirectoryRecordId, description: "GeoKeyDirectoryTag", data }]);
}
