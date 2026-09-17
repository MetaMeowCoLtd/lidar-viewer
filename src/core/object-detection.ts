import type { PointCloudBounds } from "./point-cloud.js";
import { cellIndex, gridForExtent, type GridGeometry } from "./elevation-grid.js";
import { simplifyClosedPolygon, traceOutline } from "./raster-outline.js";

/**
 * Tuning for building and tree detection. Distances are in the scan's units,
 * which the defaults take to be metres.
 */
export interface ObjectDetectionOptions {
  /** Edge of one surface cell, or "auto" to size cells so each holds about two points. */
  readonly cellSize: number | "auto";
  /** Points lower than this above ground are never part of a building or tree: cars, hedges, fences. */
  readonly minObjectHeight: number;
  /** How far a roof may depart from a plane across three cells and still count as a roof. */
  readonly roofRoughness: number;
  /** A point this far below the highest point in its cell is inside something, not on top of it. */
  readonly crownDepth: number;
  /** Largest share of a roof cell's points that may lie that deep; canopies are full of them. */
  readonly maxDeepFraction: number;
  /** Share of multiple-return pulses at which a cell is taken to be vegetation outright. */
  readonly multipleReturnFraction: number;
  readonly minBuildingHeight: number;
  /** Smallest footprint counted as a building, so sheds and car ports are left out. */
  readonly minBuildingArea: number;
  readonly minTreeHeight: number;
  /** Smallest crown counted as a tree, so poles and posts are left out. */
  readonly minCrownArea: number;
  readonly minTreePoints: number;
  /** A crown stops growing where the canopy drops below this fraction of its treetop. */
  readonly crownFraction: number;
  /** Stretches of canopy narrower than this across are hedges, not trees. */
  readonly minCanopyWidth: number;
  /** Nothing taller than this is a tree; it is a structure, and joins or becomes a building. */
  readonly maxTreeHeight: number;
  /** Largest ratio of a tree's height to its crown diameter; beyond it is a pole, a chimney or a spire. */
  readonly maxTreeSlenderness: number;
  readonly maxGridCells: number;
}

export const defaultObjectDetectionOptions: ObjectDetectionOptions = {
  cellSize: "auto",
  minObjectHeight: 2,
  roofRoughness: 0.15,
  crownDepth: 1,
  maxDeepFraction: 0.35,
  multipleReturnFraction: 0.6,
  minBuildingHeight: 2.5,
  minBuildingArea: 20,
  minTreeHeight: 2.5,
  minCrownArea: 2,
  minTreePoints: 10,
  crownFraction: 0.35,
  minCanopyWidth: 2.5,
  maxTreeHeight: 60,
  maxTreeSlenderness: 8,
  maxGridCells: 4_000_000,
};

export interface ObjectDetectionInput {
  /** Viewer axes: y is up. */
  readonly positions: Float32Array;
  readonly bounds: PointCloudBounds;
  readonly heightAboveGround: Float32Array;
  readonly classification: Uint8Array;
  readonly numberOfReturns?: Uint8Array | undefined;
}

export interface DetectedBuilding {
  readonly kind: "building";
  /** Matches the value in the cloud's `objectId` channel for this building's points. */
  readonly id: number;
  readonly pointCount: number;
  readonly footprintArea: number;
  /** Roof height above ground, ignoring the highest few percent of the roof so an antenna does not count. */
  readonly height: number;
  /** Local height of the ground the building stands on. */
  readonly groundY: number;
  /** Footprint in local coordinates as `[x0, z0, x1, z1, ...]`, closed from last to first. */
  readonly outline: Float32Array;
  readonly center: readonly [number, number];
}

export interface DetectedTree {
  readonly kind: "tree";
  readonly id: number;
  readonly pointCount: number;
  readonly height: number;
  readonly crownArea: number;
  /** Radius of a circle with the crown's area. */
  readonly crownRadius: number;
  readonly groundY: number;
  /** Local position of the treetop. */
  readonly top: readonly [number, number, number];
}

export type DetectedObject = DetectedBuilding | DetectedTree;

export interface ObjectDetectionStats {
  readonly buildings: number;
  readonly trees: number;
  readonly buildingPoints: number;
  readonly treePoints: number;
  readonly footprintArea: number;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
}

export interface ObjectDetectionResult {
  readonly classification: Uint8Array;
  /** Per point: the id of the building or tree it belongs to, or zero. */
  readonly objectId: Uint32Array;
  /** Buildings first, largest footprint first; then trees, tallest first. */
  readonly objects: readonly DetectedObject[];
  readonly stats: ObjectDetectionStats;
}

export type ObjectDetectionProgress = (stage: string, fraction: number) => void;

const neverClassified = 0;
const unclassified = 1;
const lowVegetation = 3;
const mediumVegetation = 4;
const highVegetation = 5;
const buildingClass = 6;

/**
 * Finds the buildings and trees in a scan whose ground is already known,
 * labels their points, and counts them.
 *
 * Everything standing more than a couple of metres above ground is gridded into
 * a top-down surface, and each cell is judged by three signals that separate a
 * roof from a canopy without any trained model:
 *
 * - Roughness. A roof is a plane at the scale of a few cells, pitched or not; a
 *   canopy's surface is lumpy at every scale.
 * - Depth. A laser passes into a canopy and returns from inside it, so a
 *   canopy cell holds points well below its top. A roof cell holds only roof.
 * - Returns. When the file records them, a pulse that came back more than once
 *   went through something, which roofs do not allow.
 *
 * Where a file already carries building or vegetation classes, they override
 * the geometry for their cells.
 *
 * Buildings are the connected patches of roof-like cells, after closing small
 * gaps such as ridge lines and opening away anything too thin to be a building
 * - hedges, walls, power lines. Patches under a minimum area are not counted.
 *
 * Trees are found the way forestry tools find them: treetops are local maxima
 * of the canopy height model within a window that widens with tree height, and
 * each crown grows outward from its top in order of height, as a watershed on
 * the inverted canopy, until it meets a neighbour, falls below a fraction of its
 * own height, or reaches the widest crown a tree that tall plausibly has.
 *
 * Points are then assigned to the object whose cells they fall in. Only points
 * that were never classified or unclassified are relabelled, as building or high
 * vegetation; a class someone else set is kept, though its point still joins
 * the object it belongs to.
 *
 * Adjacent buildings that share a wall and a roofline become one object, since
 * nothing in the geometry separates them - a terrace is counted as one block.
 */
