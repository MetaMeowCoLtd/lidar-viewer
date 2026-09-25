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
import { flightLineHueStep, flightLineLightness, flightLineSaturation } from "../core/flight-line-colour.js";

const colorModeToNumber: Record<PointCloudColorMode, number> = {
  height: 0,
  rgb: 1,
  relief: 2,
  classification: 3,
  heightAboveGround: 4,
  objects: 5,
  intensity: 6,
  flightLine: 7,
};
const pointShapeToNumber: Record<PointCloudPointShape, number> = { circle: 0, square: 1 };

/** How points labelled as noise (classes 7 and 18) are drawn. */
export type NoiseDisplay = "shown" | "hidden" | "highlighted";
const noiseDisplayToNumber: Record<NoiseDisplay, number> = { shown: 0, hidden: 1, highlighted: 2 };
const sizeScaleFraction = 0.78;
const minDepthFraction = 0.01;
/** Bounds on a drawn dot's diameter in pixels, shared by the shader and picking. */
const minDotSize = 0.8;
export const maxDotSize = 10;
/**
 * A dot drawn for a decimated point grows to cover its voxel, up to this
 * size. Circles on a square grid only close the gaps at their diagonals when
 * a little wider than the grid spacing, hence the factor.
 */
const maxCoverDotSize = 40;
const voxelCoverFactor = 1.3;

export interface PointCloudShaderOptions {
  readonly pointSize?: number;
  readonly worldScale: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Height above ground at which the colour ramp tops out. */
  readonly maxAboveGround?: number;
  /** The intensity values the grey ramp runs between. */
  readonly intensityRange?: readonly [number, number];
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
      uVoxelSize: { value: 0 },
      uNoiseMode: { value: noiseDisplayToNumber.shown },
      uIntensityLow: { value: options.intensityRange?.[0] ?? 0 },
      uIntensityHigh: { value: options.intensityRange?.[1] ?? 1 },
      uPixelsPerUnit: { value: 0 },
      uLineMask: { value: createFlightLineMask() },
      uLineFilter: { value: 0 },
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
        attribute float intensity;
        attribute float pointSourceId;
        uniform float uNoiseMode;
        uniform sampler2D uLineMask;
        uniform float uLineFilter;
        varying float vNoise;
        varying vec3 vColor;
        varying float vIntensity;
        varying float vHeight;
        varying float vClass;
        varying float vAboveGround;
        varying float vObject;
        varying float vLine;
        uniform float uPointSize;
        uniform float uSizeScale;
        uniform float uMinDepth;
        uniform float uVoxelSize;
        uniform float uPixelsPerUnit;
        void main() {
          vColor = color;
          vHeight = position.y;
          vClass = classification;
          vAboveGround = heightAboveGround;
          vObject = objectId;
          vIntensity = intensity;
          vLine = pointSourceId;
          // ASPRS 7 and 18: low and high noise. Hidden points are sent outside the clip volume.
          vNoise = (abs(classification - 7.0) < 0.5 || abs(classification - 18.0) < 0.5) ? 1.0 : 0.0;
          if (vNoise > 0.5 && uNoiseMode > 0.5 && uNoiseMode < 1.5) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            return;
          }
          // Flight lines switched off are sent out of view the same way. The
          // mask holds one texel per possible line id, 256 by 256.
          if (uLineFilter > 0.5) {
            vec2 texel = vec2((mod(pointSourceId, 256.0) + 0.5) / 256.0, (floor(pointSourceId / 256.0) + 0.5) / 256.0);
            if (texture2D(uLineMask, texel).r < 0.5) {
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
              gl_PointSize = 0.0;
              return;
            }
          }
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float chosenSize = clamp(uPointSize * (uSizeScale / max(uMinDepth, -mvPosition.z)), ${minDotSize.toFixed(1)}, ${maxDotSize.toFixed(1)});
          // A decimated point stands for its whole voxel. Drawn at the chosen
          // size alone, a coarse tier's surfaces open up between its dots and
          // whatever lies behind shows through them; covering the voxel keeps
          // walls and roofs solid at every level of detail.
          float coverSize = min(uVoxelSize * uPixelsPerUnit / max(uMinDepth, -mvPosition.z) * ${voxelCoverFactor.toFixed(2)}, ${maxCoverDotSize.toFixed(1)});
          gl_PointSize = max(chosenSize, coverSize);
          // Highlighted noise is drawn large enough to find among millions of points.
          if (vNoise > 0.5 && uNoiseMode > 1.5) gl_PointSize = max(gl_PointSize, 8.0);
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
        uniform float uIntensityLow;
        uniform float uIntensityHigh;
        uniform float uNoiseMode;
        varying float vNoise;
        varying vec3 vColor;
        varying float vIntensity;
        varying float vHeight;
        varying float vClass;
        varying float vAboveGround;
        varying float vObject;
        varying float vLine;

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

