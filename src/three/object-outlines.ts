import { Scene, type Camera, type WebGLRenderer } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { DetectedBuilding, DetectedObject, DetectedTree } from "../core/object-detection.js";
import { pullTowardCamera } from "./depth-pull.js";

const crownSegments = 28;

/**
 * How far toward the camera outlines are drawn, as a fraction of their
 * distance. A roof outline sits at the roof's measured height with roof points
 * all around it, and a crown ring sits inside its crown; without this nudge
 * the points they describe would hide them.
 */
const depthPull = 0.02;

/**
 * Outlines drawn over the scan for every detected building and tree, in a
 * pass of their own after the points.
 *
 * Buildings are drawn as their traced footprint at roof height, and trees as a
 * ring the width of the crown at about its widest. That is all a count needs.
 * Prisms with a line down every corner, and a stem under every tree, were
 * tried first: on a real city block with hundreds of trees and towers with
 * dozens of corners they buried the scan they were meant to annotate.
 *
 * Outlines are depth tested against the points, so a tree ring behind a tower
 * is hidden by the tower rather than painted over its wall. Drawing the hidden
 * parts faintly was tried and dropped: close to a tower, dozens of faint rings
 * across its wall still read as green over the building.
 *
 * WebGL draws plain lines one pixel wide on nearly every platform, too faint
 * over millions of points, so these are Three.js's screen-space lines with a
 * real width.
 */
export class ObjectOutlines {
  private readonly scene = new Scene();
  private readonly buildingMaterial = outlineMaterial(0xffb561);
  private readonly treeMaterial = outlineMaterial(0x86f0a2);
  private buildings: LineSegments2 | undefined;
  private trees: LineSegments2 | undefined;
  private showBuildings = true;
  private showTrees = true;

  public setObjects(objects: readonly DetectedObject[] | undefined): void {
    this.clear();
    if (objects === undefined) return;
    const buildingSegments = roofOutlines(objects.filter((object): object is DetectedBuilding => object.kind === "building"));
    const treeSegments = crownRings(objects.filter((object): object is DetectedTree => object.kind === "tree"));
    if (buildingSegments.length > 0) {
      this.buildings = segmentsOf(buildingSegments, this.buildingMaterial);
      this.scene.add(this.buildings);
    }
    if (treeSegments.length > 0) {
      this.trees = segmentsOf(treeSegments, this.treeMaterial);
      this.scene.add(this.trees);
    }
    this.applyVisibility();
  }

  public setVisibility(buildings: boolean, trees: boolean): void {
    this.showBuildings = buildings;
    this.showTrees = trees;
    this.applyVisibility();
  }

  /** Line width is in pixels, so the materials need the size of the surface they draw into. */
  public setResolution(width: number, height: number): void {
    this.buildingMaterial.resolution.set(width, height);
    this.treeMaterial.resolution.set(width, height);
  }

  /**
   * Draws over whatever the bound surface already holds, without clearing it.
   * The surface must still hold the depth of the points drawn into it, so the
   * outlines can be tested against them.
   */
  public render(renderer: WebGLRenderer, camera: Camera): void {
    const anything = (this.buildings?.visible ?? false) || (this.trees?.visible ?? false);
    if (!anything) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, camera);
    renderer.autoClear = autoClear;
  }

  public dispose(): void {
    this.clear();
    this.buildingMaterial.dispose();
    this.treeMaterial.dispose();
  }

  private applyVisibility(): void {
    if (this.buildings !== undefined) this.buildings.visible = this.showBuildings;
    if (this.trees !== undefined) this.trees.visible = this.showTrees;
  }

  private clear(): void {
    for (const lines of [this.buildings, this.trees]) {
      if (lines === undefined) continue;
      this.scene.remove(lines);
      lines.geometry.dispose();
    }
    this.buildings = undefined;
    this.trees = undefined;
  }
}

function outlineMaterial(color: number): LineMaterial {
  const material = new LineMaterial({
    color,
    linewidth: 1.6,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: false,
  });
  pullTowardCamera(material, depthPull);
  return material;
}

function segmentsOf(positions: number[], material: LineMaterial): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const lines = new LineSegments2(geometry, material);
  lines.renderOrder = 10;
  lines.frustumCulled = false;
  return lines;
}

function roofOutlines(buildings: readonly DetectedBuilding[]): number[] {
  const segments: number[] = [];
  for (const building of buildings) {
    const corners = building.outline.length / 2;
    const roof = building.groundY + building.height;
    for (let index = 0; index < corners; index += 1) {
      const next = (index + 1) % corners;
      segments.push(
        building.outline[index * 2]!, roof, building.outline[index * 2 + 1]!,
        building.outline[next * 2]!, roof, building.outline[next * 2 + 1]!,
      );
    }
  }
  return segments;
}

function crownRings(trees: readonly DetectedTree[]): number[] {
  const segments: number[] = [];
  for (const tree of trees) {
    const [x, top, z] = tree.top;
    // A crown is widest a little below its middle, not at the treetop.
    const ringHeight = top - 0.4 * tree.height;
    for (let index = 0; index < crownSegments; index += 1) {
      const from = (index / crownSegments) * Math.PI * 2;
      const to = ((index + 1) / crownSegments) * Math.PI * 2;
      segments.push(
        x + Math.cos(from) * tree.crownRadius, ringHeight, z + Math.sin(from) * tree.crownRadius,
        x + Math.cos(to) * tree.crownRadius, ringHeight, z + Math.sin(to) * tree.crownRadius,
      );
    }
  }
  return segments;
}