export function detectObjects(
  input: ObjectDetectionInput,
  options: ObjectDetectionOptions = defaultObjectDetectionOptions,
  onProgress?: ObjectDetectionProgress,
): ObjectDetectionResult {
  validateOptions(options);
  const { positions, bounds, heightAboveGround, classification: existing, numberOfReturns } = input;
  const pointCount = positions.length / 3;
  if (!Number.isInteger(pointCount) || pointCount < 1) throw new Error("positions must contain at least one point");
  for (const [label, channel] of [
    ["heightAboveGround", heightAboveGround],
    ["classification", existing],
    ["numberOfReturns", numberOfReturns],
  ] as const) {
    if (channel !== undefined && channel.length !== pointCount) throw new Error(`${label} must contain one value per point`);
  }

  const requestedCell = options.cellSize === "auto" ? automaticCellSize(pointCount, bounds) : options.cellSize;
  const grid = gridForExtent(bounds.min[0], bounds.min[2], bounds.size[0], bounds.size[2], requestedCell, options.maxGridCells);
  const { cols, rows, cellSize } = grid;
  const cells = cols * rows;
  const isCandidate = (point: number): boolean => {
    const code = existing[point]!;
    return (
      heightAboveGround[point]! >= options.minObjectHeight &&
      (code === neverClassified || code === unclassified || code === buildingClass ||
        code === lowVegetation || code === mediumVegetation || code === highVegetation)
    );
  };

  onProgress?.("Building the surface model", 0);
  const top = new Float32Array(cells).fill(Number.NaN);
  const count = new Uint16Array(cells);
  const multiple = numberOfReturns === undefined ? undefined : new Uint16Array(cells);
  const labelledBuilding = new Uint16Array(cells);
  const labelledVegetation = new Uint16Array(cells);
  for (let point = 0, offset = 0; point < pointCount; point += 1, offset += 3) {
    if (!isCandidate(point)) continue;
    const cell = cellIndex(grid, positions[offset]!, positions[offset + 2]!);
    const height = heightAboveGround[point]!;
    if (!(top[cell]! >= height)) top[cell] = height;
    if (count[cell]! < 65535) count[cell] = count[cell]! + 1;
    if (multiple !== undefined && numberOfReturns![point]! > 1 && multiple[cell]! < 65535) multiple[cell] = multiple[cell]! + 1;
    const code = existing[point]!;
    if (code === buildingClass && labelledBuilding[cell]! < 65535) labelledBuilding[cell] = labelledBuilding[cell]! + 1;
    if ((code === lowVegetation || code === mediumVegetation || code === highVegetation) && labelledVegetation[cell]! < 65535) {
      labelledVegetation[cell] = labelledVegetation[cell]! + 1;
    }
  }

  const deep = new Uint16Array(cells);
  for (let point = 0, offset = 0; point < pointCount; point += 1, offset += 3) {
    if (!isCandidate(point)) continue;
    const cell = cellIndex(grid, positions[offset]!, positions[offset + 2]!);
    if (heightAboveGround[point]! < top[cell]! - options.crownDepth && deep[cell]! < 65535) deep[cell] = deep[cell]! + 1;
  }

  onProgress?.("Telling roofs from canopy", 0.2);
  const roughness = planeFitRoughness(fillIsolatedGaps(top, cols, rows), cols, rows, options.roofRoughness);
  const roofLike = new Uint8Array(cells);
  const vegetationLabelled = new Uint8Array(cells);
  for (let cell = 0; cell < cells; cell += 1) {
    const points = count[cell]!;
    if (points === 0) continue;
    if (labelledVegetation[cell]! * 2 > points) {
      vegetationLabelled[cell] = 1;
      continue;
    }
    if (labelledBuilding[cell]! * 2 > points) {
      roofLike[cell] = 1;
      continue;
    }
    const smooth = roughness[cell]! <= options.roofRoughness;
    const shallow = deep[cell]! <= options.maxDeepFraction * points;
    const throughReturns = multiple !== undefined && multiple[cell]! >= options.multipleReturnFraction * points;
    if (top[cell]! >= options.minBuildingHeight && smooth && shallow && !throughReturns) roofLike[cell] = 1;
  }

  // Open first, so anything under three cells wide - a hedge, a wall, a cable,
  // or a speck of canopy that happened to look smooth - is gone before it can
  // be joined to anything. Then close, so a ridge line or a chimney does not
  // split a roof. The other order would merge scattered smooth specks inside a
  // crown into a flat patch that then carves a hole in the tree.
  const flat = closeMask(openMask(roofLike, cols, rows), cols, rows);

  onProgress?.("Separating buildings", 0.35);
  const buildingOfCell = new Int32Array(cells);
  const buildingPatches = labelPatches(flat, cols, rows, buildingOfCell);
  const minBuildingCells = options.minBuildingArea / (cellSize * cellSize);
  const keptBuildings = buildingPatches.filter((patch) => patch.cells >= minBuildingCells);
  const keptBuildingLabels = new Set(keptBuildings.map((patch) => patch.label));
  for (let cell = 0; cell < cells; cell += 1) {
    if (buildingOfCell[cell] !== 0 && !keptBuildingLabels.has(buildingOfCell[cell]!)) buildingOfCell[cell] = 0;
  }
  growToWalls(buildingOfCell, keptBuildings, top, roughness, count, vegetationLabelled, grid, options);
  absorbTallStructures(buildingOfCell, keptBuildings, top, count, vegetationLabelled, grid, options);
  const patchHeights = new Map(keptBuildings.map((patch) => [patch.label, roofHeight(top, buildingOfCell, cols, patch)]));
  const nearbyBuildingHeight = heightOfNearbyBuildings(buildingOfCell, patchHeights, grid);
  const nearFlat = dilateMask(
    Uint8Array.from(flat, (value, cell) => (value === 1 || buildingOfCell[cell] !== 0 ? 1 : 0)),
    cols,
    rows,
  );

  onProgress?.("Finding treetops", 0.5);
  const canopy = new Uint8Array(cells);
  const chm = new Float32Array(cells);
  for (let cell = 0; cell < cells; cell += 1) {
    if (count[cell] === 0 || top[cell]! < options.minObjectHeight || top[cell]! > options.maxTreeHeight) continue;
    // Beside a building, a cell reaching most of the way to its roof is the
    // building's wall seen from the street, not a tree growing against it.
    const wall = nearbyBuildingHeight[cell]!;
    if (vegetationLabelled[cell] === 0 && wall > 0 && top[cell]! >= 0.8 * wall) continue;
    if (vegetationLabelled[cell] === 1 || nearFlat[cell] === 0) {
      canopy[cell] = 1;
      chm[cell] = top[cell]!;
    }
  }
  fillCanopyGaps(canopy, chm, nearFlat, vegetationLabelled, cols, rows);
  removeNarrowCanopy(canopy, chm, grid, options.minCanopyWidth);
  // Opening then clears specks under three cells wide that are left over, so
  // a post or the end of a wall is not taken for a small tree.
  const openedCanopy = openMask(canopy, cols, rows);
  for (let cell = 0; cell < cells; cell += 1) {
    if (openedCanopy[cell] === 0) {
      canopy[cell] = 0;
      chm[cell] = 0;
    }
  }
  const smoothed = smoothCanopy(canopy, chm, cols, rows);
  const crownOfCell = new Int32Array(cells);
  const crowns = segmentCrowns(smoothed, canopy, grid, options, crownOfCell);

  onProgress?.("Assigning points to objects", 0.75);

  /**
   * The object a point belongs to, encoded to avoid allocating per point: a
   * building's patch label as a positive number, a crown's label as a negative
   * one, or zero for neither.
   */
  // A tree holds nothing much higher than its own top. A point that is - a
  // wall point in a street-level scan, most often - is left to the building
  // check below instead.
  const crownCeiling = new Float32Array(crowns.length + 1);
  for (const crown of crowns) crownCeiling[crown.label] = crown.topHeight * 1.15 + 1;

  const ownerOf = (point: number, offset: number): number => {
    const cell = cellIndex(grid, positions[offset]!, positions[offset + 2]!);
    const crown = crownOfCell[cell]!;
    if (crown !== 0 && existing[point] !== buildingClass && heightAboveGround[point]! <= crownCeiling[crown]!) return -crown;
    const building = buildingOfCell[cell]!;
    if (building !== 0) return building;
    // Walls and eaves sit on the rim of a footprint, often a cell outside it.
    // Only points no higher than the roof join, so a tree beside a low
    // building is not swallowed by it.
    const column = cell % cols;
    const row = (cell - column) / cols;
    for (let dRow = -1; dRow <= 1; dRow += 1) {
      const r = row + dRow;
      if (r < 0 || r >= rows) continue;
      for (let dColumn = -1; dColumn <= 1; dColumn += 1) {
        const c = column + dColumn;
        if (c < 0 || c >= cols) continue;
        const neighbour = buildingOfCell[r * cols + c]!;
        if (neighbour !== 0 && heightAboveGround[point]! <= patchHeights.get(neighbour)! + 1) return neighbour;
      }
    }
    return 0;
  };

  const buildingPoints = new Map<number, number>();
  const crownPoints = new Map<number, number>();
  const crownTopPoint = new Map<number, number>();
  const groundSums = new Map<number, number>();
  for (let point = 0, offset = 0; point < pointCount; point += 1, offset += 3) {
    if (!isCandidate(point)) continue;
    const owner = ownerOf(point, offset);
    if (owner > 0) {
      buildingPoints.set(owner, (buildingPoints.get(owner) ?? 0) + 1);
      groundSums.set(owner, (groundSums.get(owner) ?? 0) + (positions[offset + 1]! - heightAboveGround[point]!));
    } else if (owner < 0) {
      const crown = -owner;
      crownPoints.set(crown, (crownPoints.get(crown) ?? 0) + 1);
      const best = crownTopPoint.get(crown);
      if (best === undefined || heightAboveGround[point]! > heightAboveGround[best]!) crownTopPoint.set(crown, point);
    }
  }

  onProgress?.("Measuring each object", 0.88);
  const buildingSummaries = keptBuildings
    .filter((patch) => (buildingPoints.get(patch.label) ?? 0) > 0)
    .map((patch) => ({
      patch,
      area: coveredCells(buildingOfCell, count, deep, cols, rows, patch) * cellSize * cellSize,
      height: patchHeights.get(patch.label)!,
    }))
    .sort((a, b) => b.area - a.area || a.patch.label - b.patch.label);

  const minCrownCells = options.minCrownArea / (cellSize * cellSize);
  const treeSummaries = crowns
    .filter(
      (crown) =>
        crown.cells >= minCrownCells &&
        crown.elongation() <= maxCrownElongation &&
        crown.topHeight <= options.maxTreeSlenderness * 2 * Math.sqrt((crown.cells * cellSize * cellSize) / Math.PI) &&
        (crownPoints.get(crown.label) ?? 0) >= options.minTreePoints,
    )
    .map((crown) => ({ crown, topPoint: crownTopPoint.get(crown.label)! }))
    .sort((a, b) => heightAboveGround[b.topPoint]! - heightAboveGround[a.topPoint]! || a.crown.label - b.crown.label);

  const buildingIds = new Map<number, number>();
  const treeIds = new Map<number, number>();
  const objects: DetectedObject[] = [];
  let footprintArea = 0;
  for (const { patch, area, height } of buildingSummaries) {
    const id = objects.length + 1;
    buildingIds.set(patch.label, id);
    footprintArea += area;
    const points = buildingPoints.get(patch.label)!;
    objects.push({
      kind: "building",
      id,
      pointCount: points,
      footprintArea: area,
      height,
      groundY: groundSums.get(patch.label)! / points,
      outline: footprintOutline(buildingOfCell, grid, patch),
      center: [grid.originX + (patch.columnSum / patch.cells + 0.5) * cellSize, grid.originZ + (patch.rowSum / patch.cells + 0.5) * cellSize],
    });
  }
  for (const { crown, topPoint } of treeSummaries) {
    const id = objects.length + 1;
    treeIds.set(crown.label, id);
    const area = crown.cells * cellSize * cellSize;
    const offset = topPoint * 3;
    objects.push({
      kind: "tree",
      id,
      pointCount: crownPoints.get(crown.label)!,
      height: heightAboveGround[topPoint]!,
      crownArea: area,
      crownRadius: Math.sqrt(area / Math.PI),
      groundY: positions[offset + 1]! - heightAboveGround[topPoint]!,
      top: [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!],
    });
  }

  onProgress?.("Labelling points", 0.94);
  const classification = Uint8Array.from(existing);
  const objectId = new Uint32Array(pointCount);
  let labelledBuildingPoints = 0;
  let labelledTreePoints = 0;
  for (let point = 0, offset = 0; point < pointCount; point += 1, offset += 3) {
    if (!isCandidate(point)) continue;
    const owner = ownerOf(point, offset);
    if (owner === 0) continue;
    const id = owner > 0 ? buildingIds.get(owner) : treeIds.get(-owner);
    if (id === undefined) continue;
    objectId[point] = id;
    const reassignable = existing[point] === neverClassified || existing[point] === unclassified;
    if (owner > 0) {
      labelledBuildingPoints += 1;
      if (reassignable) classification[point] = buildingClass;
    } else {
      labelledTreePoints += 1;
      if (reassignable) classification[point] = highVegetation;
    }
  }

  onProgress?.("Done", 1);
  return {
    classification,
    objectId,
    objects,
    stats: {
      buildings: buildingSummaries.length,
      trees: treeSummaries.length,
      buildingPoints: labelledBuildingPoints,
      treePoints: labelledTreePoints,
      footprintArea,
      cellSize,
      cols,
      rows,
    },
  };
}

