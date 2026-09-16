/**
 * Regular grids over the ground plane, and the raster operations ground
 * detection is built from.
 *
 * The viewer is Y-up, so a grid spans x and z and stores a height in y. Cell
 * (column, row) covers x from `originX + column * cellSize` up to the next
 * column, and z likewise; its centre sits half a cell in. Empty cells hold NaN
 * until they are filled.
 *
 * Everything here works on flat typed arrays with no per-cell allocation, so
 * it runs the same in a worker as on the main thread and scales to a few
 * million cells.
 */
export interface GridGeometry {
  readonly originX: number;
  readonly originZ: number;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
}

/**
 * Lays a grid over an extent. When the requested cell size would need more
 * than `maxCells` cells, the cells grow until the grid fits: a large survey
 * area gets a coarser surface rather than exhausting memory, and the caller
 * can report the cell size that was actually used.
 */
export function gridForExtent(
  minX: number,
  minZ: number,
  sizeX: number,
  sizeZ: number,
  requestedCellSize: number,
  maxCells: number,
): GridGeometry {
  if (!Number.isFinite(requestedCellSize) || requestedCellSize <= 0) {
    throw new Error("cellSize must be a finite number greater than zero");
  }
  if (!Number.isFinite(maxCells) || maxCells < 4) throw new Error("maxCells must allow at least a 2 by 2 grid");

  let cellSize = requestedCellSize;
  const cellsAlong = (size: number): number => Math.floor(Math.max(0, size) / cellSize) + 1;
  if (cellsAlong(sizeX) * cellsAlong(sizeZ) > maxCells) {
    cellSize = Math.max(cellSize, Math.sqrt((sizeX * sizeZ) / maxCells));
    while (cellsAlong(sizeX) * cellsAlong(sizeZ) > maxCells) cellSize *= 1.05;
  }
  return { originX: minX, originZ: minZ, cellSize, cols: cellsAlong(sizeX), rows: cellsAlong(sizeZ) };
}

/** Index of the cell holding a ground-plane position, clamped onto the grid. */
export function cellIndex(grid: GridGeometry, x: number, z: number): number {
  let column = Math.floor((x - grid.originX) / grid.cellSize);
  let row = Math.floor((z - grid.originZ) / grid.cellSize);
  if (column < 0) column = 0;
  else if (column >= grid.cols) column = grid.cols - 1;
  if (row < 0) row = 0;
  else if (row >= grid.rows) row = grid.rows - 1;
  return row * grid.cols + column;
}

/**
 * The lowest height in each cell, from positions in viewer axes. Points
 * flagged in `skip` are left out, which is how known noise is kept from
 * dragging the surface down.
 */
export function minimumSurface(positions: Float32Array, grid: GridGeometry, skip?: Uint8Array): Float32Array {
  const surface = new Float32Array(grid.cols * grid.rows).fill(Number.NaN);
  for (let point = 0, offset = 0; offset < positions.length; point += 1, offset += 3) {
    if (skip !== undefined && skip[point] === 1) continue;
    const cell = cellIndex(grid, positions[offset]!, positions[offset + 2]!);
    const height = positions[offset + 1]!;
    const current = surface[cell]!;
    if (!(current <= height)) surface[cell] = height;
  }
  return surface;
}

/**
 * Fills every empty cell from the cells around it, using a push-pull
 * pyramid: filled cells are averaged down into ever coarser levels until a
 * level has no gaps, then each finer level takes its missing cells from a
 * bilinear read of the level above.
 *
 * It runs in time proportional to the cell count however large the holes are,
 * and a hole under a building or over water comes out as a smooth blend of its
 * rim rather than a flat plateau. Filled cells are never modified.
 *
 * Returns false, leaving the grid untouched, when there is no data to fill
 * from at all.
 */
