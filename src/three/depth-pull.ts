import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/**
 * Draws a line material's lines a fraction of their distance nearer the
 * camera than they really are.
 *
 * Lines laid on a scan - a roof outline at the roof's height, a contour on the
 * ground - sit exactly where points are, and depth testing against those
 * points would hide half of every line. Scaling a position toward the camera
 * leaves it at the same place on screen and only changes its depth, and a
 * fraction of the distance keeps the nudge in proportion to how large points
 * are drawn at that distance, so it is enough near and far alike without
 * letting a line show through a building in front of it.
 */
export function pullTowardCamera(material: LineMaterial, fraction: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDepthPull = { value: 1 - fraction };
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "uniform float uDepthPull;\nvoid main() {")
      .replace(
        "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
        "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );\nstart.xyz *= uDepthPull;\nend.xyz *= uDepthPull;",
      );
  };
}