/**
 * About four points per cell. Points land at random, so at two per cell one
 * cell in nine is empty and a quarter hold a single point, which riddles every
 * roof with cells that cannot be judged; at four, fewer than one in fifty is
 * empty. Coarser still and neighbouring trees start to blur into one crown.
 * Clamped so a very dense scan does not produce a needlessly fine grid, nor a
 * very sparse one a useless coarse grid.
 */
function automaticCellSize(pointCount: number, bounds: PointCloudBounds): number {
  const area = Math.max(1, bounds.size[0] * bounds.size[2]);
  const density = pointCount / area;
  return Math.min(2, Math.max(0.5, 2 / Math.sqrt(density)));
}

/**
 * Root-mean-square distance of each cell's 3 by 3 neighbourhood from the best
 * fitting plane through it, in height units. A pitched roof fits its plane as
 * well as a flat one. Cells with fewer than six surrounding samples - roof
 * corners, isolated returns - are marked Infinity rather than guessed.
 *
 * The fit may set aside up to two samples lying more than `tolerance` below
 * the plane before judging. A roof is the top of whatever it covers, so a
 * neighbour below its plane is a wall, an eave or the edge of the roof caught
 * by a cell that saw mostly wall; left in, one such cell makes every roof rim
 * read as rough. Samples above the plane are never set aside, which keeps a
 * canopy - lumpy upwards as much as downwards - rough.
 */