export function fillEmptyCells(values: Float32Array, cols: number, rows: number): boolean {
  const weights = new Float32Array(values.length);
  let filled = 0;
  for (let cell = 0; cell < values.length; cell += 1) {
    if (values[cell] === values[cell]) {
      weights[cell] = 1;
      filled += 1;
    }
  }
  if (filled === 0) return false;
  if (filled === values.length) return true;

  const levels = [{ values, weights, cols, rows }];
  for (;;) {
    const fine = levels[levels.length - 1]!;
    if (fine.cols === 1 && fine.rows === 1) break;
    const coarseCols = Math.ceil(fine.cols / 2);
    const coarseRows = Math.ceil(fine.rows / 2);
    const coarseValues = new Float32Array(coarseCols * coarseRows);
    const coarseWeights = new Float32Array(coarseCols * coarseRows);
    for (let row = 0; row < fine.rows; row += 1) {
      for (let column = 0; column < fine.cols; column += 1) {
        const source = row * fine.cols + column;
        const weight = fine.weights[source]!;
        if (weight === 0) continue;
        const target = (row >> 1) * coarseCols + (column >> 1);
        coarseValues[target] = coarseValues[target]! + fine.values[source]! * weight;
        coarseWeights[target] = coarseWeights[target]! + weight;
      }
    }
    let gaps = 0;
    for (let cell = 0; cell < coarseValues.length; cell += 1) {
      if (coarseWeights[cell]! > 0) coarseValues[cell] = coarseValues[cell]! / coarseWeights[cell]!;
      else {
        coarseValues[cell] = Number.NaN;
        gaps += 1;
      }
    }
    levels.push({ values: coarseValues, weights: coarseWeights, cols: coarseCols, rows: coarseRows });
    if (gaps === 0) break;
  }

  for (let level = levels.length - 1; level > 0; level -= 1) {
    const coarse = levels[level]!;
    const fine = levels[level - 1]!;
    for (let row = 0; row < fine.rows; row += 1) {
      for (let column = 0; column < fine.cols; column += 1) {
        const cell = row * fine.cols + column;
        if (fine.weights[cell]! > 0) continue;
        fine.values[cell] = bilinear(coarse.values, coarse.cols, coarse.rows, (column + 0.5) / 2 - 0.5, (row + 0.5) / 2 - 0.5);
      }
    }
  }
  return true;
}

/**
 * Lifts small pits out of a minimum surface.
 *
 * Laser scans carry low outliers - multipath returns, reflections off glass
 * and water - and a single one pulls a minimum surface into a pit. A
 * morphological opening removes bumps but cannot fill pits, so without this
 * each outlier becomes a crater that makes the real ground around it look
 * raised.
 *
 * A cell is a candidate when it sits `depth` below the median of its
 * neighbours. That alone would also catch the floor of a ditch or a hollow, so
 * candidates are grouped into connected patches and only patches of one or two
 * cells are lifted - the footprint of an outlier or a pair of them. A ditch
 * stays a long patch and a hollow stays a wide one however they are
 * approached, which a purely local rule cannot promise: the open end of a
 * ditch looks exactly like a pair of pits through a 3 by 3 window.
 *
 * Each lifted cell takes the lowest of its neighbours that is not itself a
 * candidate, keeping the surface a minimum surface. Returns how many cells
 * were lifted.
 */
export function raiseIsolatedPits(values: Float32Array, cols: number, rows: number, depth: number, maxPatchCells = 2): number {
  const candidate = new Uint8Array(values.length);
  const neighbourhood = new Float32Array(8);
  let candidates = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      let count = 0;
      for (let dRow = -1; dRow <= 1; dRow += 1) {
        const neighbourRow = row + dRow;
        if (neighbourRow < 0 || neighbourRow >= rows) continue;
        for (let dColumn = -1; dColumn <= 1; dColumn += 1) {
          if (dRow === 0 && dColumn === 0) continue;
          const neighbourColumn = column + dColumn;
          if (neighbourColumn < 0 || neighbourColumn >= cols) continue;
          neighbourhood[count] = values[neighbourRow * cols + neighbourColumn]!;
          count += 1;
        }
      }
      if (count < 3) continue;
      const cell = row * cols + column;
      if (values[cell]! < lowerMedian(neighbourhood, count) - depth) {
        candidate[cell] = 1;
        candidates += 1;
      }
    }
  }
  if (candidates === 0) return 0;

  const patch: number[] = [];
  const stack: number[] = [];
  const seen = new Uint8Array(values.length);
  let lifted = 0;
  for (let start = 0; start < values.length; start += 1) {
    if (candidate[start] === 0 || seen[start] === 1) continue;
    patch.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      patch.push(cell);
      const row = Math.floor(cell / cols);
      const column = cell - row * cols;
      for (let dRow = -1; dRow <= 1; dRow += 1) {
        const neighbourRow = row + dRow;
        if (neighbourRow < 0 || neighbourRow >= rows) continue;
        for (let dColumn = -1; dColumn <= 1; dColumn += 1) {
          const neighbourColumn = column + dColumn;
          if (neighbourColumn < 0 || neighbourColumn >= cols) continue;
          const neighbour = neighbourRow * cols + neighbourColumn;
          if (candidate[neighbour] === 1 && seen[neighbour] === 0) {
            seen[neighbour] = 1;
            stack.push(neighbour);
          }
        }
      }
    }
    if (patch.length > maxPatchCells) continue;

    for (const cell of patch) {
      const row = Math.floor(cell / cols);
      const column = cell - row * cols;
      let lowestSolid = Infinity;
      for (let dRow = -1; dRow <= 1; dRow += 1) {
        const neighbourRow = row + dRow;
        if (neighbourRow < 0 || neighbourRow >= rows) continue;
        for (let dColumn = -1; dColumn <= 1; dColumn += 1) {
          const neighbourColumn = column + dColumn;
          if (neighbourColumn < 0 || neighbourColumn >= cols) continue;
          const neighbour = neighbourRow * cols + neighbourColumn;
          if (candidate[neighbour] === 0 && values[neighbour]! < lowestSolid) lowestSolid = values[neighbour]!;
        }
      }
      if (lowestSolid !== Infinity) {
        values[cell] = lowestSolid;
        lifted += 1;
      }
    }
  }
  return lifted;
}

