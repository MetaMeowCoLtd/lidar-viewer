import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  type Camera,
  type PerspectiveCamera,
  type WebGLRenderer,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

type Vec3 = readonly [number, number, number];

/**
 * How a marker reads: an inspected point or a ruler's ends are rings; a
 * polygon's corners are square handles, its edges' midpoints smaller ones; the
 * snap cursor shows where a click would land.
 */
export type MarkerTone = "inspect" | "from" | "to" | "vertex" | "vertexSelected" | "midpoint" | "snap" | "close";

export interface MarkerAnnotation {
  readonly position: Vec3;
  readonly tone: MarkerTone;
  /** Names the handle this marker draws, so it lights up while the cursor is over it or it is dragged. */
  readonly id?: string | undefined;
}

export type LineStyle = "polygon" | "polygonSelected" | "guide" | "prism" | "rubber" | "rubberClose" | "axisX" | "axisY" | "axisZ";
export type FillStyle = "base" | "baseSelected" | "prism" | "preview";

/**
 * A gizmo arrow standing on a point, straight up or down, a fixed size on
 * screen however far away it is - Unreal's and Blender's translate arrows,
 * limited to the one axis a height lives on.
 */
export interface ArrowAnnotation {
  readonly id: string;
  readonly anchor: Vec3;
  readonly direction: 1 | -1;
  readonly tone: "extrude" | "base";
}

export interface Annotations {
  readonly markers: readonly MarkerAnnotation[];
  /** Measured lines; the two legs showing each one's horizontal and vertical parts are drawn with it. */
  readonly measurements?: ReadonlyArray<{ readonly from: Vec3; readonly to: Vec3 }>;
  /** Outlines of measured surfaces, each as line segments: x, y, z of both ends. */
  readonly surfaces?: ReadonlyArray<Float32Array>;
  /** Line segments by style, x, y, z of both ends. */
  readonly lines?: ReadonlyArray<{ readonly style: LineStyle; readonly positions: Float32Array | readonly number[] }>;
  /** Translucent triangles by style, x, y, z of each corner. */
  readonly fills?: ReadonlyArray<{ readonly style: FillStyle; readonly positions: Float32Array }>;
  readonly arrows?: readonly ArrowAnnotation[];
}

const toneColors: Record<MarkerTone, readonly [number, number, number]> = {
  inspect: [0.46, 0.86, 1],
  from: [0.46, 0.86, 1],
  to: [1, 0.71, 0.38],
  vertex: [0.71, 0.61, 1],
  vertexSelected: [0.86, 0.8, 1],
  midpoint: [0.71, 0.61, 1],
  snap: [1, 1, 1],
  close: [0.5, 1, 0.62],
};

/** Diameter in CSS pixels, and the shape drawn: 0 a ring, 1 a square handle, 2 a snap target. */
const toneShapes: Record<MarkerTone, readonly [size: number, shape: number]> = {
  inspect: [18, 0],
  from: [18, 0],
  to: [18, 0],
  vertex: [13, 1],
  vertexSelected: [14, 1],
  midpoint: [9, 1],
  snap: [16, 2],
  close: [22, 0],
};

/** The colour of whatever the cursor is over or is dragging, as Unreal lights the axis in hand. */
const highlightColor: readonly [number, number, number] = [1, 0.84, 0.1];

/** How long a gizmo arrow is on screen, in CSS pixels. */
export const arrowPixels = 64;

/**
 * How long, in world units, an arrow standing at `anchor` must be to cover
 * {@link arrowPixels} on screen. The viewer uses the same length to tell
 * whether a press landed on it.
 */
export function arrowLength(camera: PerspectiveCamera, anchor: Vec3, cssHeight: number): number {
  const forward = camera.getWorldDirection(new Vector3());
  const depth = Math.max(1e-3, new Vector3(...anchor).sub(camera.position).dot(forward));
  const worldPerPixel = (2 * depth * Math.tan(((camera.fov * Math.PI) / 180) / 2)) / Math.max(1, cssHeight) / camera.zoom;
  return arrowPixels * worldPerPixel;
}

/**
 * Picked points, measurements and the handles that edit them, drawn over the
 * scan in a pass of their own.
 *
 * Markers are a fixed size on screen, so what they mark stays visible in
 * their middle and they read the same at any zoom. A ruler is drawn with its
 * horizontal and vertical legs: a right triangle standing on the lower point
 * shows at a glance how much of a distance is height. Everything ignores
 * depth - an annotation the user just made should never be hidden by the
 * points around it.
 *
 * There are two layers. The annotations are what has been measured and change
 * when a measurement does. The preview is what the cursor is about to do - the
 * point it would snap to, the edge it would draw - and is replaced every frame
 * the cursor moves, without touching the first.
 */
