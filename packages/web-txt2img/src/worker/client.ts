import type { BackendId, GenerateResult, LoadOptions, ModelId } from '../types.js';
import type { WorkerBusyPolicy, WorkerRequest, WorkerResponse, WorkerGenerateParams } from './protocol.js';

export type ProgressHandler = (e: any) => void;

type Pending = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  onProgress?: ProgressHandler;
};

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class Txt2ImgWorkerClient {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private lastGenerateId: string | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev));
  }

  static createDefault(): Txt2ImgWorkerClient {
    // Use the canonical Vite-friendly pattern so the worker is bundled in builds.
    // Publish-safe: point to .js; dev uses a shim at src/worker/host.js
    const w = new Worker(new URL('./host.js', import.meta.url), { type: 'module' });
    return new Txt2ImgWorkerClient(w);
  }

  private onMessage(ev: MessageEvent<WorkerResponse>) {
    const msg = ev.data as any;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      // No-op; apps can subscribe on worker directly if needed
      return;
    }
    const id = msg.id;
    const pend = id ? this.pending.get(id) : undefined;
    if (!pend) return;
    switch (msg.type) {
      case 'accepted': {
        // ignore; promise resolves on final result
        break;
      }
      case 'progress': {
        pend.onProgress?.(msg.event);
        break;
      }
      case 'result': {
        this.pending.delete(id);
        pend.resolve(msg);
        break;
      }
    }
  }

  private send<T = any>(req: WorkerRequest, onProgress?: ProgressHandler): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onProgress });
      this.worker.postMessage(req);
    });
  }

  async detect(): Promise<{ webgpu: boolean; shaderF16: boolean; webnn: boolean; wasm: boolean }> {
    const res: any = await this.send({ id: uid(), kind: 'detect' });
    return res.data;
  }

  async listModels(): Promise<Array<{ id: ModelId; displayName: string; task: 'text-to-image'; supportedBackends: BackendId[]; notes?: string }>> {
    const res: any = await this.send({ id: uid(), kind: 'listModels' });
    return res.data;
  }

  async listBackends(): Promise<BackendId[]> {
    const res: any = await this.send({ id: uid(), kind: 'listBackends' });
    return res.data;
  }

  async load(model: ModelId, options?: LoadOptions, onProgress?: ProgressHandler): Promise<any> {
    const res: any = await this.send({ id: uid(), kind: 'load', model, options }, onProgress);
    return res.data ?? res; // return LoadResult in data, or whole msg if shaped differently
  }

  async unload(model?: ModelId): Promise<void> {
    await this.send({ id: uid(), kind: 'unload', model });
  }

  async purge(model?: ModelId): Promise<void> {
    await this.send({ id: uid(), kind: 'purge', model });
  }

  async purgeAll(): Promise<void> {
    await this.send({ id: uid(), kind: 'purgeAll' });
  }

  generate(
    params: WorkerGenerateParams,
    onProgress?: ProgressHandler,
    opts?: { busyPolicy?: WorkerBusyPolicy; replaceQueued?: boolean; debounceMs?: number },
  ): { id: string; promise: Promise<GenerateResult | any>; abort: () => Promise<void> } {
    const id = uid();
    this.lastGenerateId = id;
    const promise = this.send({ id, kind: 'generate', params, ...(opts ?? {}) } as WorkerRequest, onProgress);
    const abort = async () => {
      await this.send({ id: uid(), kind: 'abort' });
    };
    return { id, promise, abort };
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}

export function createTxt2ImgWorker(): Worker {
  // Publish-safe: point to .js; dev uses a shim at src/worker/host.js
  return new Worker(new URL('./host.js', import.meta.url), { type: 'module' });
}
