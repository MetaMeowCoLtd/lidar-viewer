import { BufferAttribute, BufferGeometry, Points, Scene, ShaderMaterial, type Camera, type WebGLRenderer } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

export type MarkerTone = "inspect" | "from" | "to";

export interface MarkerAnnotation {
  readonly position: readonly [number, number, number];
  readonly tone: MarkerTone;
}

export interface Annotations {
  readonly markers: readonly MarkerAnnotation[];
  /** A measured line; the two legs showing its horizontal and vertical parts are drawn with it. */
  readonly measurement?: { readonly from: readonly [number, number, number]; readonly to: readonly [number, number, number] };
}

const toneColors: Record<MarkerTone, readonly [number, number, number]> = {
  inspect: [0.46, 0.86, 1],
  from: [0.46, 0.86, 1],
  to: [1, 0.71, 0.38],
};

/** Marker diameter in CSS pixels. */
const markerSize = 18;

/**
 * Picked points and measurements, drawn over the scan in a pass of their own.
 *
 * Markers are hollow rings of a fixed screen size, so the point they mark
 * stays visible in the middle and they read the same at any zoom. The measured
 * line is drawn with its horizontal and vertical legs: a right triangle
 * standing on the lower point shows at a glance how much of a distance is
 * height. Everything ignores depth - an annotation the user just made should
 * never be hidden by the points around it.
 */
export class MeasurementOverlay {
  private readonly scene = new Scene();
  private readonly markerMaterial = new ShaderMaterial({
    uniforms: { uSize: { value: markerSize } },
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      attribute vec3 color;
      uniform float uSize;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_PointSize = uSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float r = length(gl_PointCoord * 2.0 - 1.0);
        if (r > 1.0 || (r > 0.3 && r < 0.52)) discard;
        // A dark rim keeps the ring legible over bright points.
        gl_FragColor = vec4(r > 0.8 ? vColor * 0.25 : vColor, 1.0);
      }
    `,
  });
  private readonly lineMaterial = lineMaterial(0xffffff, 2, 0.95);
  private readonly legMaterial = lineMaterial(0x9fdcf5, 1.2, 0.55);
  private markers: Points | undefined;
  private line: LineSegments2 | undefined;
  private legs: LineSegments2 | undefined;

  public setAnnotations(annotations: Annotations): void {
    this.clear();
    if (annotations.markers.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(Float32Array.from(annotations.markers.flatMap((marker) => [...marker.position])), 3));
      geometry.setAttribute("color", new BufferAttribute(Float32Array.from(annotations.markers.flatMap((marker) => [...toneColors[marker.tone]])), 3));
      this.markers = new Points(geometry, this.markerMaterial);
      this.markers.frustumCulled = false;
      this.markers.renderOrder = 30;
      this.scene.add(this.markers);
    }
    const measurement = annotations.measurement;
    if (measurement !== undefined) {
      const [low, high] = measurement.from[1] <= measurement.to[1] ? [measurement.from, measurement.to] : [measurement.to, measurement.from];
      // The corner sits under the higher point at the lower point's elevation.
      const corner = [high[0], low[1], high[2]];
      this.line = segments([...measurement.from, ...measurement.to], this.lineMaterial, 21);
      this.legs = segments([...low, ...corner, ...corner, ...high], this.legMaterial, 20);
      this.scene.add(this.legs, this.line);
    }
  }

  /** Line widths and marker sizes are in pixels, so they need the drawing surface's size and density. */
  public setResolution(width: number, height: number, pixelRatio: number): void {
    this.lineMaterial.resolution.set(width, height);
    this.legMaterial.resolution.set(width, height);
    this.markerMaterial.uniforms.uSize!.value = markerSize * pixelRatio;
  }

  public render(renderer: WebGLRenderer, camera: Camera): void {
    if (this.scene.children.length === 0) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, camera);
    renderer.autoClear = autoClear;
  }

  public dispose(): void {
    this.clear();
    this.markerMaterial.dispose();
    this.lineMaterial.dispose();
    this.legMaterial.dispose();
  }

  private clear(): void {
    for (const object of [this.markers, this.line, this.legs]) {
      if (object === undefined) continue;
      this.scene.remove(object);
      object.geometry.dispose();
    }
    this.markers = undefined;
    this.line = undefined;
    this.legs = undefined;
  }
}

function lineMaterial(color: number, linewidth: number, opacity: number): LineMaterial {
  return new LineMaterial({ color, linewidth, transparent: true, opacity, depthTest: false, depthWrite: false });
}

function segments(positions: number[], material: LineMaterial, renderOrder: number): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = renderOrder;
  return lines;
}