export function planeFitRoughness(top: Float32Array, cols: number, rows: number, tolerance = Infinity): Float32Array {
  const roughness = new Float32Array(top.length).fill(Infinity);
  const dxs = new Int8Array(9);
  const dzs = new Int8Array(9);
  const hs = new Float64Array(9);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const centre = top[row * cols + column]!;
      if (Number.isNaN(centre)) continue;
      let n = 0;
      for (let dz = -1; dz <= 1; dz += 1) {
        const r = row + dz;
        if (r < 0 || r >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = column + dx;
          if (c < 0 || c >= cols) continue;
          const value = top[r * cols + c]!;
          if (Number.isNaN(value)) continue;
          dxs[n] = dx;
          dzs[n] = dz;
          hs[n] = value - centre;
          n += 1;
        }
      }
      if (n < 6) continue;

      const used = new Uint8Array(n).fill(1);
      let fit = fitPlane(dxs, dzs, hs, used);
      for (let removal = 0; removal < 2 && fit !== undefined && fit.count > 6; removal += 1) {
        let lowest = -1;
        let lowestResidual = -tolerance;
        for (let index = 0; index < n; index += 1) {
          if (used[index] === 0) continue;
          const residual = hs[index]! - (fit.a * dxs[index]! + fit.b * dzs[index]! + fit.c);
          if (residual < lowestResidual) {
            lowestResidual = residual;
            lowest = index;
          }
        }
        if (lowest === -1) break;
        used[lowest] = 0;
        fit = fitPlane(dxs, dzs, hs, used);
      }
      if (fit !== undefined) roughness[row * cols + column] = fit.rms;
    }
  }
  return roughness;
}

/** Least-squares plane h = a*dx + b*dz + c through the samples still in use, by Cramer's rule. */
function fitPlane(
  dxs: Int8Array,
  dzs: Int8Array,
  hs: Float64Array,
  used: Uint8Array,
): { a: number; b: number; c: number; rms: number; count: number } | undefined {
  let n = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, sh = 0, sxh = 0, szh = 0, shh = 0;
  for (let index = 0; index < used.length; index += 1) {
    if (used[index] === 0) continue;
    const dx = dxs[index]!;
    const dz = dzs[index]!;
    const h = hs[index]!;
    n += 1;
    sx += dx; sz += dz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    sh += h; sxh += dx * h; szh += dz * h; shh += h * h;
  }
  const det = sxx * (szz * n - sz * sz) - sxz * (sxz * n - sz * sx) + sx * (sxz * sz - szz * sx);
  if (Math.abs(det) < 1e-9) return undefined;
  const a = (sxh * (szz * n - sz * sz) - sxz * (szh * n - sz * sh) + sx * (szh * sz - szz * sh)) / det;
  const b = (sxx * (szh * n - sz * sh) - sxh * (sxz * n - sz * sx) + sx * (sxz * sh - szh * sx)) / det;
  const c = (sxx * (szz * sh - sz * szh) - sxz * (sxz * sh - sx * szh) + sxh * (sxz * sz - szz * sx)) / det;
  const residual = shh - a * sxh - b * szh - c * sh;
  return { a, b, c, rms: Math.sqrt(Math.max(0, residual) / n), count: n };
}

/**
 * A copy of the surface with lone empty cells given the median height of their
 * neighbours, when at least five of the eight have data. Only roughness sees
 * the copy: it lets the cells around a hole be judged instead of written off,
 * without inventing points for anything that counts them.
 */
function fillIsolatedGaps(top: Float32Array, cols: number, rows: number): Float32Array {
  const filled = Float32Array.from(top);
  const around: number[] = [];
  for (let row = 1; row < rows - 1; row += 1) {
    for (let column = 1; column < cols - 1; column += 1) {
      const cell = row * cols + column;
      if (!Number.isNaN(top[cell]!)) continue;
      around.length = 0;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const value = top[(row + dz) * cols + column + dx]!;
          if (!Number.isNaN(value)) around.push(value);
        }
      }
      if (around.length < 5) continue;
      around.sort((a, b) => a - b);
      filled[cell] = around[around.length >> 1]!;
    }
  }
  return filled;
}

function dilateMask(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  return morphMask(mask, cols, rows, true);
}

function erodeMask(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  return morphMask(mask, cols, rows, false);
}

function closeMask(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  return erodeMask(dilateMask(mask, cols, rows), cols, rows);
}

