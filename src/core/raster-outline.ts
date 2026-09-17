/**
 * Turning a patch of grid cells into a polygon a person would draw.
 *
 * A building found on a raster is a set of cells, and its honest outline is a
 * staircase along their edges. Tracing gives that staircase exactly; simplifying
 * it with a tolerance of about a cell straightens the stairs back into the walls
 * they came from, while keeping real corners - an L-shaped building stays
 * L-shaped, which a bounding box or a convex hull would not.
 */

/**
 * The outer boundary of the cells in `labels` that carry `label`, as corner
 * coordinates in cell units: `[column0, row0, column1, row1, ...]`, closed
 * implicitly from the last vertex back to the first.
 *
 * Every cell side facing outside the patch becomes a directed edge, oriented
 * so the patch is always on the same hand; shared sides between two patch
 * cells cancel. The surviving edges link head to tail into closed loops - one
 * for the outer boundary and one per enclosed courtyard - and the loop
 * enclosing the most area is the outline. Where two cells touch only at a
 * corner the walk continues into the other cell rather than turning back, so a
 * patch that is connected diagonally still yields a single loop.
 *
 * `minColumn`..`maxRow` bound the search to the patch.
 */
export function traceOutline(
  labels: Int32Array,
  cols: number,
  rows: number,
  label: number,
  minColumn: number,
  maxColumn: number,
  minRow: number,
  maxRow: number,
): Float64Array {
  const inside = (column: number, row: number): boolean =>
    column >= 0 && column < cols && row >= 0 && row < rows && labels[row * cols + column] === label;
  const corner = (column: number, row: number): number => row * (cols + 1) + column;

  const starts: number[] = [];
  const ends: number[] = [];
  const owners: number[] = [];
  const addEdge = (from: number, to: number, owner: number) => {
    starts.push(from);
    ends.push(to);
    owners.push(owner);
  };

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      if (!inside(column, row)) continue;
      const cell = row * cols + column;
      if (!inside(column, row - 1)) addEdge(corner(column, row), corner(column + 1, row), cell);
      if (!inside(column + 1, row)) addEdge(corner(column + 1, row), corner(column + 1, row + 1), cell);
      if (!inside(column, row + 1)) addEdge(corner(column + 1, row + 1), corner(column, row + 1), cell);
      if (!inside(column - 1, row)) addEdge(corner(column, row + 1), corner(column, row), cell);
    }
  }
  if (starts.length === 0) return new Float64Array(0);

  const leaving = new Map<number, number[]>();
  starts.forEach((start, edge) => {
    const list = leaving.get(start);
    if (list === undefined) leaving.set(start, [edge]);
    else list.push(edge);
  });

  const used = new Uint8Array(starts.length);
  let best: number[] = [];
  let bestArea = -Infinity;
  for (let first = 0; first < starts.length; first += 1) {
    if (used[first] === 1) continue;
    const loop: number[] = [];
    let edge = first;
    for (;;) {
      used[edge] = 1;
      loop.push(starts[edge]!);
      let next = -1;
      for (const candidate of leaving.get(ends[edge]!) ?? []) {
        if (used[candidate] === 1) continue;
        next = candidate;
        if (owners[candidate] !== owners[edge]) break;
      }
      if (next === -1) break;
      edge = next;
    }
    const area = Math.abs(signedArea(loop, cols));
    if (area > bestArea) {
      bestArea = area;
      best = loop;
    }
  }

  const outline = new Float64Array(best.length * 2);
  best.forEach((key, index) => {
    outline[index * 2] = key % (cols + 1);
    outline[index * 2 + 1] = Math.floor(key / (cols + 1));
  });
  return outline;
}

function signedArea(loop: readonly number[], cols: number): number {
  let twice = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]!;
    const b = loop[(index + 1) % loop.length]!;
    const ax = a % (cols + 1);
    const ay = Math.floor(a / (cols + 1));
    const bx = b % (cols + 1);
    const by = Math.floor(b / (cols + 1));
    twice += ax * by - bx * ay;
  }
  return twice / 2;
}

/**
 * Douglas-Peucker simplification of a closed polygon given as `[x0, y0, x1, y1, ...]`.
 *
 * A closed ring has no natural endpoints, so it is cut at its first vertex and
 * at the vertex farthest from it - two points that are certain to be kept - and
 * each half is simplified as an open line. Vertices within `tolerance` of the
 * line between kept neighbours are dropped. The result never has fewer than
 * three vertices when the input had at least three.
 */
export function simplifyClosedPolygon(points: Float64Array, tolerance: number): Float64Array {
  const count = points.length / 2;
  if (count <= 3) return points.slice();

  let far = 0;
  let farDistance = -1;
  for (let index = 1; index < count; index += 1) {
    const dx = points[index * 2]! - points[0]!;
    const dy = points[index * 2 + 1]! - points[1]!;
    const distance = dx * dx + dy * dy;
    if (distance > farDistance) {
      farDistance = distance;
      far = index;
    }
  }

  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[far] = 1;
  markKept(points, 0, far, tolerance, keep);
  markKept(points, far, count, tolerance, keep);

  const kept: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (keep[index] === 1) kept.push(points[index * 2]!, points[index * 2 + 1]!);
  }
  return Float64Array.from(kept);
}

/**
 * Marks the vertices of the open chain from `first` to `last` that must stay.
 * `last` may equal the vertex count, meaning the chain wraps back to vertex 0.
 * Iterative, so a long outline cannot overflow the call stack.
 */
function markKept(points: Float64Array, first: number, last: number, tolerance: number, keep: Uint8Array): void {
  const count = points.length / 2;
  const stack: [number, number][] = [[first, last]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    if (to - from < 2) continue;
    const fromIndex = from % count;
    const toIndex = to % count;
    const ax = points[fromIndex * 2]!;
    const ay = points[fromIndex * 2 + 1]!;
    const bx = points[toIndex * 2]!;
    const by = points[toIndex * 2 + 1]!;
    const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;

    let worst = -1;
    let worstDistance = -1;
    for (let index = from + 1; index < to; index += 1) {
      const px = points[index * 2]!;
      const py = points[index * 2 + 1]!;
      const distance =
        lengthSquared === 0
          ? Math.hypot(px - ax, py - ay)
          : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / Math.sqrt(lengthSquared);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = index;
      }
    }
    if (worstDistance > tolerance) {
      keep[worst] = 1;
      stack.push([from, worst], [worst, to]);
    }
  }
}
