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

const colorModeToNumber: Record<PointCloudColorMode, number> = { height: 0, rgb: 1, relief: 2, classification: 3 };
const pointShapeToNumber: Record<PointCloudPointShape, number> = { circle: 0, square: 1 };
const sizeScaleFraction = 0.78;
const minDepthFraction = 0.01;

export interface PointCloudShaderOptions {
  readonly pointSize?: number;
  readonly worldScale: number;
  readonly minHeight: number;
  readonly maxHeight: number;
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
    };
    super({
      uniforms,
      transparent: false,
      depthWrite: true,
      vertexShader: `
        attribute vec3 color;
        attribute float classification;
        varying vec3 vColor;
        varying float vHeight;
        varying float vClass;
        uniform float uPointSize;
        uniform float uSizeScale;
        uniform float uMinDepth;
        void main() {
          vColor = color;
          vHeight = position.y;
          vClass = classification;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(uPointSize * (uSizeScale / max(uMinDepth, -mvPosition.z)), 0.8, 10.0);
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
        varying vec3 vColor;
        varying float vHeight;
        varying float vClass;
        void main() {
          if (uPointShape < 0.5 && length(gl_PointCoord - vec2(0.5)) > 0.5) discard;
          vec3 heightColor = mix(uLowHeightColor, uHighHeightColor, clamp((vHeight - uMinHeight) / (uMaxHeight - uMinHeight), 0.0, 1.0));
          vec3 reliefColor = uHasRgb > 0.5 ? vColor : heightColor;
          // One indexed read into a 256-entry palette, rather than a chain of
          // comparisons that would grow with every class the standard adds.
          vec3 classColor = texture2D(uClassPalette, vec2((vClass + 0.5) / 256.0, 0.5)).rgb;
          vec3 finalColor = uColorMode < 0.5
            ? heightColor
            : (uColorMode < 1.5 ? vColor : (uColorMode < 2.5 ? reliefColor : classColor));
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
