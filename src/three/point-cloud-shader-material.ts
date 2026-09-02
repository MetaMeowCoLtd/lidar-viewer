import {
  Color,
  ShaderMaterial,
  type IUniform,
} from "three";
import type { PointCloudColorMode } from "../core/point-cloud.js";

const colorModeToNumber: Record<PointCloudColorMode, number> = { height: 0, rgb: 1, intensity: 2 };

export interface PointCloudShaderOptions {
  readonly pointSize?: number;
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
      uColorMode: { value: colorModeToNumber.height },
      uMinHeight: { value: options.minHeight },
      uMaxHeight: { value: Math.max(options.maxHeight, options.minHeight + 0.0001) },
      uMinIntensity: { value: options.minIntensity ?? 0 },
      uMaxIntensity: { value: Math.max(options.maxIntensity ?? 1, (options.minIntensity ?? 0) + 0.0001) },
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
        void main() {
          vColor = color;
          vHeight = position.y;
          vIntensity = intensity;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(uPointSize * (90.0 / max(1.0, -mvPosition.z)), 0.8, 10.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform float uColorMode;
        uniform float uMinHeight;
        uniform float uMaxHeight;
        uniform float uMinIntensity;
        uniform float uMaxIntensity;
        uniform vec3 uLowHeightColor;
        uniform vec3 uHighHeightColor;
        varying vec3 vColor;
        varying float vHeight;
        varying float vIntensity;
        void main() {
          if (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;
          vec3 heightColor = mix(uLowHeightColor, uHighHeightColor, clamp((vHeight - uMinHeight) / (uMaxHeight - uMinHeight), 0.0, 1.0));
          float normalizedIntensity = clamp((vIntensity - uMinIntensity) / (uMaxIntensity - uMinIntensity), 0.0, 1.0);
          vec3 intensityColor = vec3(normalizedIntensity);
          vec3 finalColor = uColorMode < 0.5 ? heightColor : (uColorMode < 1.5 ? vColor : intensityColor);
          gl_FragColor = vec4(finalColor, 1.0);
        }
      `,
    });
  }

  public setPointSize(pointSize: number): void {
    if (!Number.isFinite(pointSize) || pointSize <= 0) throw new Error("pointSize must be positive");
    this.uniforms.uPointSize!.value = pointSize;
  }

  public setColorMode(mode: PointCloudColorMode): void {
    this.uniforms.uColorMode!.value = colorModeToNumber[mode];
  }
}
