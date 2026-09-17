import { describe, expect, it } from "vitest";
import {
  PointCloud,
  classSummaryCsv,
  detectObjects,
  epsgFromGeoKeys,
  epsgFromWkt,
  objectInventoryCsv,
  objectsGeoJson,
  spatialReferenceFromRecords,
  toMapCoordinates,
  writeLas,
  type DetectedObject,
  type SpatialReference,
} from "../src/index.js";
import { readLasHeader } from "../src/import/las-header.js";
import { readLasPoints } from "../src/import/las-reader.js";
import { fileStem } from "../src/export/save-file.js";
import { buildAerialScene } from "./support/aerial-scene.js";

const utm54Wkt =
  'PROJCS["WGS 84 / UTM zone 54N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],' +
  'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],' +
  'AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["central_meridian",141],UNIT["metre",1,AUTHORITY["EPSG","9001"]],' +
  'AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32654"]]';

function wktReference(wkt: string): SpatialReference {
  return spatialReferenceFromRecords([
    { userId: "LASF_Projection", recordId: 2112, description: "OGC WKT", data: new TextEncoder().encode(`${wkt}\0`) },
  ])!;
}

function concat(parts: readonly Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes.buffer;
}

/** Three points of a georeferenced scan, in viewer axes relative to a UTM-sized origin. */
function georeferencedCloud(overrides: Partial<ConstructorParameters<typeof PointCloud>[0]> = {}): PointCloud {
  return new PointCloud({
    positions: new Float32Array([10.125, 20.5, -900.25, -250.75, 3.001, 400.5, 0, 0, 0]),
    colors: new Uint8Array([10, 20, 30, 255, 128, 0, 0, 0, 0]),
    intensity: new Float32Array([1234, 65535, 0]),
    classification: new Uint8Array([6, 2, 64]),
    returnNumber: new Uint8Array([1, 2, 12]),
    numberOfReturns: new Uint8Array([1, 3, 15]),
    heightAboveGround: new Float32Array([18.25, 0, 3.5]),
    objectId: new Uint32Array([1, 0, 70_000]),
    origin: [543_000, 0, -4_179_000],
    spatialReference: wktReference(utm54Wkt),
    name: "tile",
    ...overrides,
  });
}

describe("coordinate reference systems", () => {
  it("takes the code of the whole projected system, not of a nested datum or unit", () => {
    expect(epsgFromWkt(utm54Wkt)).toBe(32654);
  });

  it("uses the horizontal half of a compound system that has no code of its own", () => {
    const compound = `COMPD_CS["UTM 54N + JGD2011 height",${utm54Wkt},VERT_CS["JGD2011 height",VERT_DATUM["JGD2011",2005,AUTHORITY["EPSG","1131"]],AUTHORITY["EPSG","6695"]]]`;
    expect(epsgFromWkt(compound)).toBe(32654);
  });

  it("reads WKT2 identifiers and tolerates escaped quotes", () => {
    const wkt2 = 'PROJCRS["JGD2011 / Japan Plane ""IX""",BASEGEOGCRS["JGD2011",DATUM["JGD2011",ELLIPSOID["GRS 1980",6378137,298.257222101]],ID["EPSG",6668]],CONVERSION["IX",METHOD["TM"]],CS[Cartesian,2],ID["EPSG",6677]]';
    expect(epsgFromWkt(wkt2)).toBe(6677);
    expect(epsgFromWkt("LOCAL_CS[\"site\"]")).toBeUndefined();
    expect(epsgFromWkt("not wkt")).toBeUndefined();
  });

  it("reads the projected system from GeoTIFF keys, ignoring user-defined codes", () => {
    const keys = (entries: [number, number][]) => {
      const values = [1, 1, 0, entries.length, ...entries.flatMap(([id, value]) => [id, 0, 1, value])];
      return new Uint8Array(Uint16Array.from(values).buffer);
    };
    expect(epsgFromGeoKeys(keys([[1024, 1], [3072, 32654]]))).toBe(32654);
    expect(epsgFromGeoKeys(keys([[2048, 4326]]))).toBe(4326);
    expect(epsgFromGeoKeys(keys([[3072, 32767]]))).toBeUndefined();
  });
});

