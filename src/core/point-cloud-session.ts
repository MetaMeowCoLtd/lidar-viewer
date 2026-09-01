import type { PointCloud } from "./point-cloud.js";
import { PointCloudLodPyramid, type LodTierSpec } from "./lod-pyramid.js";

export type PointCloudSessionState =
  | { readonly status: "idle" }
  | { readonly status: "processing"; readonly requestId: number; readonly sourceName: string }
  | { readonly status: "ready"; readonly requestId: number; readonly pyramid: PointCloudLodPyramid }
  | { readonly status: "error"; readonly requestId: number; readonly error: Error };

export type PointCloudSessionListener = (state: PointCloudSessionState) => void;

/**
 * Owns asynchronous loading transitions. A new request invalidates an earlier
 * one, preventing a slow worker/import from replacing a newer cloud.
 */
export class PointCloudSession {
  private requestId = 0;
  private state: PointCloudSessionState = { status: "idle" };
  private readonly listeners = new Set<PointCloudSessionListener>();

  public get snapshot(): PointCloudSessionState {
    return this.state;
  }

  public subscribe(listener: PointCloudSessionListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  public async load(source: PointCloud | Promise<PointCloud>, specs: readonly LodTierSpec[]): Promise<void> {
    const requestId = ++this.requestId;
    this.transition({ status: "processing", requestId, sourceName: "Loading point cloud" });
    try {
      const cloud = await source;
      if (requestId !== this.requestId) return;
      this.transition({ status: "processing", requestId, sourceName: cloud.name });
      const pyramid = PointCloudLodPyramid.build(cloud, specs);
      if (requestId !== this.requestId) return;
      this.transition({ status: "ready", requestId, pyramid });
    } catch (cause) {
      if (requestId !== this.requestId) return;
      this.transition({
        status: "error",
        requestId,
        error: cause instanceof Error ? cause : new Error("Unable to load point cloud"),
      });
    }
  }

  public cancelPendingLoad(): void {
    this.requestId += 1;
    this.transition({ status: "idle" });
  }

  private transition(state: PointCloudSessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
