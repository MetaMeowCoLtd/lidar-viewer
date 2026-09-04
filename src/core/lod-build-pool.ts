import type { LodBuildRequest, LodBuildResponse } from "./lod-build-protocol.js";

interface PendingTask {
  readonly request: LodBuildRequest;
  readonly transfer: ArrayBuffer[];
  readonly resolve: (response: LodBuildResponse) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Runs per-tile LOD builds across a pool of workers. Point buffers are
 * transferred rather than copied in both directions, so a tile costs a pointer
 * hand-off instead of a duplicate of its attributes.
 */
export class LodBuildPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: PendingTask[] = [];
  private disposed = false;

  public constructor(size: number) {
    for (let index = 0; index < Math.max(1, size); index += 1) {
      const worker = new Worker(new URL("./lod-build-worker.ts", import.meta.url), { type: "module" });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  public run(request: LodBuildRequest): Promise<LodBuildResponse> {
    if (this.disposed) return Promise.reject(new Error("The LOD build pool has been disposed"));
    const transfer: ArrayBuffer[] = [request.positions.buffer as ArrayBuffer];
    if (request.colors !== undefined) transfer.push(request.colors.buffer as ArrayBuffer);
    if (request.intensity !== undefined) transfer.push(request.intensity.buffer as ArrayBuffer);
    return new Promise<LodBuildResponse>((resolve, reject) => {
      this.queue.push({ request, transfer, resolve, reject });
      this.pump();
    });
  }

  public dispose(): void {
    this.disposed = true;
    for (const task of this.queue) task.reject(new Error("The LOD build pool has been disposed"));
    this.queue.length = 0;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const task = this.queue.shift()!;
      const settle = (): void => {
        worker.onmessage = null;
        worker.onerror = null;
        if (!this.disposed) this.idle.push(worker);
        this.pump();
      };
      worker.onmessage = (event: MessageEvent<LodBuildResponse>) => {
        settle();
        task.resolve(event.data);
      };
      worker.onerror = (event) => {
        settle();
        task.reject(new Error(event.message || "The LOD build worker failed"));
      };
      worker.postMessage(task.request, task.transfer);
    }
  }
}