describe("LAS export", () => {
  it("round-trips every channel through the LAS reader, in world coordinates", () => {
    const cloud = georeferencedCloud();
    const buffer = concat(writeLas(cloud, { createdAt: new Date(Date.UTC(2026, 8, 17)) }));
    const header = readLasHeader(buffer)!;
    expect(header).toMatchObject({ versionMajor: 1, versionMinor: 4, pointFormat: 7, pointLength: 44, pointCount: 3, headerSize: 375 });

    const back = readLasPoints(buffer, header, "tile");
    for (let point = 0; point < 3; point += 1) {
      const written = cloud.worldPosition(point);
      const read = back.worldPosition(point);
      for (let axis = 0; axis < 3; axis += 1) expect(read[axis]).toBeCloseTo(written[axis]!, 3);
    }
    expect([...back.classification!]).toEqual([6, 2, 64]);
    expect([...back.returnNumber!]).toEqual([1, 2, 12]);
    expect([...back.numberOfReturns!]).toEqual([1, 3, 15]);
    expect([...back.intensity!]).toEqual([1234, 65535, 0]);
    expect([...back.colors!]).toEqual([...cloud.colors!]);
    expect(back.spatialReference?.epsg).toBe(32654);
    expect(back.spatialReference?.wkt).toBe(utm54Wkt);

    // Header extent in LAS axes: east, north, up.
    const view = new DataView(buffer);
    const east = [543_000 - 250.75, 543_010.125];
    const north = [4_179_000 - 400.5, 4_179_900.25];
    expect(view.getFloat64(187, true)).toBeCloseTo(east[0]!, 3);
    expect(view.getFloat64(179, true)).toBeCloseTo(east[1]!, 3);
    expect(view.getFloat64(203, true)).toBeCloseTo(north[0]!, 3);
    expect(view.getFloat64(195, true)).toBeCloseTo(north[1]!, 3);
    expect(view.getUint16(6, true) & (1 << 4)).not.toBe(0);
    expect(view.getUint16(92, true)).toBe(2026);
    expect(view.getUint16(90, true)).toBe(260);
    expect(view.getBigUint64(255, true)).toBe(1n);
  });

  it("describes heights and object ids as named extra bytes", () => {
    const cloud = georeferencedCloud();
    const buffer = concat(writeLas(cloud));
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const text = (at: number, width: number) => String.fromCharCode(...bytes.subarray(at, at + width)).replace(/\0+$/, "");

    const extraBytes = [...records(view, bytes)].find((record) => record.userId === "LASF_Spec" && record.recordId === 4)!;
    expect(extraBytes.length).toBe(2 * 192);
    expect(text(extraBytes.start + 4, 32)).toBe("HeightAboveGround");
    expect(bytes[extraBytes.start + 2]).toBe(9);
    expect(text(extraBytes.start + 192 + 4, 32)).toBe("ObjectId");
    expect(bytes[extraBytes.start + 192 + 2]).toBe(5);

    const pointData = view.getUint32(96, true);
    const recordLength = view.getUint16(105, true);
    const third = pointData + 2 * recordLength;
    expect(view.getFloat32(third + 36, true)).toBe(3.5);
    expect(view.getUint32(third + 40, true)).toBe(70_000);
  });

  it("drops colour and extra bytes that the cloud does not have", () => {
    const cloud = new PointCloud({ positions: new Float32Array([1, 2, 3, 4, 5, 6]), classification: new Uint8Array([2, 5]) });
    const buffer = concat(writeLas(cloud, { chunkPoints: 1 }));
    const header = readLasHeader(buffer)!;
    expect(header).toMatchObject({ pointFormat: 6, pointLength: 30, recordCount: 0, pointCount: 2 });
    const back = readLasPoints(buffer, header, "local");
    expect(back.colors).toBeUndefined();
    expect(back.spatialReference).toBeUndefined();
    expect([...back.returnNumber!]).toEqual([1, 1]);
    expect([...back.classification!]).toEqual([2, 5]);
    expect(Array.from(back.worldPosition(1), (value) => Math.round(value * 1000) / 1000)).toEqual([4, 5, 6]);
  });

  it("finds a coordinate system stored in an extended record after the points", () => {
    const written = new Uint8Array(concat(writeLas(new PointCloud({ positions: new Float32Array([1, 2, 3]) }))));
    const wkt = new TextEncoder().encode(utm54Wkt);
    const buffer = new ArrayBuffer(written.byteLength + 60 + wkt.byteLength);
    const bytes = new Uint8Array(buffer);
    bytes.set(written);
    const view = new DataView(buffer);
    const at = written.byteLength;
    bytes.set(new TextEncoder().encode("LASF_Projection"), at + 2);
    view.setUint16(at + 18, 2112, true);
    view.setBigUint64(at + 20, BigInt(wkt.byteLength), true);
    bytes.set(wkt, at + 60);
    view.setBigUint64(235, BigInt(at), true);
    view.setUint32(243, 1, true);

    const back = readLasPoints(buffer, readLasHeader(buffer)!, "extended");
    expect(back.spatialReference?.epsg).toBe(32654);
    expect(back.spatialReference?.records[0]?.data.byteLength).toBe(wkt.byteLength);
  });

  it("stretches intensity normalised to one across the 16-bit range", () => {
    const cloud = new PointCloud({ positions: new Float32Array([0, 0, 0, 1, 1, 1]), intensity: new Float32Array([0.5, 1]) });
    const buffer = concat(writeLas(cloud));
    const back = readLasPoints(buffer, readLasHeader(buffer)!, "normalised");
    expect([...back.intensity!]).toEqual([32768, 65535]);
  });

  it("coarsens the scale when a millimetre step would overflow the stored integers", () => {
    const cloud = new PointCloud({ positions: new Float32Array([0, 0, 0, 3_000_000, 10, -3_000_000]) });
    const buffer = concat(writeLas(cloud));
    const view = new DataView(buffer);
    expect(view.getFloat64(131, true)).toBeCloseTo(0.01, 12);
    expect(view.getFloat64(147, true)).toBeCloseTo(0.001, 12);
    const back = readLasPoints(buffer, readLasHeader(buffer)!, "wide");
    expect(back.worldPosition(1)[0]).toBeCloseTo(3_000_000, 1);
    expect(back.worldPosition(1)[2]).toBeCloseTo(-3_000_000, 1);
  });
});