export class MeasurementOverlay {
  private readonly scene = new Scene();
  private readonly markerMaterial = new ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 } },
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      attribute vec3 color;
      attribute vec2 look;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vShape;
      void main() {
        vColor = color;
        vShape = look.y;
        gl_PointSize = look.x * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vShape;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        if (vShape < 0.5) {
          float r = length(p);
          if (r > 1.0 || (r > 0.3 && r < 0.52)) discard;
          // A dark rim keeps the ring legible over bright points.
          gl_FragColor = vec4(r > 0.8 ? vColor * 0.25 : vColor, 1.0);
        } else if (vShape < 1.5) {
          float m = max(abs(p.x), abs(p.y));
          if (m > 0.86) discard;
          gl_FragColor = vec4(m > 0.56 ? vColor * 0.2 : vColor, 1.0);
        } else {
          float r = length(p);
          if (r > 1.0 || (r > 0.2 && r < 0.74)) discard;
          gl_FragColor = vec4(r > 0.9 ? vColor * 0.2 : vColor, 1.0);
        }
      }
    `,
  });
  private readonly lineMaterial = lineMaterial(0xffffff, 2, 0.95);
  private readonly legMaterial = lineMaterial(0x9fdcf5, 1.2, 0.55);
  private readonly surfaceMaterial = lineMaterial(0xffd54a, 2.5, 0.95);
  private readonly lineStyles: Record<LineStyle, LineMaterial> = {
    polygon: lineMaterial(0xb69cff, 2, 0.95),
    polygonSelected: lineMaterial(0xdcd2ff, 3, 1),
    guide: lineMaterial(0xb69cff, 1, 0.5),
    prism: lineMaterial(0x6ea4ff, 1.5, 0.85),
    rubber: lineMaterial(0xffffff, 1.5, 0.9),
    rubberClose: lineMaterial(0xffffff, 1, 0.4),
    axisX: lineMaterial(0xff5c5c, 1.5, 0.85),
    axisY: lineMaterial(0x86df5e, 1.5, 0.85),
    axisZ: lineMaterial(0x4d8dff, 1.5, 0.85),
  };
  private readonly fillStyles: Record<FillStyle, MeshBasicMaterial> = {
    base: fillMaterial(0xb69cff, 0.14),
    baseSelected: fillMaterial(0xb69cff, 0.24),
    prism: fillMaterial(0x5b9bff, 0.12),
    preview: fillMaterial(0xffffff, 0.1),
  };
  private readonly arrowMaterials = {
    extrude: new MeshBasicMaterial({ color: 0x3d8bff, depthTest: false, depthWrite: false }),
    base: new MeshBasicMaterial({ color: 0x9fb0cc, depthTest: false, depthWrite: false }),
    highlight: new MeshBasicMaterial({ color: 0xffd61a, depthTest: false, depthWrite: false }),
  };
  // One arrow of unit length along +y, scaled and turned for each.
  private readonly shaftGeometry = new CylinderGeometry(0.03, 0.03, 0.74, 8).translate(0, 0.37, 0);
  private readonly headGeometry = new ConeGeometry(0.11, 0.28, 16).translate(0, 0.86, 0);
  private readonly layers = { annotations: new Group(), preview: new Group() };
  private readonly arrows: Array<{ group: Group; arrow: ArrowAnnotation }> = [];
  private highlighted: string | undefined;
  private cssHeight = 1;

  public constructor() {
    this.scene.add(this.layers.annotations, this.layers.preview);
  }

  public setAnnotations(annotations: Annotations): void {
    this.build(this.layers.annotations, annotations);
  }

  /** What the cursor is about to do; undefined clears it. */
  public setPreview(preview: Annotations | undefined): void {
    this.build(this.layers.preview, preview ?? { markers: [] });
  }

  /** Lights up the handle with this id: the one under the cursor, or the one being dragged. */
  public setHighlight(id: string | undefined): void {
    if (this.highlighted === id) return;
    this.highlighted = id;
    this.applyHighlight();
  }

  private build(layer: Group, annotations: Annotations): void {
    this.clear(layer);
    if (annotations.markers.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(Float32Array.from(annotations.markers.flatMap((marker) => [...marker.position])), 3));
      geometry.setAttribute("color", new BufferAttribute(Float32Array.from(annotations.markers.flatMap((marker) => [...toneColors[marker.tone]])), 3));
      geometry.setAttribute("look", new BufferAttribute(Float32Array.from(annotations.markers.flatMap((marker) => [...toneShapes[marker.tone]])), 2));
      const markers = new Points(geometry, this.markerMaterial);
      markers.frustumCulled = false;
      markers.renderOrder = 30;
      markers.userData = { markers: annotations.markers };
      layer.add(markers);
    }
    const measurements = annotations.measurements ?? [];
    if (measurements.length > 0) {
      const lines: number[] = [];
      const legs: number[] = [];
      for (const measurement of measurements) {
        const [low, high] = measurement.from[1] <= measurement.to[1] ? [measurement.from, measurement.to] : [measurement.to, measurement.from];
        // The corner sits under the higher point at the lower point's elevation.
        const corner = [high[0], low[1], high[2]];
        lines.push(...measurement.from, ...measurement.to);
        legs.push(...low, ...corner, ...corner, ...high);
      }
      layer.add(segments(legs, this.legMaterial, 20), segments(lines, this.lineMaterial, 21));
    }
    const surfaces = annotations.surfaces ?? [];
    const outlineLength = surfaces.reduce((sum, outline) => sum + outline.length, 0);
    if (outlineLength > 0) {
      const positions = new Float32Array(outlineLength);
      let offset = 0;
      for (const outline of surfaces) {
        positions.set(outline, offset);
        offset += outline.length;
      }
      layer.add(segments(positions, this.surfaceMaterial, 19));
    }
    for (const fill of annotations.fills ?? []) {
      if (fill.positions.length < 9) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(fill.positions, 3));
      const mesh = new Mesh(geometry, this.fillStyles[fill.style]);
      mesh.frustumCulled = false;
      mesh.renderOrder = fill.style === "prism" ? 16 : 15;
      layer.add(mesh);
    }
    for (const line of annotations.lines ?? []) {
      if (line.positions.length < 6) continue;
      const style = line.style;
      layer.add(segments(line.positions, this.lineStyles[style], style === "guide" || style === "rubberClose" ? 18 : 22));
    }
    for (const arrow of annotations.arrows ?? []) {
      const group = new Group();
      const material = this.arrowMaterials[arrow.tone];
      for (const geometry of [this.shaftGeometry, this.headGeometry]) {
        const mesh = new Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = 32;
        group.add(mesh);
      }
      group.position.set(...arrow.anchor);
      if (arrow.direction < 0) group.rotation.x = Math.PI;
      group.userData = { arrow };
      layer.add(group);
      this.arrows.push({ group, arrow });
    }
    this.applyHighlight();
  }

  private applyHighlight(): void {
    for (const layer of [this.layers.annotations, this.layers.preview]) {
      for (const child of layer.children) {
        if (!(child instanceof Points)) continue;
        const markers = (child.userData as { markers: readonly MarkerAnnotation[] }).markers;
        const colors = child.geometry.getAttribute("color") as BufferAttribute;
        markers.forEach((marker, index) => {
          const color = marker.id !== undefined && marker.id === this.highlighted ? highlightColor : toneColors[marker.tone];
          colors.setXYZ(index, color[0], color[1], color[2]);
        });
        colors.needsUpdate = true;
      }
    }
    for (const { group, arrow } of this.arrows) {
      const material = arrow.id === this.highlighted ? this.arrowMaterials.highlight : this.arrowMaterials[arrow.tone];
      for (const mesh of group.children) (mesh as Mesh).material = material;
    }
  }

  /** Line widths and marker sizes are in pixels, so they need the drawing surface's size and density. */
  public setResolution(width: number, height: number, pixelRatio: number): void {
    for (const material of [this.lineMaterial, this.legMaterial, this.surfaceMaterial, ...Object.values(this.lineStyles)]) material.resolution.set(width, height);
    this.markerMaterial.uniforms.uPixelRatio!.value = pixelRatio;
    this.cssHeight = height / pixelRatio;
  }

  public render(renderer: WebGLRenderer, camera: Camera): void {
    if (this.layers.annotations.children.length === 0 && this.layers.preview.children.length === 0) return;
    // Arrows keep their size on screen, so they are measured against the camera every frame.
    for (const { group, arrow } of this.arrows) {
      group.scale.setScalar(arrowLength(camera as PerspectiveCamera, arrow.anchor, this.cssHeight));
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, camera);
    renderer.autoClear = autoClear;
  }

  public dispose(): void {
    this.clear(this.layers.annotations);
    this.clear(this.layers.preview);
    this.markerMaterial.dispose();
    for (const material of [this.lineMaterial, this.legMaterial, this.surfaceMaterial, ...Object.values(this.lineStyles)]) material.dispose();
    for (const material of [...Object.values(this.fillStyles), ...Object.values(this.arrowMaterials)]) material.dispose();
    this.shaftGeometry.dispose();
    this.headGeometry.dispose();
  }

  private clear(layer: Group): void {
    for (const child of [...layer.children]) {
      layer.remove(child);
      if (child instanceof Points || child instanceof Mesh || child instanceof LineSegments2) child.geometry.dispose();
      // An arrow's meshes share the overlay's geometry, which outlives them.
    }
    for (let index = this.arrows.length - 1; index >= 0; index -= 1) {
      if (this.arrows[index]!.group.parent === null) this.arrows.splice(index, 1);
    }
  }
}

function lineMaterial(color: number, linewidth: number, opacity: number): LineMaterial {
  return new LineMaterial({ color, linewidth, transparent: true, opacity, depthTest: false, depthWrite: false });
}

function fillMaterial(color: number, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: DoubleSide });
}

function segments(positions: Float32Array | readonly number[], material: LineMaterial, renderOrder: number): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions instanceof Float32Array ? positions : Array.from(positions));
  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = renderOrder;
  return lines;
}