/** The lower of the two middle values among the first `count` entries, without reordering them. */
function lowerMedian(values: Float32Array, count: number): number {
  const rank = (count - 1) >> 1;
  for (let i = 0; i < count; i += 1) {
    let below = 0;
    let equal = 0;
    const value = values[i]!;
    for (let j = 0; j < count; j += 1) {
      if (values[j]! < value) below += 1;
      else if (values[j] === value) equal += 1;
    }
    if (below <= rank && rank < below + equal) return value;
  }
  return values[0]!;
}

/**
 * Grayscale erosion with a square window: each cell takes the lowest value
 * within `radius` cells of it, with the window clipped at the grid edge. The
 * grid must contain no NaN.
 */
export function erode(source: Float32Array, target: Float32Array, cols: number, rows: number, radius: number): void {
  const scratch = new Float32Array(source.length);
  filterLines(source, scratch, rows, cols, cols, 1, radius, true, false);
  filterLines(scratch, target, cols, rows, 1, cols, radius, true, false);
}

/**
 * Grayscale dilation with a square window: each cell takes the highest value
 * within `radius` cells of it, with the window clipped at the grid edge. The
 * grid must contain no NaN.
 */
export function dilate(source: Float32Array, target: Float32Array, cols: number, rows: number, radius: number): void {
  const scratch = new Float32Array(source.length);
  filterLines(source, scratch, rows, cols, cols, 1, radius, false, false);
  filterLines(scratch, target, cols, rows, 1, cols, radius, false, false);
}

/**
 * Morphological opening of a terrain surface: erosion, then dilation, never
 * raising any cell above where it started.
 *
 * A textbook opening clips its window at the grid edge, and on the uphill side
 * of a slope that is wrong: the window cannot see the terrain continuing to
 * rise past the edge, so the dilation falls short and real ground reads as an
 * object that the filter shaved off. Survey tiles cut through hillsides
 * routinely, so this would put a band of misclassified ground along the high
 * edge of every sloping tile.
 *
 * Here both passes instead extend each line past the edge along the slope of
 * its last radius of cells. That makes the erosion of a tilted plane another
 * exact plane, and the dilation of that plane the original, so a plane comes
 * back unchanged at every edge - including when the scan is narrower than the
 * window, where extrapolating only the dilation would measure its slope across
 * a region the erosion had already flattened. Extrapolation can overshoot on
 * rough ground, so the result is clamped to the input: an opening that can
 * only lower a surface cannot raise one.
 */
export function openSurface(source: Float32Array, target: Float32Array, cols: number, rows: number, radius: number): void {
  const scratch = new Float32Array(source.length);
  const eroded = new Float32Array(source.length);
  filterLines(source, scratch, rows, cols, cols, 1, radius, true, true);
  filterLines(scratch, eroded, cols, rows, 1, cols, radius, true, true);
  filterLines(eroded, scratch, rows, cols, cols, 1, radius, false, true);
  filterLines(scratch, target, cols, rows, 1, cols, radius, false, true);
  for (let cell = 0; cell < target.length; cell += 1) {
    if (target[cell]! > source[cell]!) target[cell] = source[cell]!;
  }
}

/**
 * Running minimum or maximum along every line of a grid, by the van Herk /
 * Gil-Werman method. Lines are padded past each end either with a neutral
 * value, which clips the window, or by extrapolating the line's own slope.
 *
 * A square window separates into a pass along rows and a pass along columns,
 * and each pass is split into blocks one window wide with a prefix and a
 * suffix extreme per block. Any window is then exactly one suffix plus one
 * prefix, so the cost per cell is constant regardless of radius. That matters
 * because ground detection opens the surface at every radius up to its largest
 * window, and a direct scan would grow with the square of the radius.
 *
 * Padding by a full radius on both ends means no window is ever cut short,
 * which is the one case the block decomposition cannot express.
 */
