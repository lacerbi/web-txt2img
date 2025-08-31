import type { BackendId, GenerationProgressEvent, LoadOptions, ModelId } from '../types.js';

// Worker request/response protocol for web-txt2img

export type WorkerBusyPolicy = 'reject' | 'abort_and_queue' | 'queue';

// Worker-side generate params: model is optional since the worker
// maintains a single loaded model at a time.
export type WorkerGenerateParams = {
  model?: ModelId;
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
};

// Requests → Worker
export type WorkerRequest =
  | { id: string; kind: 'detect' }
  | { id: string; kind: 'listModels' }
  | { id: string; kind: 'listBackends' }
  | { id: string; kind: 'load'; model: ModelId; options?: LoadOptions }
  | { id: string; kind: 'unload'; model?: ModelId }
  | { id: string; kind: 'purge'; model?: ModelId }
  | { id: string; kind: 'purgeAll' }
  | {
      id: string;
      kind: 'generate';
      params: WorkerGenerateParams; // worker provides signal/onProgress; model optional
      busyPolicy?: WorkerBusyPolicy; // default 'queue'
      replaceQueued?: boolean; // default true
      debounceMs?: number; // default 0
    }
  | { id: string; kind: 'abort' };

// Responses ← Worker
export type WorkerState = 'idle' | 'running' | 'aborting' | 'queued';

export type WorkerAccepted = { id: string; type: 'accepted' };
export type WorkerProgress = {
  id: string;
  type: 'progress';
  event: GenerationProgressEvent & {
    pct?: number;
    bytesDownloaded?: number;
    totalBytesExpected?: number;
    message?: string;
  };
};

export type WorkerGenerateResult =
  | { id: string; type: 'result'; ok: true; blob: Blob; timeMs: number }
  | { id: string; type: 'result'; ok: false; reason: string; message?: string };

// Generic RPC style for non-generate commands
export type WorkerRpcResult =
  | { id: string; type: 'result'; ok: true; data?: any }
  | { id: string; type: 'result'; ok: false; reason: string; message?: string };

export type WorkerStateMsg = { type: 'state'; value: WorkerState };

export type WorkerResponse = WorkerAccepted | WorkerProgress | WorkerGenerateResult | WorkerRpcResult | WorkerStateMsg;

export type { BackendId };
