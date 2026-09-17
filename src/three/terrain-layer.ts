import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  Scene,
  ShaderMaterial,
  Vector3,
  type Camera,
  type WebGLRenderer,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { TerrainModel } from "../core/terrain.js";
import type { ContourSet } from "../core/contours.js";
import { pullTowardCamera } from "./depth-pull.js";

/**
 * The most vertices the surface is drawn with. A four-million-cell model is
 * thinned to a stride of cells for drawing; exports always use every cell.
 */
const maxSurfaceVertices = 1_000_000;
const contourPull = 0.015;

/**
 * The terrain model drawn in the scene: a shaded surface and its contour
 * lines.
 *
 * The surface is an ordinary mesh in the points' own scene, so points and
 * ground hide each other correctly and relief lighting shades both. It is
 * pushed a hair back in depth, because ground points lie on the surface by
 * construction and would otherwise flicker half in front of it and half
 * behind. Colour runs from low greens through tans to pale high ground, the
 * hypsometric tints of a printed map, and a light from the north-west gives
 * the hillshade that makes slopes readable.
 *
 * Contours are wide screen-space lines drawn in a later pass against the
 * scene's depth, heavier for index contours, like the building outlines.
 */
export class TerrainLayer {
  private readonly contourScene = new Scene();
  private readonly surfaceMaterial = new ShaderMaterial({
    uniforms: {
      uMinHeight: { value: 0 },
      uMaxHeight: { value: 1 },
      uLight: { value: new Vector3(-0.45, 0.8, -0.4).normalize() },
    },
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
    vertexShader: `
      varying vec3 vNormal;
      varying float vHeight;
      void main() {
        vNormal = normal;
        vHeight = position.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uMinHeight;
      uniform float uMaxHeight;
      uniform vec3 uLight;
      varying vec3 vNormal;
      varying float vHeight;
      void main() {
        float t = clamp((vHeight - uMinHeight) / max(uMaxHeight - uMinHeight, 0.001), 0.0, 1.0);
        vec3 low = vec3(0.27, 0.42, 0.29);
        vec3 middle = vec3(0.66, 0.60, 0.43);
        vec3 high = vec3(0.86, 0.84, 0.79);
        vec3 tint = t < 0.5 ? mix(low, middle, t / 0.5) : mix(middle, high, (t - 0.5) / 0.5);
        float light = max(dot(normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0), uLight), 0.0);
        gl_FragColor = vec4(tint * (0.42 + 0.58 * light), 1.0);
      }
    `,
  });
  private readonly minorMaterial = contourMaterial(0xf1e4c2, 1, 0.55);
  private readonly majorMaterial = contourMaterial(0xfff4d8, 2, 0.9);
  private surface: Mesh | undefined;
  private minor: LineSegments2 | undefined;
  private major: LineSegments2 | undefined;
  private showSurface = true;
  private showContours = true;

  public constructor(private readonly scene: Scene) {}

  public setTerrain(model: TerrainModel | undefined, contours: ContourSet | undefined): void {
    this.clear();
    if (model !== undefined) {
      const geometry = surfaceGeometry(model);
      if (geometry !== undefined) {
        this.surfaceMaterial.uniforms.uMinHeight!.value = model.minElevation;
        this.surfaceMaterial.uniforms.uMaxHeight!.value = model.maxElevation;
        this.surface = new Mesh(geometry, this.surfaceMaterial);
        this.scene.add(this.surface);
      }
    }
    if (contours !== undefined) {
      const [minorSegments, majorSegments] = [false, true].map((major) => segmentsOf(contours, major));
      if (minorSegments!.length > 0) this.minor = lines(minorSegments!, this.minorMaterial, 12);
      if (majorSegments!.length > 0) this.major = lines(majorSegments!, this.majorMaterial, 13);
      for (const layer of [this.minor, this.major]) if (layer !== undefined) this.contourScene.add(layer);
    }
    this.applyVisibility();
  }

  public setVisibility(surface: boolean, contours: boolean): void {
    this.showSurface = surface;
    this.showContours = contours;
    this.applyVisibility();
  }

  public setResolution(width: number, height: number): void {
    this.minorMaterial.resolution.set(width, height);
    this.majorMaterial.resolution.set(width, height);
  }

