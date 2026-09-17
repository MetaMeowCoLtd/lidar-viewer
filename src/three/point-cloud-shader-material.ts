import {
  Color,
  DataTexture,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  type IUniform,
} from "three";
import type { PointCloudColorMode, PointCloudPointShape } from "../core/point-cloud.js";
import { classificationPaletteBytes } from "../core/point-cloud-classification.js";

const colorModeToNumber: Record<PointCloudColorMode, number> = {
  height: 0,
  rgb: 1,
  relief: 2,
  classification: 3,
  heightAboveGround: 4,
  objects: 5,
};
const pointShapeToNumber: Record<PointCloudPointShape, number> = { circle: 0, square: 1 };
const sizeScaleFraction = 0.78;
const minDepthFraction = 0.01;
/** Bounds on a drawn dot's diameter in pixels, shared by the shader and picking. */
const minDotSize = 0.8;
export const maxDotSize = 10;

export interface PointCloudShaderOptions {
  readonly pointSize?: number;
  readonly worldScale: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Height above ground at which the colour ramp tops out. */
  readonly maxAboveGround?: number;
}

/** Shader material that keeps point sizing and color selection on the GPU. */
export class PointCloudShaderMaterial extends ShaderMaterial {
  public constructor(options: PointCloudShaderOptions) {
    const uniforms: Record<string, IUniform> = {
      uPointSize: { value: options.pointSize ?? 2.4 },
      uSizeScale: { value: Math.max(options.worldScale, 0.0001) * sizeScaleFraction },
      uMinDepth: { value: Math.max(options.worldScale, 0.0001) * minDepthFraction },
      uColorMode: { value: colorModeToNumber.height },
      uMinHeight: { value: options.minHeight },
      uMaxHeight: { value: Math.max(options.maxHeight, options.minHeight + 0.0001) },
      uHasRgb: { value: 0 },
      uPointShape: { value: pointShapeToNumber.circle },
      uLowHeightColor: { value: new Color("#123f71") },
      uHighHeightColor: { value: new Color("#ffe09a") },
      uClassPalette: { value: createClassificationPalette() },
      uMaxAboveGround: { value: Math.max(options.maxAboveGround ?? 20, 1) },
      uBuildingCount: { value: 0 },
    };
    super({
      uniforms,
      transparent: false,
      depthWrite: true,
      vertexShader: `
        attribute vec3 color;
        attribute float classification;
        attribute float heightAboveGround;
        attribute float objectId;
        varying vec3 vColor;
        varying float vHeight;
        varying float vClass;
        varying float vAboveGround;
        varying float vObject;
        uniform float uPointSize;
        uniform float uSizeScale;
        uniform float uMinDepth;
        void main() {
          vColor = color;
          vHeight = position.y;
          vClass = classification;
          vAboveGround = heightAboveGround;
          vObject = objectId;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(uPointSize * (uSizeScale / max(uMinDepth, -mvPosition.z)), ${minDotSize.toFixed(1)}, ${maxDotSize.toFixed(1)});
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform float uColorMode;
        uniform float uPointShape;
        uniform float uMinHeight;
        uniform float uMaxHeight;
        uniform float uHasRgb;
        uniform vec3 uLowHeightColor;
        uniform vec3 uHighHeightColor;
        uniform sampler2D uClassPalette;
        uniform float uMaxAboveGround;
        uniform float uBuildingCount;
        varying vec3 vColor;
        varying float vHeight;
        varying float vClass;
        varying float vAboveGround;
        varying float vObject;

        vec3 hsl(float hue, float saturation, float lightness) {
          vec3 rgb = clamp(abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          return lightness + saturation * (rgb - 0.5) * (1.0 - abs(2.0 * lightness - 1.0));
        }

        // Every object gets its own colour, so neighbours that touch can still
        // be told apart: buildings across reds and ambers, trees across greens.
        // Ids advance by the golden ratio around the hue range, which keeps
        // consecutive ids - usually neighbours - far apart in colour. Points in
        // no object recede, with ground a shade warmer than the rest.
        vec3 objectColor(float id, float code) {
          if (id < 0.5) return (code > 1.5 && code < 2.5) ? vec3(0.27, 0.22, 0.17) : vec3(0.19, 0.21, 0.24);
          float hue = fract(id * 0.6180339887);
          float shade = fract(id * 0.7548776662);
          if (id <= uBuildingCount + 0.5) return hsl(0.0 + 0.12 * hue, 0.75, 0.5 + 0.14 * shade);
          return hsl(0.22 + 0.2 * hue, 0.6, 0.38 + 0.18 * shade);
        }

        // Ground within a quarter metre either way is drawn in the same earth
        // tone the classification palette uses for ground, so the two views
        // read as one. Below that, a deepening violet marks points under the
        // terrain, which are almost always noise. Above it, a ramp through
        // teal, green and yellow to orange carries low shrubs up to rooftops.
        //
        // The ramp runs on the square root of height. One tower in a scan sets
        // the top of the scale, and on a linear ramp a car, a hedge and a
        // four-storey block would all share the first sliver of it; the root
        // gives the lowest quarter of the range half of the colours.
        vec3 aboveGroundColor(float height) {
          if (height < -0.25) {
            return mix(vec3(0.42, 0.34, 0.70), vec3(0.20, 0.14, 0.42), clamp((-height - 0.25) / 4.0, 0.0, 1.0));
          }
          if (height < 0.25) return vec3(0.635, 0.463, 0.290);
          float t = sqrt(clamp((height - 0.25) / max(uMaxAboveGround - 0.25, 0.001), 0.0, 1.0));
          vec3 teal = vec3(0.13, 0.42, 0.50);
          vec3 green = vec3(0.30, 0.66, 0.36);
          vec3 yellow = vec3(0.92, 0.82, 0.30);
          vec3 orange = vec3(0.93, 0.42, 0.24);
          if (t < 0.33) return mix(teal, green, t / 0.33);
          if (t < 0.66) return mix(green, yellow, (t - 0.33) / 0.33);
          return mix(yellow, orange, (t - 0.66) / 0.34);
        }

        void main() {
          if (uPointShape < 0.5 && length(gl_PointCoord - vec2(0.5)) > 0.5) discard;
          vec3 heightColor = mix(uLowHeightColor, uHighHeightColor, clamp((vHeight - uMinHeight) / (uMaxHeight - uMinHeight), 0.0, 1.0));
          vec3 reliefColor = uHasRgb > 0.5 ? vColor : heightColor;
          // One indexed read into a 256-entry palette, rather than a chain of
          // comparisons that would grow with every class the standard adds.
          vec3 classColor = texture2D(uClassPalette, vec2((vClass + 0.5) / 256.0, 0.5)).rgb;
          vec3 finalColor = uColorMode < 0.5
            ? heightColor
            : (uColorMode < 1.5 ? vColor : (uColorMode < 2.5 ? reliefColor : (uColorMode < 3.5 ? classColor : (uColorMode < 4.5 ? aboveGroundColor(vAboveGround) : objectColor(vObject, vClass)))));
          gl_FragColor = vec4(finalColor, 1.0);
        }
      `,
    });
  }

