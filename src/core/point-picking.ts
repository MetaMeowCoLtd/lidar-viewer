import type { PointCloud, PointCloudBounds } from "./point-cloud.js";

/**
 * Finding the scan point under the cursor.
 *
 * A point cloud has no surfaces for a ray to hit, so a click is answered on
 * screen instead: every point is projected with the same matrix the GPU uses,
 * and the ones whose drawn dot covers the cursor are candidates. Of those, the
 * nearest to the camera is the one the user actually sees, because it is the
 * one the depth test kept. When the cursor lands in a gap between dots, the
 * point closest to it on screen within a small tolerance is taken instead, so
 * a click that is a pixel off still finds something.
 *
 * Projection is a few multiplications per point, and whole regions are ruled
 * out first by projecting the corners of their bounds, so a click over a scan
 * of millions of points only examines the tiles under the cursor.
 */
export interface PickView {
  /** Projection times view, column-major as Three.js stores it. */
  readonly viewProjection: ArrayLike<number>;
  /** Size of the drawing surface, in the same pixels as the cursor. */
  readonly width: number;
  readonly height: number;
  /** Cursor position from the surface's top-left corner. */
  readonly cursorX: number;
  readonly cursorY: number;
  /** Radius of the dot drawn for a point at this distance in front of the camera. */
  readonly dotRadius: (depth: number) => number;
  /** How far from the cursor, when no dot covers it, a point may still be picked. */
  readonly tolerance: number;
  /** The largest radius {@link dotRadius} ever returns, used to rule out whole regions. */
  readonly maxDotRadius: number;
  /** Points that are not drawn, and so cannot be picked. */
  readonly skip?: ((cloud: PointCloud, index: number) => boolean) | undefined;
}

export interface PointHit {
  readonly cloud: PointCloud;
  readonly index: number;
  /** Distance in front of the camera. */
  readonly depth: number;
}

export function pickPoint(clouds: readonly PointCloud[], view: PickView): PointHit | undefined {
  const m = view.viewProjection;
  const reach = Math.max(view.tolerance, view.maxDotRadius);
  const halfWidth = view.width / 2;
  const halfHeight = view.height / 2;

  let covering: PointHit | undefined;
  let nearest: PointHit | undefined;
  let nearestDistance = view.tolerance * view.tolerance;

  for (const cloud of clouds) {
    if (!mayContainCursor(cloud.bounds, view, reach)) continue;
    const positions = cloud.positions;
    for (let index = 0, offset = 0; index < cloud.pointCount; index += 1, offset += 3) {
      const x = positions[offset]!;
      const y = positions[offset + 1]!;
      const z = positions[offset + 2]!;
      const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      if (w <= 0) continue;
      const screenX = ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w + 1) * halfWidth;
      const dx = screenX - view.cursorX;
      if (dx > reach || dx < -reach) continue;
      const screenY = (1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) * halfHeight;
      const dy = screenY - view.cursorY;
      if (dy > reach || dy < -reach) continue;
      // Outside the near and far planes, the GPU clipped it away.
      const clipZ = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      if (clipZ < -w || clipZ > w) continue;
      if (view.skip !== undefined && view.skip(cloud, index)) continue;

      const distance = dx * dx + dy * dy;
      const radius = view.dotRadius(w);
      if (distance <= radius * radius) {
        if (covering === undefined || w < covering.depth) covering = { cloud, index, depth: w };
      } else if (covering === undefined && distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { cloud, index, depth: w };
      }
    }
  }
  return covering ?? nearest;
}

/**
 * False only when a region's bounds certainly project clear of the cursor.
 * A box that crosses the plane of the camera has no meaningful screen
 * rectangle, so it is always searched.
 */
function mayContainCursor(bounds: PointCloudBounds, view: PickView, reach: number): boolean {
  const m = view.viewProjection;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let corner = 0; corner < 8; corner += 1) {
    const x = corner & 1 ? bounds.max[0] : bounds.min[0];
    const y = corner & 2 ? bounds.max[1] : bounds.min[1];
    const z = corner & 4 ? bounds.max[2] : bounds.min[2];
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (w <= 0) return true;
    const screenX = ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w + 1) * (view.width / 2);
    const screenY = (1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) * (view.height / 2);
    minX = Math.min(minX, screenX);
    maxX = Math.max(maxX, screenX);
    minY = Math.min(minY, screenY);
    maxY = Math.max(maxY, screenY);
  }
  return (
    view.cursorX >= minX - reach &&
    view.cursorX <= maxX + reach &&
    view.cursorY >= minY - reach &&
    view.cursorY <= maxY + reach
  );
}