  /** Draws the contours over whatever the bound surface holds, depth tested against it. */
  public renderContours(renderer: WebGLRenderer, camera: Camera): void {
    if (!this.showContours || this.contourScene.children.length === 0) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.contourScene, camera);
    renderer.autoClear = autoClear;
  }

  public dispose(): void {
    this.clear();
    this.surfaceMaterial.dispose();
    this.minorMaterial.dispose();
    this.majorMaterial.dispose();
  }

  private applyVisibility(): void {
    if (this.surface !== undefined) this.surface.visible = this.showSurface;
  }

  private clear(): void {
    if (this.surface !== undefined) {
      this.scene.remove(this.surface);
      this.surface.geometry.dispose();
      this.surface = undefined;
    }
    for (const layer of [this.minor, this.major]) {
      if (layer === undefined) continue;
      this.contourScene.remove(layer);
      layer.geometry.dispose();
    }
    this.minor = undefined;
    this.major = undefined;
  }
}

/**
 * A grid mesh through the cell centres, at a stride of cells that keeps it
 * under {@link maxSurfaceVertices}. A quad is drawn only where all four of its
 * corners have data, so the surface stops at the edge of the scan.
 */
function surfaceGeometry(model: TerrainModel): BufferGeometry | undefined {
  const { cols, rows, originX, originZ, cellSize } = model.grid;
  const stride = Math.max(1, Math.ceil(Math.sqrt((cols * rows) / maxSurfaceVertices)));
  const drawCols = Math.floor((cols - 1) / stride) + 1;
  const drawRows = Math.floor((rows - 1) / stride) + 1;
  const positions = new Float32Array(drawCols * drawRows * 3);
  const valid = new Uint8Array(drawCols * drawRows);
  for (let drawRow = 0; drawRow < drawRows; drawRow += 1) {
    for (let drawColumn = 0; drawColumn < drawCols; drawColumn += 1) {
      const column = drawColumn * stride;
      const row = drawRow * stride;
      const height = model.elevations[row * cols + column]!;
      const vertex = drawRow * drawCols + drawColumn;
      valid[vertex] = height === height ? 1 : 0;
      positions[vertex * 3] = originX + (column + 0.5) * cellSize;
      // A vertex outside the scan is never indexed, but still needs a finite
      // height or the mesh's bounds come out as NaN.
      positions[vertex * 3 + 1] = height === height ? height : model.minElevation;
      positions[vertex * 3 + 2] = originZ + (row + 0.5) * cellSize;
    }
  }

  const indices: number[] = [];
  for (let drawRow = 0; drawRow + 1 < drawRows; drawRow += 1) {
    for (let drawColumn = 0; drawColumn + 1 < drawCols; drawColumn += 1) {
      const a = drawRow * drawCols + drawColumn;
      const b = a + 1;
      const c = a + drawCols;
      const d = c + 1;
      if (valid[a] === 0 || valid[b] === 0 || valid[c] === 0 || valid[d] === 0) continue;
      // Wound anticlockwise seen from above, so the faces point up.
      indices.push(a, c, b, b, c, d);
    }
  }
  if (indices.length === 0) return undefined;

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(drawCols * drawRows > 65_535 ? new BufferAttribute(Uint32Array.from(indices), 1) : new BufferAttribute(Uint16Array.from(indices), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function segmentsOf(contours: ContourSet, major: boolean): number[] {
  const segments: number[] = [];
  for (const line of contours.lines) {
    if (line.major !== major) continue;
    const count = line.points.length / 3;
    const last = line.closed ? count : count - 1;
    for (let index = 0; index < last; index += 1) {
      const next = (index + 1) % count;
      segments.push(
        line.points[index * 3]!, line.points[index * 3 + 1]!, line.points[index * 3 + 2]!,
        line.points[next * 3]!, line.points[next * 3 + 1]!, line.points[next * 3 + 2]!,
      );
    }
  }
  return segments;
}

function contourMaterial(color: number, linewidth: number, opacity: number): LineMaterial {
  const material = new LineMaterial({ color, linewidth, transparent: true, opacity, depthTest: true, depthWrite: false });
  pullTowardCamera(material, contourPull);
  return material;
}

function lines(positions: number[], material: LineMaterial, renderOrder: number): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const layer = new LineSegments2(geometry, material);
  layer.renderOrder = renderOrder;
  layer.frustumCulled = false;
  return layer;
}
