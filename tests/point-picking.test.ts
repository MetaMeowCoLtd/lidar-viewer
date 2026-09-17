import { describe, expect, it } from "vitest";
import { Matrix4, PerspectiveCamera } from "three";
import { PointCloud, pickPoint, type PickView } from "../src/index.js";

/** A 400 x 300 view from 10 units up the z axis, looking at the origin. */
function view(cursorX: number, cursorY: number, overrides: Partial<PickView> = {}): PickView {
  const camera = new PerspectiveCamera(60, 400 / 300, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const viewProjection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return {
    viewProjection: viewProjection.elements,
    width: 400,
    height: 300,
    cursorX,
    cursorY,
    dotRadius: () => 3,
    maxDotRadius: 3,
    tolerance: 8,
    ...overrides,
  };
}

const cloud = (...points: [number, number, number][]) => new PointCloud({ positions: Float32Array.from(points.flat()) });

describe("point picking", () => {
  it("picks the nearest of the points drawn under the cursor", () => {
    const scan = cloud([0, 0, -5], [0, 0, 2], [0, 0, 0]);
    const hit = pickPoint([scan], view(200, 150));
    expect(hit?.index).toBe(1);
    expect(hit?.depth).toBeCloseTo(8, 5);
  });

  it("maps screen x to the right and screen y downwards", () => {
    const scan = cloud([2, 0, 0], [0, 2, 0]);
    // One unit at a distance of ten spans 300 / (2 tan 30deg) / 10 = 26 pixels.
    const unit = 300 / (2 * Math.tan(Math.PI / 6)) / 10;
    expect(pickPoint([scan], view(200 + 2 * unit, 150))?.index).toBe(0);
    expect(pickPoint([scan], view(200, 150 - 2 * unit))?.index).toBe(1);
  });

  it("falls back to the closest point on screen when the cursor is in a gap", () => {
    const unit = 300 / (2 * Math.tan(Math.PI / 6)) / 10;
    const scan = cloud([0, 0, 0], [0.5, 0, 0]);
    const small = { dotRadius: () => 2, maxDotRadius: 2 };
    // The points are 13 pixels apart and the cursor lands between their dots.
    expect(pickPoint([scan], view(200 + 0.5 * unit - 4.5, 150, small))?.index).toBe(1);
    expect(pickPoint([scan], view(200 + 4, 150, small))?.index).toBe(0);
    expect(pickPoint([scan], view(200, 250, small))).toBeUndefined();
  });

  it("prefers a dot that covers the cursor over a nearer one that only comes close", () => {
    const scan = cloud([0, 0, -20], [0.2, 0, 5]);
    // The far point sits exactly under the cursor; the near one is a few pixels off with a small dot.
    const hit = pickPoint([scan], view(200, 150, { dotRadius: (depth) => (depth > 10 ? 4 : 1), maxDotRadius: 4 }));
    expect(hit?.index).toBe(0);
  });

  it("ignores points behind the camera or beyond the far plane", () => {
    const scan = cloud([0, 0, 20], [0, 0, -500]);
    expect(pickPoint([scan], view(200, 150))).toBeUndefined();
  });

  it("searches every region the cursor may fall in and reports which cloud was hit", () => {
    const left = cloud([-3, 0, 0], [-3, 1, 0]);
    const right = cloud([3, 0, 0], [3, 1, 0]);
    const unit = 300 / (2 * Math.tan(Math.PI / 6)) / 10;
    const hit = pickPoint([left, right], view(200 + 3 * unit, 150 - unit));
    expect(hit?.cloud).toBe(right);
    expect(hit?.index).toBe(1);
  });

  it("still searches a region that surrounds the camera", () => {
    const around = cloud([0, 0, 50], [0, 0, 0], [0, 0, -50]);
    expect(pickPoint([around], view(200, 150))?.index).toBe(1);
  });
});