function openMask(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  return dilateMask(erodeMask(mask, cols, rows), cols, rows);
}

/**
 * 3 by 3 binary dilation or erosion. Beyond the grid counts as neutral - empty
 * for dilation, full for erosion - so a building cut by the edge of the scan
 * is not worn away from that edge.
 */
function morphMask(mask: Uint8Array, cols: number, rows: number, grow: boolean): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      let result = grow ? 0 : 1;
      for (let dz = -1; dz <= 1 && result === (grow ? 0 : 1); dz += 1) {
        const r = row + dz;
        if (r < 0 || r >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = column + dx;
          if (c < 0 || c >= cols) continue;
          const value = mask[r * cols + c]!;
          if (grow ? value === 1 : value === 0) {
            result = grow ? 1 : 0;
            break;
          }
        }
      }
      out[row * cols + column] = result;
    }
  }
  return out;
}

interface Patch {
  readonly label: number;
  cells: number;
  columnSum: number;
  rowSum: number;
  minColumn: number;
  maxColumn: number;
  minRow: number;
  maxRow: number;
}

/** 8-connected patches of a mask, written into `labels` from 1 upwards. */
function labelPatches(mask: Uint8Array, cols: number, rows: number, labels: Int32Array): Patch[] {
  const patches: Patch[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    const patch: Patch = {
      label: patches.length + 1,
      cells: 0,
      columnSum: 0,
      rowSum: 0,
      minColumn: cols,
      maxColumn: -1,
      minRow: rows,
      maxRow: -1,
    };
    labels[start] = patch.label;
    stack.push(start);
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const column = cell % cols;
      const row = (cell - column) / cols;
      patch.cells += 1;
      patch.columnSum += column;
      patch.rowSum += row;
      if (column < patch.minColumn) patch.minColumn = column;
      if (column > patch.maxColumn) patch.maxColumn = column;
      if (row < patch.minRow) patch.minRow = row;
      if (row > patch.maxRow) patch.maxRow = row;
      for (let dz = -1; dz <= 1; dz += 1) {
        const r = row + dz;
        if (r < 0 || r >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = column + dx;
          if (c < 0 || c >= cols) continue;
          const neighbour = r * cols + c;
          if (mask[neighbour] === 1 && labels[neighbour] === 0) {
            labels[neighbour] = patch.label;
            stack.push(neighbour);
          }
        }
      }
    }
    patches.push(patch);
  }
  return patches;
}

/** The 95th percentile of a building's cell tops, so one antenna or chimney does not set its height. */
function roofHeight(top: Float32Array, labels: Int32Array, cols: number, patch: Patch): number {
  const heights: number[] = [];
  for (let row = patch.minRow; row <= patch.maxRow; row += 1) {
    for (let column = patch.minColumn; column <= patch.maxColumn; column += 1) {
      const cell = row * cols + column;
      if (labels[cell] === patch.label && !Number.isNaN(top[cell]!)) heights.push(top[cell]!);
    }
  }
  heights.sort((a, b) => a - b);
  return heights.length === 0 ? 0 : heights[Math.floor(0.95 * (heights.length - 1))]!;
}

/**
 * Regains the rim of a roof that the roof test rejected.
 *
 * A roof's edge cells also catch the wall below, and wall points sit deep below
 * the cell's top the way foliage does, so the depth test turns the whole rim
 * away and every footprint comes out a ring of cells too small. Walls do not
 * change a cell's top, though, nor make it rough. A building therefore takes in
 * neighbouring cells that are smooth and within a metre of the roof beside
 * them, twice, which recovers a rim and a half without reaching into a
 * canopy - a canopy is rough wherever it meets a roof.
 */
function growToWalls(
  labels: Int32Array,
  patches: Patch[],
  top: Float32Array,
  roughness: Float32Array,
  count: Uint16Array,
  vegetationLabelled: Uint8Array,
  grid: GridGeometry,
  options: ObjectDetectionOptions,
): void {
  const { cols, rows } = grid;
  const byLabel = new Map(patches.map((patch) => [patch.label, patch]));
  for (let pass = 0; pass < 2; pass += 1) {
    const joins: [number, number][] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < cols; column += 1) {
        const cell = row * cols + column;
        if (labels[cell] !== 0 || count[cell] === 0 || vegetationLabelled[cell] === 1) continue;
        const height = top[cell]!;
        if (height < options.minBuildingHeight || roughness[cell]! > options.roofRoughness) continue;
        for (let dz = -1; dz <= 1 && joins[joins.length - 1]?.[0] !== cell; dz += 1) {
          const r = row + dz;
          if (r < 0 || r >= rows) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const c = column + dx;
            if (c < 0 || c >= cols) continue;
            const neighbour = r * cols + c;
            if (labels[neighbour] !== 0 && Math.abs(top[neighbour]! - height) <= 1) {
              joins.push([cell, labels[neighbour]!]);
              break;
            }
          }
        }
      }
    }
    if (joins.length === 0) return;
    for (const [cell, label] of joins) {
      labels[cell] = label;
      const patch = byLabel.get(label)!;
      const column = cell % cols;
      const row = (cell - column) / cols;
      patch.cells += 1;
      patch.columnSum += column;
      patch.rowSum += row;
      if (column < patch.minColumn) patch.minColumn = column;
      if (column > patch.maxColumn) patch.maxColumn = column;
      if (row < patch.minRow) patch.minRow = row;
      if (row > patch.maxRow) patch.maxRow = row;
    }
  }
}

/**
 * Gives every structure taller than any tree to a building.
 *
 * The top of a tower is rarely a clean roof. Plant rooms, crowns, spires and
 * the bays of a stepped top make it rough and deep from above, which is how a
 * canopy looks, and left alone the top of a skyscraper is counted as a stand
 * of trees two hundred metres tall. No tree grows that high, so each connected
 * patch of cells above `maxTreeHeight` is a structure: it joins the building it
 * touches most, or, when it touches none and has a building's footprint,
 * becomes a building itself.
 */