        // Intensity as a grey ramp, slightly lifted in the darks where asphalt,
        // water edges and roofing sit, the way survey software shows it.
        vec3 intensityColor(float value) {
          float t = clamp((value - uIntensityLow) / max(uIntensityHigh - uIntensityLow, 0.0001), 0.0, 1.0);
          return vec3(pow(t, 0.8) * 0.92 + 0.04);
        }

        // Each flight line in its own colour; see flight-line-colour.ts.
        vec3 flightLineColor(float id) {
          return hsl(fract(id * ${flightLineHueStep.toFixed(10)}), ${flightLineSaturation.toFixed(2)}, ${flightLineLightness.toFixed(2)});
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
            : (uColorMode < 1.5 ? vColor : (uColorMode < 2.5 ? reliefColor : (uColorMode < 3.5 ? classColor : (uColorMode < 4.5 ? aboveGroundColor(vAboveGround) : (uColorMode < 5.5 ? objectColor(vObject, vClass) : (uColorMode < 6.5 ? intensityColor(vIntensity) : flightLineColor(vLine)))))));
          if (vNoise > 0.5 && uNoiseMode > 1.5) finalColor = vec3(1.0, 0.16, 0.6);
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

  public setNoiseDisplay(display: NoiseDisplay): void {
    this.uniforms.uNoiseMode!.value = noiseDisplayToNumber[display];
  }

  /** Leaves out the points of these flight lines; an empty set draws every line. */
  public setHiddenFlightLines(hidden: ReadonlySet<number>): void {
    const texture = this.uniforms.uLineMask!.value as DataTexture;
    const mask = texture.image.data as Uint8Array;
    mask.fill(255);
    for (const id of hidden) if (id >= 0 && id < 65536) mask.fill(0, id * 4, id * 4 + 4);
    texture.needsUpdate = true;
    this.uniforms.uLineFilter!.value = hidden.size > 0 ? 1 : 0;
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

  /**
   * The voxel edge of the tier about to be drawn, so its dots cover their
   * voxels; zero for full resolution. The material is shared by every tile,
   * and tiles show different tiers, so this is set per draw.
   */
  public setVoxelSize(voxelSize: number): void {
    const uniform = this.uniforms.uVoxelSize!;
    if (uniform.value === voxelSize) return;
    uniform.value = voxelSize;
    // Uniforms are otherwise only uploaded when the program changes, which it
    // does not between tiles drawn with the same material.
    this.uniformsNeedUpdate = true;
  }

  /** Pixels one unit spans at a distance of one unit: drawing height over twice the tangent of half the field of view. */
  public setPixelsPerUnit(pixelsPerUnit: number): void {
    this.uniforms.uPixelsPerUnit!.value = pixelsPerUnit;
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
/** One texel per possible flight line id (a LAS point source ID is 16 bits), all shown. */
function createFlightLineMask(): DataTexture {
  const texture = new DataTexture(new Uint8Array(256 * 256 * 4).fill(255), 256, 256, RGBAFormat, UnsignedByteType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

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
