import { toMapCoordinates, type PointCloud } from "../core/point-cloud.js";
import type { DetectedObject } from "../core/object-detection.js";
import { classificationName } from "../core/point-cloud-classification.js";

/**
 * Inventory exports: what was found in a scan, as a table for a spreadsheet
 * and as a map layer for a GIS.
 *
 * Positions are written in the scan's own world coordinates - east and north
 * in whatever projection the file was delivered in, and elevation above that
 * system's vertical datum - so the output lines up with other data in that
 * projection without the viewer having to know how to reproject. Heights and
 * areas are in the same units as the coordinates, which for survey data is
 * almost always metres.
 */

/** One row per building and tree, buildings first. */
export function objectInventoryCsv(cloud: PointCloud, objects: readonly DetectedObject[]): string {
  const rows: (string | number)[][] = [
    ["id", "kind", "x", "y", "ground_elevation", "height", "area", "crown_radius", "point_count"],
  ];
  for (const object of objects) {
    const location = objectLocation(cloud, object);
    const ground = cloud.origin[1] + object.groundY;
    rows.push(
      object.kind === "building"
        ? [object.id, "building", fixed(location[0], 3), fixed(location[1], 3), fixed(ground, 2), fixed(object.height, 2), fixed(object.footprintArea, 1), "", object.pointCount]
        : [object.id, "tree", fixed(location[0], 3), fixed(location[1], 3), fixed(ground, 2), fixed(object.height, 2), fixed(object.crownArea, 1), fixed(object.crownRadius, 2), object.pointCount],
    );
  }
  return toCsv(rows);
}

/** Points per class, most populated first - useful on any classified scan, counted or not. */
export function classSummaryCsv(cloud: PointCloud): string {
  const rows: (string | number)[][] = [["code", "name", "point_count", "share_percent"]];
  for (const { code, count } of cloud.classificationHistogram()) {
    rows.push([code, classificationName(code), count, fixed((count / cloud.pointCount) * 100, 3)]);
  }
  return toCsv(rows);
}

/**
 * Buildings as footprint polygons and trees as treetop points, with their
 * measurements as properties.
 *
 * RFC 7946 GeoJSON is defined in longitude and latitude, and projected survey
 * coordinates are not that. Reprojecting would need a projection library and
 * database the viewer does not ship, so the layer keeps the scan's coordinates
 * and names their system with the older `crs` member, which QGIS, GDAL and
 * ArcGIS still read. When the scan declared no recognisable EPSG code the
 * member is left out and the GIS will ask which system the layer is in.
 */
export function objectsGeoJson(cloud: PointCloud, objects: readonly DetectedObject[]): string {
  const epsg = cloud.spatialReference?.epsg;
  const features = objects.map((object) => {
    const ground = round(cloud.origin[1] + object.groundY, 2);
    if (object.kind === "building") {
      return {
        type: "Feature",
        id: object.id,
        geometry: { type: "Polygon", coordinates: [footprintRing(cloud, object.outline)] },
        properties: {
          id: object.id,
          kind: "building",
          height: round(object.height, 2),
          ground_elevation: ground,
          roof_elevation: round(ground + object.height, 2),
          footprint_area: round(object.footprintArea, 1),
          point_count: object.pointCount,
        },
      };
    }
    const top = toMapCoordinates(cloud.origin, object.top[0], object.top[1], object.top[2]);
    return {
      type: "Feature",
      id: object.id,
      geometry: { type: "Point", coordinates: [round(top[0], 3), round(top[1], 3)] },
      properties: {
        id: object.id,
        kind: "tree",
        height: round(object.height, 2),
        ground_elevation: ground,
        top_elevation: round(top[2], 2),
        crown_area: round(object.crownArea, 1),
        crown_radius: round(object.crownRadius, 2),
        point_count: object.pointCount,
      },
    };
  });
  return JSON.stringify({
    type: "FeatureCollection",
    name: cloud.name,
    ...(epsg === undefined ? {} : { crs: { type: "name", properties: { name: `urn:ogc:def:crs:EPSG::${epsg}` } } }),
    features,
  });
}

/** Where an object sits on the map: a building's footprint centre, or a tree's top. */
function objectLocation(cloud: PointCloud, object: DetectedObject): [number, number] {
  const [x, z] = object.kind === "building" ? object.center : [object.top[0], object.top[2]];
  const world = toMapCoordinates(cloud.origin, x, 0, z);
  return [world[0], world[1]];
}

/**
 * A closed ring in map coordinates, wound anticlockwise as RFC 7946 asks of an
 * outer ring. Converting from the viewer's south-pointing z to north flips the
 * outline's winding, so the direction is measured rather than assumed.
 */
function footprintRing(cloud: PointCloud, outline: Float32Array): [number, number][] {
  const ring: [number, number][] = [];
  for (let index = 0; index + 1 < outline.length; index += 2) {
    const world = toMapCoordinates(cloud.origin, outline[index]!, 0, outline[index + 1]!);
    ring.push([round(world[0], 3), round(world[1], 3)]);
  }
  if (ring.length === 0) return ring;
  // Measured relative to the first vertex: at projected magnitude the raw
  // cross products run to trillions and would swamp a small footprint's area.
  const [originX, originY] = ring[0]!;
  let twiceArea = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [ax, ay] = ring[index]!;
    const [bx, by] = ring[(index + 1) % ring.length]!;
    twiceArea += (ax - originX) * (by - originY) - (bx - originX) * (ay - originY);
  }
  if (twiceArea < 0) ring.reverse();
  ring.push([ring[0]![0], ring[0]![1]]);
  return ring;
}

function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function fixed(value: number, digits: number): string {
  return round(value, digits).toFixed(digits);
}

/** Rounds for output, folding negative zero so a value never prints as "-0". */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor + 0;
}
