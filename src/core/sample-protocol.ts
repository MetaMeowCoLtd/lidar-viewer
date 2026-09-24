import type { ProceduralCloudData } from "./procedural-cloud-generator.js";

export interface SampleRequest {
  readonly pointCount: number;
  readonly seed: number;
}

export type SampleMessage =
  | { readonly kind: "progress"; readonly fraction: number }
  | { readonly kind: "done"; readonly data: ProceduralCloudData }
  | { readonly kind: "failed"; readonly message: string };
