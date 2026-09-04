import {
  Color,
  ShaderMaterial,
  type IUniform,
} from "three";
import type { PointCloudColorMode, PointCloudPointShape } from "../core/point-cloud.js";

const colorModeToNumber: Record<PointCloudColorMode, number> = { height: 0, rgb: 1, relief: 2 };
const pointShapeToNumber: Record<PointCloudPointShape, number> = { circle: 0, square: 1 };
const sizeScaleFraction = 0.78;
const minDepthFraction = 0.01;

export interface PointCloudShaderOptions {
  readonly pointSize?: number;
  readonly worldScale: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly minIntensity?: number;
  readonly maxIntensity?: number;
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
      uMinIntensity: { value: options.minIntensity ?? 0 },
      uMaxIntensity: { value: Math.max(options.maxIntensity ?? 1, (options.minIntensity ?? 0) + 0.0001) },
      uHasRgb: { value: 0 },
      uPointShape: { value: pointShapeToNumber.circle },
      uLowHeightColor: { value: new Color("#123f71") },
      uHighHeightColor: { value: new Color("#ffe09a") },
    };
    super({
      uniforms,
      transparent: false,
      depthWrite: true,
      vertexShader: `
        attribute vec3 color;
        attribute float intensity;
        varying vec3 vColor;
        varying float vHeight;
        varying float vIntensity;
        uniform float uPointSize;
        uniform float uSizeScale;
        uniform float uMinDepth;
        void main() {
          vColor = color;
          vHeight = position.y;
          vIntensity = intensity;
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
        uniform float uMinIntensity;
        uniform float uMaxIntensity;
        uniform float uHasRgb;
        uniform vec3 uLowHeightColor;
        uniform vec3 uHighHeightColor;
        varying vec3 vColor;
        varying float vHeight;
        varying float vIntensity;
        void main() {
          if (uPointShape < 0.5 && length(gl_PointCoord - vec2(0.5)) > 0.5) discard;
          vec3 heightColor = mix(uLowHeightColor, uHighHeightColor, clamp((vHeight - uMinHeight) / (uMaxHeight - uMinHeight), 0.0, 1.0));
          vec3 reliefColor = uHasRgb > 0.5 ? vColor : heightColor;
          vec3 finalColor = uColorMode < 0.5 ? heightColor : (uColorMode < 1.5 ? vColor : reliefColor);
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
}