describe("inventory exports", () => {
  const building: DetectedObject = {
    kind: "building",
    id: 1,
    pointCount: 900,
    footprintArea: 200,
    height: 12.345,
    groundY: 35,
    // A 20 x 10 rectangle in viewer x/z, wound so that it turns clockwise once z is flipped to north.
    outline: new Float32Array([0, 0, 20, 0, 20, 10, 0, 10]),
    center: [10, 5],
  };
  const tree: DetectedObject = {
    kind: "tree",
    id: 2,
    pointCount: 120,
    height: 8.5,
    crownArea: 28.3,
    crownRadius: 3,
    groundY: 34,
    top: [-5, 42.5, 7.25],
  };

  it("lists each object in world coordinates", () => {
    const csv = objectInventoryCsv(georeferencedCloud(), [building, tree]).split("\r\n");
    expect(csv[0]).toBe("id,kind,x,y,ground_elevation,height,area,crown_radius,point_count");
    expect(csv[1]).toBe("1,building,543010.000,4178995.000,35.00,12.35,200.0,,900");
    expect(csv[2]).toBe("2,tree,542995.000,4178992.750,34.00,8.50,28.3,3.00,120");
    expect(csv[3]).toBe("");
  });

  it("summarises classes and quotes names that contain commas", () => {
    const cloud = new PointCloud({ positions: new Float32Array(12), classification: new Uint8Array([14, 2, 2, 2]) });
    expect(classSummaryCsv(cloud)).toBe('code,name,point_count,share_percent\r\n2,Ground,3,75.000\r\n14,"Wire, conductor",1,25.000\r\n');
  });

  it("maps footprints as closed anticlockwise polygons and trees as points, naming the EPSG system", () => {
    const layer = JSON.parse(objectsGeoJson(georeferencedCloud(), [building, tree]));
    expect(layer.type).toBe("FeatureCollection");
    expect(layer.crs.properties.name).toBe("urn:ogc:def:crs:EPSG::32654");

    const ring: [number, number][] = layer.features[0].geometry.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[4]).toEqual(ring[0]);
    let twiceArea = 0;
    for (let index = 0; index < 4; index += 1) {
      twiceArea += (ring[index]![0] - ring[0]![0]) * (ring[index + 1]![1] - ring[0]![1]) - (ring[index + 1]![0] - ring[0]![0]) * (ring[index]![1] - ring[0]![1]);
    }
    expect(twiceArea / 2).toBeCloseTo(200, 6);
    expect(ring.map(([x]) => x).sort((a, b) => a - b)[0]).toBe(543_000);
    expect(ring.map(([, y]) => y).sort((a, b) => a - b)[0]).toBe(4_178_990);
    expect(layer.features[0].properties).toMatchObject({ kind: "building", height: 12.35, ground_elevation: 35, roof_elevation: 47.35 });

    expect(layer.features[1].geometry).toEqual({ type: "Point", coordinates: [542_995, 4_178_992.75] });
    expect(layer.features[1].properties).toMatchObject({ kind: "tree", top_elevation: 42.5, crown_radius: 3 });
  });

  it("leaves the system unnamed when the scan declared none", () => {
    const layer = JSON.parse(objectsGeoJson(georeferencedCloud({ spatialReference: undefined }), [tree]));
    expect(layer.crs).toBeUndefined();
  });

  it("exports footprints whose map area matches the measured area", () => {
    const scene = buildAerialScene({ seed: 3 });
    const result = detectObjects({
      positions: scene.positions,
      bounds: scene.bounds,
      heightAboveGround: scene.heightAboveGround,
      classification: scene.groundClassification,
      numberOfReturns: scene.numberOfReturns,
    });
    const cloud = new PointCloud({ positions: scene.positions, bounds: scene.bounds, origin: [300_000, 0, -3_900_000] });
    const layer = JSON.parse(objectsGeoJson(cloud, result.objects));
    const buildings = layer.features.filter((feature: { properties: { kind: string } }) => feature.properties.kind === "building");
    expect(buildings.length).toBe(result.stats.buildings);
    for (const feature of buildings) {
      const ring: [number, number][] = feature.geometry.coordinates[0];
      let twiceArea = 0;
      for (let index = 0; index + 1 < ring.length; index += 1) {
        twiceArea += (ring[index]![0] - ring[0]![0]) * (ring[index + 1]![1] - ring[0]![1]) - (ring[index + 1]![0] - ring[0]![0]) * (ring[index]![1] - ring[0]![1]);
      }
      // Positive: anticlockwise. The outline is simplified, so it only approximates the covered area.
      expect(twiceArea).toBeGreaterThan(0);
      expect(Math.abs(twiceArea / 2 - feature.properties.footprint_area) / feature.properties.footprint_area).toBeLessThan(0.25);
    }
    const csvRows = objectInventoryCsv(cloud, result.objects).trim().split("\r\n");
    expect(csvRows).toHaveLength(result.objects.length + 1);
  });

  it("converts viewer axes to east, north, up", () => {
    expect(toMapCoordinates([500, 10, -2000], 1, 2, 3)).toEqual([501, 1997, 12]);
  });

  it("makes scan names safe as file names", () => {
    expect(fileStem('site: "north"/2026')).toBe("site- -north-2026");
    expect(fileStem("...")).toBe("scan");
  });
});

function* records(view: DataView, bytes: Uint8Array) {
  let base = view.getUint16(94, true);
  const count = view.getUint32(100, true);
  for (let record = 0; record < count; record += 1) {
    const length = view.getUint16(base + 20, true);
    const userId = String.fromCharCode(...bytes.subarray(base + 2, base + 18)).replace(/\0+$/, "");
    yield { userId, recordId: view.getUint16(base + 18, true), start: base + 54, length };
    base += 54 + length;
  }
}
