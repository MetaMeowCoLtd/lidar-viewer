import { GreaterDepth, LessEqualDepth, Scene, type Camera, type DepthModes, type WebGLRenderer } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { DetectedBuilding, DetectedObject, DetectedTree } from "../core/object-detection.js";

const crownSegments = 28;

/**
 * How far toward the camera outlines are drawn, as a fraction of their
 * distance. A roof outline sits at the roof's measured height with roof points
 * all around it, and a crown ring sits inside its crown; without this nudge
 * the points they describe would hide them. Scaling a position toward the
 * camera leaves it at the same place on screen and only changes its depth,
 * and a fraction of the distance keeps the nudge in proportion to how large
 * points are drawn at that distance.
 */
const depthPull = 0.02;
/** Opacity of the parts of an outline that the scan hides. */
const hiddenOpacity = 0.16;

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
 * is behind it on screen rather than painted over its wall. The hidden parts
 * are still drawn, faintly, in a second pass that only passes where the scan
 * is in front: for a count, knowing an object is there matters, but it must
 * not read as sitting in front of what hides it. WebGL draws plain lines one
 * pixel wide on nearly every platform, too faint over millions of points, so
 * these are Three.js's screen-space lines with a real width.
 */
export class ObjectOutlines {
  private readonly scene = new Scene();
  private readonly buildingMaterial = outlineMaterial(0xffb561, 0.9, LessEqualDepth);
  private readonly treeMaterial = outlineMaterial(0x86f0a2, 0.9, LessEqualDepth);
  private readonly hiddenBuildingMaterial = outlineMaterial(0xffb561, hiddenOpacity, GreaterDepth);
  private readonly hiddenTreeMaterial = outlineMaterial(0x86f0a2, hiddenOpacity, GreaterDepth);
  private buildings: LineSegments2[] = [];
  private trees: LineSegments2[] = [];
  private showBuildings = true;
  private showTrees = true;

  public setObjects(objects: readonly DetectedObject[] | undefined): void {
    this.clear();
    if (objects === undefined) return;
    const buildingSegments = roofOutlines(objects.filter((object): object is DetectedBuilding => object.kind === "building"));
    const treeSegments = crownRings(objects.filter((object): object is DetectedTree => object.kind === "tree"));
    if (buildingSegments.length > 0) {
      this.buildings = linesOf(buildingSegments, this.buildingMaterial, this.hiddenBuildingMaterial);
      this.scene.add(...this.buildings);
    }
    if (treeSegments.length > 0) {
      this.trees = linesOf(treeSegments, this.treeMaterial, this.hiddenTreeMaterial);
      this.scene.add(...this.trees);
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
    for (const material of this.materials()) material.resolution.set(width, height);
  }

  /**
   * Draws over whatever the bound surface already holds, without clearing it.
   * The surface must still hold the depth of the points drawn into it, so the
   * outlines can be tested against them.
   */
  public render(renderer: WebGLRenderer, camera: Camera): void {
    const anything = (this.showBuildings && this.buildings.length > 0) || (this.showTrees && this.trees.length > 0);
    if (!anything) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, camera);
    renderer.autoClear = autoClear;
  }

  public dispose(): void {
    this.clear();
    for (const material of this.materials()) material.dispose();
  }

  private materials(): LineMaterial[] {
    return [this.buildingMaterial, this.treeMaterial, this.hiddenBuildingMaterial, this.hiddenTreeMaterial];
  }

  private applyVisibility(): void {
    for (const lines of this.buildings) lines.visible = this.showBuildings;
    for (const lines of this.trees) lines.visible = this.showTrees;
  }

  private clear(): void {
    const all = [...this.buildings, ...this.trees];
    this.scene.remove(...all);
    // The visible and hidden passes share one geometry.
    for (const geometry of new Set(all.map((lines) => lines.geometry))) geometry.dispose();
    this.buildings = [];
    this.trees = [];
  }
}

function outlineMaterial(color: number, opacity: number, depthFunc: DepthModes): LineMaterial {
  const material = new LineMaterial({
    color,
    linewidth: 1.6,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
  });
  material.depthFunc = depthFunc;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDepthPull = { value: 1 - depthPull };
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "uniform float uDepthPull;\nvoid main() {")
      .replace(
        "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
        "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );\nstart.xyz *= uDepthPull;\nend.xyz *= uDepthPull;",
      );
  };
  return material;
}

/** The same segments drawn twice: where the scan hides them, faintly, and where it does not, fully. */
function linesOf(positions: number[], visible: LineMaterial, hidden: LineMaterial): LineSegments2[] {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  return [
    { material: hidden, order: 10 },
    { material: visible, order: 11 },
  ].map(({ material, order }) => {
    const lines = new LineSegments2(geometry, material);
    lines.renderOrder = order;
    lines.frustumCulled = false;
    return lines;
  });
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
