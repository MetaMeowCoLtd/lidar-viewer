import {
  DepthTexture,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type PerspectiveCamera,
  type WebGLRenderer,
} from "three";

/**
 * Screen-space eye-dome lighting. Points carry no normals, so shape is
 * recovered by darkening pixels whose neighbours sit measurably closer to the
 * camera, which turns depth discontinuities into visible edges.
 */
export class EyeDomeLighting {
  private readonly target: WebGLRenderTarget;
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;

  public constructor(private readonly renderer: WebGLRenderer) {
    const size = renderer.getDrawingBufferSize(new Vector2());
    this.target = new WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y));
    this.target.texture.minFilter = NearestFilter;
    this.target.texture.magFilter = NearestFilter;
    this.target.depthTexture = new DepthTexture(Math.max(1, size.x), Math.max(1, size.y));
    this.target.depthTexture.type = UnsignedIntType;

    this.material = new ShaderMaterial({
      uniforms: {
        uColor: { value: this.target.texture },
        uDepth: { value: this.target.depthTexture },
        uTexel: { value: new Vector2(1 / Math.max(1, size.x), 1 / Math.max(1, size.y)) },
        uRadius: { value: 1.4 },
        uStrength: { value: 40 },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uColor;
        uniform sampler2D uDepth;
        uniform vec2 uTexel;
        uniform float uRadius;
        uniform float uStrength;
        uniform float uNear;
        uniform float uFar;
        varying vec2 vUv;

        float linearDepth(vec2 uv) {
          float d = texture2D(uDepth, uv).x;
          if (d >= 1.0) return -1.0;
          float ndc = d * 2.0 - 1.0;
          return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
        }

        void main() {
          vec4 base = texture2D(uColor, vUv);
          float zc = linearDepth(vUv);
          if (zc < 0.0) {
            gl_FragColor = base;
            return;
          }
          vec2 offsets[8];
          offsets[0] = vec2( 1.0,  0.0); offsets[1] = vec2(-1.0,  0.0);
          offsets[2] = vec2( 0.0,  1.0); offsets[3] = vec2( 0.0, -1.0);
          offsets[4] = vec2( 0.7,  0.7); offsets[5] = vec2(-0.7,  0.7);
          offsets[6] = vec2( 0.7, -0.7); offsets[7] = vec2(-0.7, -0.7);

          float logZc = log2(zc);
          float response = 0.0;
          float valid = 0.0;
          for (int i = 0; i < 8; i++) {
            float zn = linearDepth(vUv + offsets[i] * uTexel * uRadius);
            if (zn < 0.0) continue;
            response += max(0.0, logZc - log2(zn));
            valid += 1.0;
          }
          float shade = valid < 1.0 ? 1.0 : exp(-uStrength * response / valid);
          shade = clamp(shade, 0.25, 1.0);
          gl_FragColor = vec4(base.rgb * shade, base.a);
        }
      `,
    });
    this.quadScene.add(new Mesh(new PlaneGeometry(2, 2), this.material));
  }

  public setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.target.setSize(w, h);
    (this.material.uniforms.uTexel!.value as Vector2).set(1 / w, 1 / h);
  }

  public setStrength(strength: number): void {
    this.material.uniforms.uStrength!.value = strength;
  }

  public setRadius(radius: number): void {
    this.material.uniforms.uRadius!.value = radius;
  }

  public render(scene: Scene, camera: Camera): void {
    const perspective = camera as PerspectiveCamera;
    this.material.uniforms.uNear!.value = perspective.near ?? 0.1;
    this.material.uniforms.uFar!.value = perspective.far ?? 1000;
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  public dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.material.dispose();
  }
}