function absorbTallStructures(
  labels: Int32Array,
  buildings: Patch[],
  top: Float32Array,
  count: Uint16Array,
  vegetationLabelled: Uint8Array,
  grid: GridGeometry,
  options: ObjectDetectionOptions,
): void {
  const { cols, rows, cellSize } = grid;
  const tall = new Uint8Array(labels.length);
  for (let cell = 0; cell < labels.length; cell += 1) {
    if (labels[cell] === 0 && count[cell]! > 0 && vegetationLabelled[cell] === 0 && top[cell]! > options.maxTreeHeight) tall[cell] = 1;
  }
  const structureOfCell = new Int32Array(labels.length);
  const structures = labelPatches(tall, cols, rows, structureOfCell);
  if (structures.length === 0) return;

  const byLabel = new Map(buildings.map((patch) => [patch.label, patch]));
  let nextLabel = buildings.reduce((highest, patch) => Math.max(highest, patch.label), 0) + 1;
  const minBuildingCells = options.minBuildingArea / (cellSize * cellSize);

  for (const structure of structures) {
    const touching = new Map<number, number>();
    const members: number[] = [];
    for (let row = structure.minRow; row <= structure.maxRow; row += 1) {
      for (let column = structure.minColumn; column <= structure.maxColumn; column += 1) {
        const cell = row * cols + column;
        if (structureOfCell[cell] !== structure.label) continue;
        members.push(cell);
        for (let dz = -1; dz <= 1; dz += 1) {
          const r = row + dz;
          if (r < 0 || r >= rows) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const c = column + dx;
            if (c < 0 || c >= cols) continue;
            const neighbour = labels[r * cols + c]!;
            if (neighbour !== 0) touching.set(neighbour, (touching.get(neighbour) ?? 0) + 1);
          }
        }
      }
    }

    let owner: Patch | undefined;
    if (touching.size > 0) {
      const [label] = [...touching.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
      owner = byLabel.get(label);
    } else if (structure.cells >= minBuildingCells) {
      owner = {
        label: nextLabel,
        cells: 0,
        columnSum: 0,
        rowSum: 0,
        minColumn: cols,
        maxColumn: -1,
        minRow: rows,
        maxRow: -1,
      };
      nextLabel += 1;
      buildings.push(owner);
      byLabel.set(owner.label, owner);
    }
    if (owner === undefined) continue;

    for (const cell of members) {
      const column = cell % cols;
      const row = (cell - column) / cols;
      labels[cell] = owner.label;
      owner.cells += 1;
      owner.columnSum += column;
      owner.rowSum += row;
      if (column < owner.minColumn) owner.minColumn = column;
      if (column > owner.maxColumn) owner.maxColumn = column;
      if (row < owner.minRow) owner.minRow = row;
      if (row > owner.maxRow) owner.maxRow = row;
    }
  }
}

/**
 * A footprint's area in cells, with each rim cell counted for the share of it
 * the roof actually covers.
 *
 * A rim cell straddles the edge of the roof. Counting it whole overstates a
 * small building by a fifth; counting it as half understates it, because a
 * cell only joins a building when roof points landed in it, and those are
 * mostly the better-covered cells. Points land at a steady density, though, so
 * a rim cell's share is its count of roof-surface points - those near the top,
 * leaving out wall below - over the typical count in the building's interior
 * cells. Interior cells count whole even when empty, since an empty cell inside
 * a roof is a gap in the sampling, not in the roof.
 */
function coveredCells(
  labels: Int32Array,
  count: Uint16Array,
  deep: Uint16Array,
  cols: number,
  rows: number,
  patch: Patch,
): number {
  const outside = (c: number, r: number) => c < 0 || c >= cols || r < 0 || r >= rows || labels[r * cols + c] !== patch.label;
  const interiorCounts: number[] = [];
  const rimCells: number[] = [];
  let interior = 0;
  for (let row = patch.minRow; row <= patch.maxRow; row += 1) {
    for (let column = patch.minColumn; column <= patch.maxColumn; column += 1) {
      const cell = row * cols + column;
      if (labels[cell] !== patch.label) continue;
      if (outside(column - 1, row) || outside(column + 1, row) || outside(column, row - 1) || outside(column, row + 1)) {
        rimCells.push(cell);
      } else {
        interior += 1;
        if (count[cell]! > 0) interiorCounts.push(count[cell]! - deep[cell]!);
      }
    }
  }
  if (interiorCounts.length === 0) return interior + rimCells.length / 2;
  interiorCounts.sort((a, b) => a - b);
  const typical = Math.max(1, interiorCounts[interiorCounts.length >> 1]!);
  let rim = 0;
  for (const cell of rimCells) rim += Math.min(1, (count[cell]! - deep[cell]!) / typical);
  return interior + rim;
}

function footprintOutline(labels: Int32Array, grid: GridGeometry, patch: Patch): Float32Array {
  const corners = traceOutline(labels, grid.cols, grid.rows, patch.label, patch.minColumn, patch.maxColumn, patch.minRow, patch.maxRow);
  const simplified = simplifyClosedPolygon(corners, 0.75);
  const outline = new Float32Array(simplified.length);
  for (let index = 0; index < simplified.length; index += 2) {
    outline[index] = grid.originX + simplified[index]! * grid.cellSize;
    outline[index + 1] = grid.originZ + simplified[index + 1]! * grid.cellSize;
  }
  return outline;
}

/**
 * Sparse canopies leave empty cells inside a crown, which would split it. A
 * cell with most of its neighbours in the canopy joins it at their mean height,
 * unless it borders a roof.
 */
function fillCanopyGaps(
  canopy: Uint8Array,
  chm: Float32Array,
  nearFlat: Uint8Array,
  vegetationLabelled: Uint8Array,
  cols: number,
  rows: number,
): void {
  const additions: [number, number][] = [];
  for (let row = 1; row < rows - 1; row += 1) {
    for (let column = 1; column < cols - 1; column += 1) {
      const cell = row * cols + column;
      if (canopy[cell] === 1 || (nearFlat[cell] === 1 && vegetationLabelled[cell] === 0)) continue;
      let neighbours = 0;
      let sum = 0;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const neighbour = (row + dz) * cols + column + dx;
          if (neighbour === cell || canopy[neighbour] === 0) continue;
          neighbours += 1;
          sum += chm[neighbour]!;
        }
      }
      if (neighbours >= 5) additions.push([cell, sum / neighbours]);
    }
  }
  for (const [cell, height] of additions) {
    canopy[cell] = 1;
    chm[cell] = height;
  }
}

/**
 * Drops connected stretches of canopy that are long and thin: a hedge, a tree
 * line clipped to a verge, the top of a wall.
 *
 * Opening a mask removes what is narrow along the grid axes, but a hedge a
 * metre and a bit wide covers three cells wherever the grid happens to split
 * it, and a hedge at an angle is wider still in cells. Width is measured
 * instead along each patch's own narrowest direction, from the spread of its
 * cells: for a strip of uniform width the spread across it is that width over
 * the square root of twelve. A lone tree's crown measures close to its
 * diameter, and a row of trees whose crowns touch is as wide as a single crown,
 * so both survive.
 */
