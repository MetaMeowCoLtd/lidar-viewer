import { PointCloud } from "./point-cloud.js";
import { PointWriter, mulberry32 } from "./procedural/sampling.js";
import { buildTown } from "./procedural/town-layout.js";

export interface ProceduralCloudOptions {
  readonly pointCount?: number;
  readonly seed?: number;
  readonly name?: string;
}

/**
 * A deterministic 440 × 340 m scan to open the app with: a riverside town in
 * a valley, as a drone survey would capture it.
 *
 * A winding river, which leaves a real no-data hole because water returns
 * nothing to a laser, crossed by a steel arch bridge. A downtown with a glass
 * tower, a stepped tower and a round one, a church spire, a courtyard block,
 * a factory with its chimney, a stadium, a school with solar panels on its
 * roof, and streets of houses with pitched roofs, parked cars, buses and lamp
 * posts. East of the river, a forested hill rises 25 m to two wind turbines,
 * while a power line on lattice pylons crosses the fields, the water and a
 * corridor cleared through the trees. Colours are shaded by a low sun, so the
 * relief reads in the RGB view as well as in the height ramp.
 *
 * It is the scene every feature is demonstrated on, so it gives each of them
 * something to find: hundreds of trees, dozens of buildings of every roof
 * shape, relief worth drawing contours on, and decoys - cars, pylons,
 * cables, turbines - that are neither building nor tree.
 */
export class ProceduralCloudGenerator {
  public generate(options: ProceduralCloudOptions = {}): PointCloud {
    const pointCount = options.pointCount ?? 1_000_000;
    if (!Number.isSafeInteger(pointCount) || pointCount < 1) throw new Error("pointCount must be a positive integer");

    const random = mulberry32(options.seed ?? 0x1d4a11);
    const surfaces = buildTown(random);

    // Each point lands on a surface chosen in proportion to its weight.
    const cumulative = new Float64Array(surfaces.length);
    let total = 0;
    surfaces.forEach((surface, index) => {
      total += surface.weight;
      cumulative[index] = total;
    });

    const out = new PointWriter(pointCount);
    for (let point = 0; point < pointCount; point += 1) {
      const target = random() * total;
      let low = 0;
      let high = surfaces.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (cumulative[middle]! < target) low = middle + 1;
        else high = middle;
      }
      surfaces[low]!.emit(random, out);
    }

    return new PointCloud({ positions: out.positions, colors: out.colors, name: options.name ?? "procedural-town" });
  }
}