  public setPointSize(pointSize: number): void {
    if (!Number.isFinite(pointSize) || pointSize <= 0) throw new Error("pointSize must be positive");
    this.uniforms.uPointSize!.value = pointSize;
  }

  public setHasRgb(hasRgb: boolean): void {
    this.uniforms.uHasRgb!.value = hasRgb ? 1 : 0;
  }

  public setPointShape(shape: PointCloudPointShape): void {
    this.uniforms.uPointShape!.value = pointShapeToNumber[shape];
  }

  public setColorMode(mode: PointCloudColorMode): void {
    this.uniforms.uColorMode!.value = colorModeToNumber[mode];
  }

  /**
   * Radius, in drawing-surface pixels, of the dot drawn for a point this far in
   * front of the camera. Mirrors the vertex shader, so picking agrees with what
   * is on screen.
   */
  public dotRadius(depth: number): number {
    const size = this.uniforms.uPointSize!.value * (this.uniforms.uSizeScale!.value / Math.max(this.uniforms.uMinDepth!.value, depth));
    return Math.min(Math.max(size, minDotSize), maxDotSize) / 2;
  }

  /** Object ids up to this count are buildings; above it, trees. */
  public setBuildingCount(count: number): void {
    this.uniforms.uBuildingCount!.value = count;
  }

  public override dispose(): void {
    (this.uniforms.uClassPalette?.value as DataTexture | undefined)?.dispose();
    super.dispose();
  }
}

/**
 * The ASPRS palette as a 256 by 1 lookup texture. Nearest filtering matters:
 * a class code is an identifier, not a quantity, so blending between
 * neighbouring entries would paint colours belonging to neither class.
 */
function createClassificationPalette(): DataTexture {
  const rgb = classificationPaletteBytes();
  const rgba = new Uint8Array(256 * 4);
  for (let code = 0; code < 256; code += 1) {
    rgba[code * 4] = rgb[code * 3]!;
    rgba[code * 4 + 1] = rgb[code * 3 + 1]!;
    rgba[code * 4 + 2] = rgb[code * 3 + 2]!;
    rgba[code * 4 + 3] = 255;
  }
  const texture = new DataTexture(rgba, 256, 1, RGBAFormat, UnsignedByteType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}
