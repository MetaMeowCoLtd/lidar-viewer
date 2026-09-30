import { toMapCoordinates, type PointCloud } from "../core/point-cloud.js";
import type { PolygonMeasurement, Vec3, VolumeBase } from "../core/polygon-measure.js";
import type { SurfaceSelection } from "../core/surface-area.js";

/** Everything measured on a scan, in the viewer's local frame, as the export takes it. */
export interface MeasurementSet {
  readonly rulers: ReadonlyArray<{ readonly id: number; readonly from: Vec3; readonly to: Vec3 }>;
  readonly polygons: ReadonlyArray<{
    readonly id: number;
    readonly vertices: readonly Vec3[];
    readonly base: VolumeBase;
    /** Local height of the base where it is level. */
    readonly baseLevel: number | undefined;
    readonly height: number;
    readonly result: PolygonMeasurement;
  }>;
  readonly surfaces: ReadonlyArray<{ readonly id: number; readonly surface: SurfaceSelection }>;
}

/**
 * The measurements as a map layer - rulers as lines, polygons with their
 * areas and volumes, picked surfaces as points at their middle - the way
 * survey software hands measurements to a GIS or a CAD package.
 *
 * Positions carry their elevation as a third coordinate and are in the scan's
 * own projected system, named with the older `crs` member as the building and
 * tree layer's are, since RFC 7946's longitude and latitude would need a
 * reprojection the viewer does not ship.
 */
export function measurementsGeoJson(cloud: PointCloud, set: MeasurementSet): string {
  const epsg = cloud.spatialReference?.epsg;
  const map = (local: Vec3): [number, number, number] => {
    const [east, north, elevation] = toMapCoordinates(cloud.origin, local[0], local[1], local[2]);
    return [round(east, 3), round(north, 3), round(elevation, 3)];
  };
  const elevation = (localY: number) => round(cloud.origin[1] + localY, 3);

  const rulers = set.rulers.map((ruler) => {
    const [from, to] = [map(ruler.from), map(ruler.to)];
    const horizontal = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const vertical = to[2] - from[2];
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [from, to] },
      properties: {
        kind: "distance",
        id: ruler.id,
        distance: round(Math.hypot(horizontal, vertical), 3),
        horizontal: round(horizontal, 3),
        vertical: round(vertical, 3),
        slope_degrees: round((Math.atan2(Math.abs(vertical), horizontal) * 180) / Math.PI, 2),
      },
    };
  });

  const polygons = set.polygons.map((polygon) => {
    const { result } = polygon;
    return {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [anticlockwiseRing(polygon.vertices.map(map))] },
      properties: {
        kind: "polygon",
        id: polygon.id,
        plan_area: round(result.planArea, 2),
        surface_area: round(result.surfaceArea, 2),
        perimeter: round(result.perimeter, 3),
        base: polygon.base,
        base_elevation: elevation(polygon.baseLevel ?? result.baseMean),
        cut_volume: round(result.cut, 2),
        fill_volume: round(result.fill, 2),
        net_volume: round(result.cut - result.fill, 2),
        extrusion_height: round(polygon.height, 3),
        prism_volume: round(result.prism, 2),
        prism_filled_volume: round(result.filled, 2),
        unmeasured_share: round(result.unmeasured, 4),
        grid_cell: round(result.cellSize, 3),
      },
    };
  });

  const surfaces = set.surfaces.map(({ id, surface }) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: map(surface.centre) },
    properties: {
      kind: "surface",
      id,
      plan_area: round(surface.planArea, 2),
      surface_area: round(surface.surfaceArea, 2),
      slope_degrees: round(surface.slopeDegrees, 2),
      mean_elevation: elevation(surface.meanHeight),
    },
  }));

  return JSON.stringify({
    type: "FeatureCollection",
    name: `${cloud.name} measurements`,
    ...(epsg === undefined ? {} : { crs: { type: "name", properties: { name: `urn:ogc:def:crs:EPSG::${epsg}` } } }),
    features: [...rulers, ...polygons, ...surfaces],
  });
}

/**
 * A closed ring wound anticlockwise, as RFC 7946 asks of an outer ring. The
 * direction is measured relative to the first corner, since at projected
 * magnitudes raw cross products would swamp a small polygon's area.
 */
function anticlockwiseRing(corners: Array<[number, number, number]>): Array<[number, number, number]> {
  const ring = [...corners];
  if (ring.length === 0) return ring;
  const [originX, originY] = ring[0]!;
  let twiceArea = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [ax, ay] = ring[index]!;
    const [bx, by] = ring[(index + 1) % ring.length]!;
    twiceArea += (ax - originX) * (by - originY) - (bx - originX) * (ay - originY);
  }
  if (twiceArea < 0) ring.reverse();
  ring.push([...ring[0]!]);
  return ring;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor + 0;
}
