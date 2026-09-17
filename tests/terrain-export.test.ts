import { describe, expect, it } from "vitest";
import {
  buildTerrainModel,
  calculateBounds,
  contoursGeoJson,
  elevationNoData,
  spatialReferenceFromRecords,
  terrainGeoTiff,
  traceContours,
} from "../src/index.js";

/** A 20 by 10 slope rising east, with a 5-unit strip beyond the data to the east. */
function slopeModel() {
  const positions: number[] = [];
  for (let z = 0; z <= 10; z += 0.5) {
    for (let x = 0; x <= 20; x += 0.5) positions.push(x, 0.5 * x, z);
  }
  const array = Float32Array.from(positions);
  const bounds = calculateBounds(Float32Array.from([...positions, 25, 0, 0]));
  return buildTerrainModel({ positions: array, bounds, classification: new Uint8Array(array.length / 3).fill(2) }, { cellSize: 1, maxGridCells: 10_000 });
}

const utm = spatialReferenceFromRecords([
  { userId: "LASF_Projection", recordId: 2112, description: "", data: new TextEncoder().encode('PROJCS["WGS 84 / UTM zone 54N",AUTHORITY["EPSG","32654"]]') },
]);

/** Reads a baseline little-endian TIFF's first directory into tag, type, count and raw value offset. */
function readTiff(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("II");
  expect(view.getUint16(2, true)).toBe(42);
  const ifd = view.getUint32(4, true);
  const tags = new Map<number, { type: number; count: number; at: number }>();
  const count = view.getUint16(ifd, true);
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const base = ifd + 2 + index * 12;
    const tag = view.getUint16(base, true);
    expect(tag).toBeGreaterThan(previous); // tags must be sorted
    previous = tag;
    tags.set(tag, { type: view.getUint16(base + 2, true), count: view.getUint32(base + 4, true), at: base + 8 });
  }
  const long = (tag: number) => view.getUint32(tags.get(tag)!.at, true);
  const short = (tag: number) => view.getUint16(tags.get(tag)!.at, true);
  const doubles = (tag: number) => {
    const entry = tags.get(tag)!;
    const offset = view.getUint32(entry.at, true);
    return Array.from({ length: entry.count }, (_, index) => view.getFloat64(offset + index * 8, true));
  };
  const shorts = (tag: number) => {
    const entry = tags.get(tag)!;
    const offset = view.getUint32(entry.at, true);
    return Array.from({ length: entry.count }, (_, index) => view.getUint16(offset + index * 2, true));
  };
  const text = (tag: number) => {
    const entry = tags.get(tag)!;
    const offset = view.getUint32(entry.at, true);
    return String.fromCharCode(...bytes.subarray(offset, offset + entry.count - 1));
  };
  return { view, tags, long, short, doubles, shorts, text };
}

describe("terrain exports", () => {
  it("writes a georeferenced float GeoTIFF with north at the top and no-data outside the scan", () => {
    const model = slopeModel();
    const origin = [543_000, 100, -4_179_000] as const;
    const tiff = readTiff(terrainGeoTiff(model, origin, utm));

    expect(tiff.long(256)).toBe(model.grid.cols);
    expect(tiff.long(257)).toBe(model.grid.rows);
    expect(tiff.short(258)).toBe(32);
    expect(tiff.short(259)).toBe(1);
    expect(tiff.short(339)).toBe(3);
    expect(tiff.doubles(33550)).toEqual([1, 1, 0]);
    // The top-left corner: west edge of the grid, and its northern edge, which is viewer z at its minimum.
    expect(tiff.doubles(33922)).toEqual([0, 0, 0, 543_000, 4_179_000, 0]);
    expect(tiff.shorts(34735)).toEqual([1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32654]);
    expect(tiff.text(42113)).toBe(String(elevationNoData));

    const strip = tiff.long(273);
    expect(tiff.long(279)).toBe(model.grid.cols * model.grid.rows * 4);
    const pixel = (column: number, row: number) => tiff.view.getFloat32(strip + (row * model.grid.cols + column) * 4, true);
    // Cell 4 spans x from 4 to 5 and holds points at 4 and 4.5: local heights 2 and 2.25.
    expect(pixel(4, 3)).toBeCloseTo(102.125, 3);
    expect(pixel(model.grid.cols - 1, 3)).toBe(elevationNoData);
  });

  it("leaves the coordinate system out of the keys when the scan named none", () => {
    const tiff = readTiff(terrainGeoTiff(slopeModel(), [0, 0, 0]));
    expect(tiff.shorts(34735)).toEqual([1, 1, 0, 1, 1025, 0, 1, 1]);
  });

  it("exports contours as elevation-labelled lines in map coordinates", () => {
    const model = slopeModel();
    const origin = [543_000, 100, -4_179_000] as const;
    const contours = traceContours(model, origin[1], { interval: 2, smoothingPasses: 0 });
    const layer = JSON.parse(contoursGeoJson(contours, origin, "site", utm));

    expect(layer.crs.properties.name).toBe("urn:ogc:def:crs:EPSG::32654");
    const elevations = layer.features.map((feature: { properties: { elevation: number } }) => feature.properties.elevation);
    // Every two metres from 102; the slope tops out at exactly 110, which may also be traced along its crest.
    expect(elevations.slice(0, 4)).toEqual([102, 104, 106, 108]);
    expect(elevations.every((elevation: number) => elevation % 2 === 0 && elevation <= 110)).toBe(true);
    const first = layer.features[0];
    expect(first.geometry.type).toBe("LineString");
    expect(first.properties.index).toBe(false);
    for (const [east, north] of first.geometry.coordinates) {
      // Local height 2 is reached at x = 4 on this slope; north runs from 4,179,000 down to 4,178,990.
      expect(east).toBeGreaterThan(543_003);
      expect(east).toBeLessThan(543_005);
      expect(north).toBeLessThanOrEqual(4_179_000);
      expect(north).toBeGreaterThanOrEqual(4_178_989);
    }
  });
});