function filterLines(
  source: Float32Array,
  target: Float32Array,
  lineCount: number,
  lineLength: number,
  lineStride: number,
  step: number,
  radius: number,
  takeMinimum: boolean,
  extrapolateEdges: boolean,
): void {
  const width = 2 * radius + 1;
  const paddedLength = lineLength + 2 * radius;
  const padded = new Float32Array(paddedLength);
  const prefix = new Float32Array(paddedLength);
  const suffix = new Float32Array(paddedLength);
  const neutral = takeMinimum ? Infinity : -Infinity;
  const lastBlockPosition = (paddedLength - 1) % width;
  const reach = Math.min(radius, lineLength - 1);

  for (let line = 0; line < lineCount; line += 1) {
    const start = line * lineStride;
    for (let k = 0; k < lineLength; k += 1) padded[radius + k] = source[start + k * step]!;
    if (extrapolateEdges) {
      // The secant across a whole radius, not the last two cells, so noise at
      // the very edge is not amplified across the padding.
      const first = source[start]!;
      const last = source[start + (lineLength - 1) * step]!;
      const headSlope = reach === 0 ? 0 : (first - source[start + reach * step]!) / reach;
      const tailSlope = reach === 0 ? 0 : (last - source[start + (lineLength - 1 - reach) * step]!) / reach;
      for (let j = 1; j <= radius; j += 1) {
        padded[radius - j] = first + headSlope * j;
        padded[radius + lineLength - 1 + j] = last + tailSlope * j;
      }
    } else {
      padded.fill(neutral, 0, radius);
      padded.fill(neutral, radius + lineLength);
    }

    let position = 0;
    let running = 0;
    for (let j = 0; j < paddedLength; j += 1) {
      const value = padded[j]!;
      if (position === 0) running = value;
      else if (takeMinimum ? value < running : value > running) running = value;
      prefix[j] = running;
      position = position + 1 === width ? 0 : position + 1;
    }

    position = lastBlockPosition;
    for (let j = paddedLength - 1; j >= 0; j -= 1) {
      const value = padded[j]!;
      if (j === paddedLength - 1 || position === width - 1) running = value;
      else if (takeMinimum ? value < running : value > running) running = value;
      suffix[j] = running;
      position = position === 0 ? width - 1 : position - 1;
    }

    for (let k = 0; k < lineLength; k += 1) {
      const left = suffix[k]!;
      const right = prefix[k + width - 1]!;
      target[start + k * step] = takeMinimum ? (left < right ? left : right) : left > right ? left : right;
    }
  }
}

/**
 * Magnitude of the surface gradient at each cell, as rise over run. Central
 * differences inside the grid, one-sided at its edges.
 */
export function slopeMagnitudes(values: Float32Array, grid: GridGeometry): Float32Array {
  const { cols, rows, cellSize } = grid;
  const slopes = new Float32Array(values.length);
  for (let row = 0; row < rows; row += 1) {
    const above = row > 0 ? row - 1 : row;
    const below = row < rows - 1 ? row + 1 : row;
    for (let column = 0; column < cols; column += 1) {
      const left = column > 0 ? column - 1 : column;
      const right = column < cols - 1 ? column + 1 : column;
      const gradientX = right === left ? 0 : (values[row * cols + right]! - values[row * cols + left]!) / ((right - left) * cellSize);
      const gradientZ = below === above ? 0 : (values[below * cols + column]! - values[above * cols + column]!) / ((below - above) * cellSize);
      slopes[row * cols + column] = Math.sqrt(gradientX * gradientX + gradientZ * gradientZ);
    }
  }
  return slopes;
}

/** Height of a filled surface at a ground-plane position, interpolated between cell centres. */
export function sampleSurface(values: Float32Array, grid: GridGeometry, x: number, z: number): number {
  return bilinear(values, grid.cols, grid.rows, (x - grid.originX) / grid.cellSize - 0.5, (z - grid.originZ) / grid.cellSize - 0.5);
}

function bilinear(values: Float32Array, cols: number, rows: number, u: number, v: number): number {
  const clampedU = u < 0 ? 0 : u > cols - 1 ? cols - 1 : u;
  const clampedV = v < 0 ? 0 : v > rows - 1 ? rows - 1 : v;
  const column = Math.floor(clampedU);
  const row = Math.floor(clampedV);
  const nextColumn = column + 1 < cols ? column + 1 : column;
  const nextRow = row + 1 < rows ? row + 1 : row;
  const tu = clampedU - column;
  const tv = clampedV - row;
  const top = values[row * cols + column]! * (1 - tu) + values[row * cols + nextColumn]! * tu;
  const bottom = values[nextRow * cols + column]! * (1 - tu) + values[nextRow * cols + nextColumn]! * tu;
  return top * (1 - tv) + bottom * tv;
}