function removeNarrowCanopy(canopy: Uint8Array, chm: Float32Array, grid: GridGeometry, minWidth: number): void {
  const { cols, rows, cellSize } = grid;
  const labels = new Int32Array(canopy.length);
  for (const patch of labelPatchesWithSpread(canopy, cols, rows, labels)) {
    const n = patch.cells;
    const meanX = patch.columnSum / n;
    const meanZ = patch.rowSum / n;
    const varianceX = patch.columnSquares / n - meanX * meanX;
    const varianceZ = patch.rowSquares / n - meanZ * meanZ;
    const covariance = patch.crossSum / n - meanX * meanZ;
    // Smaller eigenvalue of the 2 by 2 covariance, plus the spread a single
    // cell contributes on its own, so a patch one cell wide measures one cell.
    const halfTrace = (varianceX + varianceZ) / 2;
    const minor = halfTrace - Math.sqrt(Math.max(0, halfTrace * halfTrace - (varianceX * varianceZ - covariance * covariance))) + 1 / 12;
    const width = Math.sqrt(12 * Math.max(0, minor)) * cellSize;
    if (width >= minWidth) continue;
    for (let row = patch.minRow; row <= patch.maxRow; row += 1) {
      for (let column = patch.minColumn; column <= patch.maxColumn; column += 1) {
        const cell = row * cols + column;
        if (labels[cell] !== patch.label) continue;
        canopy[cell] = 0;
        chm[cell] = 0;
      }
    }
  }
}

interface SpreadPatch {
  readonly label: number;
  cells: number;
  columnSum: number;
  rowSum: number;
  columnSquares: number;
  rowSquares: number;
  crossSum: number;
  minColumn: number;
  maxColumn: number;
  minRow: number;
  maxRow: number;
}

function labelPatchesWithSpread(mask: Uint8Array, cols: number, rows: number, labels: Int32Array): SpreadPatch[] {
  const patches: SpreadPatch[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    const patch: SpreadPatch = {
      label: patches.length + 1,
      cells: 0,
      columnSum: 0,
      rowSum: 0,
      columnSquares: 0,
      rowSquares: 0,
      crossSum: 0,
      minColumn: cols,
      maxColumn: -1,
      minRow: rows,
      maxRow: -1,
    };
    labels[start] = patch.label;
    stack.push(start);
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const column = cell % cols;
      const row = (cell - column) / cols;
      patch.cells += 1;
      patch.columnSum += column;
      patch.rowSum += row;
      patch.columnSquares += column * column;
      patch.rowSquares += row * row;
      patch.crossSum += column * row;
      if (column < patch.minColumn) patch.minColumn = column;
      if (column > patch.maxColumn) patch.maxColumn = column;
      if (row < patch.minRow) patch.minRow = row;
      if (row > patch.maxRow) patch.maxRow = row;
      for (let dz = -1; dz <= 1; dz += 1) {
        const r = row + dz;
        if (r < 0 || r >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = column + dx;
          if (c < 0 || c >= cols) continue;
          const neighbour = r * cols + c;
          if (mask[neighbour] === 1 && labels[neighbour] === 0) {
            labels[neighbour] = patch.label;
            stack.push(neighbour);
          }
        }
      }
    }
    patches.push(patch);
  }
  return patches;
}

/** A 3 by 3 binomial blur over canopy cells only, so branch tips do not each read as a treetop. */
function smoothCanopy(canopy: Uint8Array, chm: Float32Array, cols: number, rows: number): Float32Array {
  const smoothed = new Float32Array(chm.length);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const cell = row * cols + column;
      if (canopy[cell] === 0) continue;
      let weight = 0;
      let sum = 0;
      for (let dz = -1; dz <= 1; dz += 1) {
        const r = row + dz;
        if (r < 0 || r >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = column + dx;
          if (c < 0 || c >= cols) continue;
          const neighbour = r * cols + c;
          if (canopy[neighbour] === 0) continue;
          const w = (dx === 0 ? 2 : 1) * (dz === 0 ? 2 : 1);
          weight += w;
          sum += w * chm[neighbour]!;
        }
      }
      smoothed[cell] = sum / weight;
    }
  }
  return smoothed;
}

/**
 * A crown whose longer side exceeds its shorter by more than this is a line,
 * not a tree: the top of a wall, a row of fence posts.
 */
const maxCrownElongation = 4;

export class Crown {
  public cells = 1;
  private minColumn: number;
  private maxColumn: number;
  private minRow: number;
  private maxRow: number;

  public constructor(
    public readonly label: number,
    public readonly topCell: number,
    public readonly topHeight: number,
    cols: number,
  ) {
    this.minColumn = this.maxColumn = topCell % cols;
    this.minRow = this.maxRow = (topCell - this.minColumn) / cols;
  }

  public include(column: number, row: number): void {
    this.cells += 1;
    if (column < this.minColumn) this.minColumn = column;
    if (column > this.maxColumn) this.maxColumn = column;
    if (row < this.minRow) this.minRow = row;
    if (row > this.maxRow) this.maxRow = row;
  }

  /** Ratio of the longer to the shorter side of the crown's bounding box. */
  public elongation(): number {
    const width = this.maxColumn - this.minColumn + 1;
    const depth = this.maxRow - this.minRow + 1;
    return Math.max(width, depth) / Math.min(width, depth);
  }
}

/**
 * Treetops and their crowns on a canopy height model.
 *
 * A treetop is a cell no lower than anything within a radius that grows with
 * its own height - a tall tree has a wide crown, and a smaller window would find
 * a treetop on every large branch. On a flat-topped plateau only the first cell
 * in scan order qualifies, so a plateau is one treetop rather than many.
 *
 * Crowns then grow by flooding: the highest unvisited canopy cell next to a
 * crown joins it, so where two crowns meet, the boundary settles in the
 * valley between them. A crown stops at cells below `crownFraction` of its
 * treetop and at the widest radius a tree that tall plausibly spreads to, and
 * it never climbs above its own treetop: flooding runs downhill, and a cell
 * higher than the top belongs to something else.
 */
