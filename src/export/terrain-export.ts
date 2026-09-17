import { toMapCoordinates, type PointCloudOrigin } from "../core/point-cloud.js";
import type { SpatialReference } from "../core/spatial-reference.js";
import type { TerrainModel } from "../core/terrain.js";
import type { ContourSet } from "../core/contours.js";

/** The value written for cells outside the scan, declared in the file so GIS tools leave them blank. */
export const elevationNoData = -9999;

/**
 * The terrain model as a single-band 32-bit float GeoTIFF: one elevation per
 * cell, in the scan's own units and coordinate system, north at the top.
 *
 * GeoTIFF is the format every GIS, CAD and photogrammetry tool reads for
 * elevation. The file is written uncompressed in a single strip - simple
 * enough to produce without a library, and a four-million-cell model is
 * sixteen megabytes. Georeferencing is the standard pair of tags - the size
 * of a cell, and where the top-left corner sits on the map - plus GeoTIFF keys
 * naming the EPSG system when the scan declared one. Without a known system,
 * the placement is still written and the GIS will ask which system it is in.
 */
export function terrainGeoTiff(model: TerrainModel, origin: PointCloudOrigin, spatialReference?: SpatialReference): Uint8Array {
  const { cols, rows, cellSize, originX, originZ } = model.grid;
  // Viewer z points south, so the grid's first row is its northern edge, which
  // is exactly the row a GeoTIFF expects first.
  const [west, north] = toMapCoordinates(origin, originX, 0, originZ);

  const ascii = (text: string) => new TextEncoder().encode(`${text}\0`);
  const doubles = (values: readonly number[]) => new Uint8Array(Float64Array.from(values).buffer);
  const shorts = (values: readonly number[]) => new Uint8Array(Uint16Array.from(values).buffer);
  const epsg = spatialReference?.epsg;

  // GeoTIFF keys: version 1.1.0, then (key, location, count, value) entries in key order.
  const keys: [number, number][] = [];
  if (epsg !== undefined) {
    // EPSG's geographic systems sit in the 4000s; everything a scan is
    // normally delivered in - UTM, national grids - is projected.
    const geographic = epsg >= 4000 && epsg < 5000;
    keys.push([1024, geographic ? 2 : 1]);
  }
  keys.push([1025, 1]); // GTRasterTypeGeoKey: each value covers its whole cell.
  if (epsg !== undefined) keys.push(epsg >= 4000 && epsg < 5000 ? [2048, epsg] : [3072, epsg]);
  const geoKeys = shorts([1, 1, 0, keys.length, ...keys.flatMap(([key, value]) => [key, 0, 1, value])]);

  const pixels = new Float32Array(cols * rows);
  for (let cell = 0; cell < pixels.length; cell += 1) {
    const height = model.elevations[cell]!;
    pixels[cell] = height === height ? origin[1] + height : elevationNoData;
  }
  const pixelBytes = new Uint8Array(pixels.buffer);

  interface Entry {
    readonly tag: number;
    readonly type: number;
    readonly count: number;
    readonly inline?: number;
    readonly data?: Uint8Array;
  }
  const SHORT = 3;
  const LONG = 4;
  const ASCII = 2;
  const DOUBLE = 12;
  const entries: Entry[] = [
    { tag: 256, type: LONG, count: 1, inline: cols },
    { tag: 257, type: LONG, count: 1, inline: rows },
    { tag: 258, type: SHORT, count: 1, inline: 32 },
    { tag: 259, type: SHORT, count: 1, inline: 1 }, // no compression
    { tag: 262, type: SHORT, count: 1, inline: 1 }, // black is zero
    { tag: 273, type: LONG, count: 1, inline: 0 }, // strip offset, patched below
    { tag: 277, type: SHORT, count: 1, inline: 1 },
    { tag: 278, type: LONG, count: 1, inline: rows },
    { tag: 279, type: LONG, count: 1, inline: pixelBytes.byteLength },
    { tag: 284, type: SHORT, count: 1, inline: 1 },
    { tag: 339, type: SHORT, count: 1, inline: 3 }, // floating point samples
    { tag: 33550, type: DOUBLE, count: 3, data: doubles([cellSize, cellSize, 0]) },
    { tag: 33922, type: DOUBLE, count: 6, data: doubles([0, 0, 0, west, north, 0]) },
    { tag: 34735, type: SHORT, count: geoKeys.byteLength / 2, data: geoKeys },
    { tag: 42113, type: ASCII, count: ascii(String(elevationNoData)).byteLength, data: ascii(String(elevationNoData)) },
  ];

  const ifdOffset = 8;
  const ifdLength = 2 + entries.length * 12 + 4;
  let cursor = ifdOffset + ifdLength;
  const placed = entries.map((entry) => {
    if (entry.data === undefined) return { entry, offset: 0 };
    cursor += cursor % 2; // values start on a word boundary
    const offset = cursor;
    cursor += entry.data.byteLength;
    return { entry, offset };
  });
  cursor += cursor % 4; // align the float samples, so readers can view them in place
  const stripOffset = cursor;

  const file = new Uint8Array(stripOffset + pixelBytes.byteLength);
  const view = new DataView(file.buffer);
  file[0] = 0x49;
  file[1] = 0x49; // "II": little-endian
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);
  placed.forEach(({ entry, offset }, index) => {
    const base = ifdOffset + 2 + index * 12;
    view.setUint16(base, entry.tag, true);
    view.setUint16(base + 2, entry.type, true);
    view.setUint32(base + 4, entry.count, true);
    if (entry.data !== undefined) {
      view.setUint32(base + 8, offset, true);
      file.set(entry.data, offset);
    } else if (entry.tag === 273) {
      view.setUint32(base + 8, stripOffset, true);
    } else if (entry.type === SHORT) {
      view.setUint16(base + 8, entry.inline!, true);
    } else {
      view.setUint32(base + 8, entry.inline!, true);
    }
  });
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true); // no further images
  file.set(pixelBytes, stripOffset);
  return file;
}

/**
 * Contour lines as a GeoJSON layer: one LineString per line, with its
 * elevation and whether it is an index contour as properties, so a GIS can
 * label and style them. Coordinates are in the scan's own system, named with
 * the `crs` member when its EPSG code is known, as with the object layer.
 */
export function contoursGeoJson(contours: ContourSet, origin: PointCloudOrigin, name: string, spatialReference?: SpatialReference): string {
  const epsg = spatialReference?.epsg;
  const features = contours.lines.map((line) => {
    const coordinates: [number, number][] = [];
    for (let index = 0; index < line.points.length; index += 3) {
      const [east, north] = toMapCoordinates(origin, line.points[index]!, line.level, line.points[index + 2]!);
      coordinates.push([round(east, 3), round(north, 3)]);
    }
    if (line.closed && coordinates.length > 0) coordinates.push([...coordinates[0]!]);
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: { elevation: round(origin[1] + line.level, 3), index: line.major },
    };
  });
  return JSON.stringify({
    type: "FeatureCollection",
    name: `${name} contours`,
    ...(epsg === undefined ? {} : { crs: { type: "name", properties: { name: `urn:ogc:def:crs:EPSG::${epsg}` } } }),
    features,
  });
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor + 0;
}