export function segmentCrowns(
  chm: Float32Array,
  canopy: Uint8Array,
  grid: GridGeometry,
  options: Pick<ObjectDetectionOptions, "minTreeHeight" | "crownFraction" | "minObjectHeight">,
  crownOfCell: Int32Array,
): Crown[] {
  const { cols, rows, cellSize } = grid;
  const crowns: Crown[] = [];
  const heap = new CellHeap();

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const cell = row * cols + column;
      const height = chm[cell]!;
      if (canopy[cell] === 0 || height < options.minTreeHeight) continue;
      const radius = Math.max(1, Math.round(treetopWindow(height) / cellSize));
      if (!isHighestWithin(chm, canopy, cols, rows, column, row, 1) || !isHighestWithin(chm, canopy, cols, rows, column, row, radius)) {
        continue;
      }
      const crown = new Crown(crowns.length + 1, cell, height, cols);
      crowns.push(crown);
      crownOfCell[cell] = crown.label;
      heap.push(height, cell);
    }
  }

  while (heap.size > 0) {
    const cell = heap.pop();
    const crown = crowns[crownOfCell[cell]! - 1]!;
    const topColumn = crown.topCell % cols;
    const topRow = (crown.topCell - topColumn) / cols;
    const floor = Math.max(options.minObjectHeight, options.crownFraction * crown.topHeight);
    const reachCells = maxCrownRadius(crown.topHeight) / cellSize;
    const column = cell % cols;
    const row = (cell - column) / cols;
    for (let dz = -1; dz <= 1; dz += 1) {
      const r = row + dz;
      if (r < 0 || r >= rows) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const c = column + dx;
        if (c < 0 || c >= cols) continue;
        const neighbour = r * cols + c;
        if (crownOfCell[neighbour] !== 0 || canopy[neighbour] === 0 || chm[neighbour]! < floor) continue;
        if (chm[neighbour]! > crown.topHeight + 0.5) continue;
        if (Math.hypot(c - topColumn, r - topRow) > reachCells) continue;
        crownOfCell[neighbour] = crown.label;
        crown.include(c, r);
        heap.push(chm[neighbour]!, neighbour);
      }
    }
  }
  return crowns;
}

/**
 * For every cell within two cells of a building, the height of the tallest such
 * building; zero elsewhere. Used to recognise walls posing as canopy.
 */
function heightOfNearbyBuildings(buildingOfCell: Int32Array, heights: ReadonlyMap<number, number>, grid: GridGeometry): Float32Array {
  const { cols, rows } = grid;
  const near = new Float32Array(buildingOfCell.length);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const label = buildingOfCell[row * cols + column]!;
      if (label === 0) continue;
      const height = heights.get(label) ?? 0;
      for (let dz = -2; dz <= 2; dz += 1) {
        const r = row + dz;
        if (r < 0 || r >= rows) continue;
        for (let dx = -2; dx <= 2; dx += 1) {
          const c = column + dx;
          if (c < 0 || c >= cols) continue;
          const cell = r * cols + c;
          if (near[cell]! < height) near[cell] = height;
        }
      }
    }
  }
  return near;
}

/**
 * Radius searched for a higher cell before a cell counts as a treetop. A crown
 * spreads to roughly a quarter to a third of a tree's height, and foliage
 * clumps across it; a window about two thirds of the crown radius sees past
 * the clumps while staying narrower than the gap to a neighbouring treetop.
 */
function treetopWindow(height: number): number {
  return Math.min(5, Math.max(1, 0.5 + 0.2 * height));
}

/** The widest crown radius considered plausible for a tree of this height. */
function maxCrownRadius(height: number): number {
  return Math.min(12, Math.max(1.5, 1 + 0.3 * height));
}

function isHighestWithin(
  chm: Float32Array,
  canopy: Uint8Array,
  cols: number,
  rows: number,
  column: number,
  row: number,
  radius: number,
): boolean {
  const cell = row * cols + column;
  const height = chm[cell]!;
  const radiusSquared = radius * radius;
  for (let dz = -radius; dz <= radius; dz += 1) {
    const r = row + dz;
    if (r < 0 || r >= rows) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dz * dz > radiusSquared) continue;
      const c = column + dx;
      if (c < 0 || c >= cols) continue;
      const neighbour = r * cols + c;
      if (neighbour === cell || canopy[neighbour] === 0) continue;
      const other = chm[neighbour]!;
      if (other > height || (other === height && neighbour < cell)) return false;
    }
  }
  return true;
}

/** A binary max-heap of grid cells keyed by height, in typed arrays that grow as needed. */
class CellHeap {
  private heights = new Float32Array(1024);
  private cells = new Int32Array(1024);
  public size = 0;

  public push(height: number, cell: number): void {
    if (this.size === this.heights.length) {
      const heights = new Float32Array(this.size * 2);
      heights.set(this.heights);
      this.heights = heights;
      const cells = new Int32Array(this.size * 2);
      cells.set(this.cells);
      this.cells = cells;
    }
    let index = this.size;
    this.size += 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heights[parent]! >= height) break;
      this.heights[index] = this.heights[parent]!;
      this.cells[index] = this.cells[parent]!;
      index = parent;
    }
    this.heights[index] = height;
    this.cells[index] = cell;
  }

  public pop(): number {
    const result = this.cells[0]!;
    this.size -= 1;
    if (this.size === 0) return result;
    const height = this.heights[this.size]!;
    const cell = this.cells[this.size]!;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.size) break;
      const right = left + 1;
      const child = right < this.size && this.heights[right]! > this.heights[left]! ? right : left;
      if (this.heights[child]! <= height) break;
      this.heights[index] = this.heights[child]!;
      this.cells[index] = this.cells[child]!;
      index = child;
    }
    this.heights[index] = height;
    this.cells[index] = cell;
    return result;
  }
}

function validateOptions(options: ObjectDetectionOptions): void {
  if (options.cellSize !== "auto" && (!Number.isFinite(options.cellSize) || options.cellSize <= 0)) {
    throw new Error('cellSize must be "auto" or a finite number greater than zero');
  }
  const positive: (keyof ObjectDetectionOptions)[] = [
    "minObjectHeight", "roofRoughness", "crownDepth", "minBuildingHeight", "minBuildingArea",
    "minTreeHeight", "minCrownArea", "minTreePoints", "maxGridCells",
  ];
  for (const key of positive) {
    const value = options[key] as number;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a finite number greater than zero`);
  }
  for (const key of ["maxTreeHeight", "maxTreeSlenderness"] as const) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be a finite number greater than zero`);
  }
  if (!Number.isFinite(options.minCanopyWidth) || options.minCanopyWidth < 0) {
    throw new Error("minCanopyWidth must be a finite number of zero or more");
  }
  for (const key of ["maxDeepFraction", "multipleReturnFraction", "crownFraction"] as const) {
    if (!(options[key] >= 0 && options[key] <= 1)) throw new Error(`${key} must be between 0 and 1`);
  }
}
