# web-txt2img — Worker Host and Base API (Advanced Developer Guide)

Audience: advanced frontend devs integrating web-txt2img with full control over workers, queues, backends, and bundling.

This document defines the Worker protocol and client wrapper, explains policies (single‑flight, single‑slot queue, abort, debounce), and details the base (direct) library API. The minimal example and the recommended integration use the Worker client exclusively; direct API remains available for special cases.

---

## 1) Overview

- All inference runs in the browser (WebGPU/WebNN/WASM), no server required.
- Recommended entrypoint: the Worker client. It keeps heavy work off the main thread and provides robust UX semantics.
- Direct API: still supported if you don’t need the Worker host (tests, custom hosts, specialized orchestration).

---

## 2) Worker Architecture & Policies

- Single‑flight: at most one generation job runs at a time.
- Single‑slot queue: when busy, the Worker retains only the latest queued job. Older queued jobs are rejected with `reason: 'superseded'`.
- Busy policies (on `generate`):
  - `'reject'`: immediately return `{ ok:false, reason:'busy' }`.
  - `'abort_and_queue'`: request abort of current job; keep the latest queued job.
  - `'queue'` (default): finish current job; then run the latest queued job.
- Debounce (`debounceMs`): defers starting the queued job to coalesce rapid user inputs.
- Abort timeout: if abort doesn’t take effect quickly, emit a hint (`phase: 'aborting_timeout'`) and fall back to “run queued after completion”.
- State telemetry: the worker posts `{ type:'state', value:'idle'|'running'|'aborting'|'queued' }` (optional)
- One model loaded at a time: if a model is already loaded (or a load is in flight), `load` is rejected with `reason: 'busy'` and a message. Unload first, then load another model.

---

## 3) Worker Protocol

Types are defined in `src/worker/protocol.ts` and re‑exported from `src/index.ts`.

### 3.1 Requests → Worker

- Lifecycle
  - `{ id, kind: 'detect' }`
  - `{ id, kind: 'listModels' }`
  - `{ id, kind: 'listBackends' }`
  - `{ id, kind: 'load', model, options? }`
  - `{ id, kind: 'unload', model }`
  - `{ id, kind: 'purge', model }`
  - `{ id, kind: 'purgeAll' }`
- Generate
  - `{ id, kind: 'generate', params, busyPolicy?, replaceQueued?, debounceMs? }`
    - `params`: `{ model, prompt, seed?, width?, height? }` (same as base API minus `signal`/`onProgress`)
    - `busyPolicy`: `'reject' | 'abort_and_queue' | 'queue'` (default `'queue'`)
    - `replaceQueued`: boolean (default `true`)
    - `debounceMs`: number (default `0`)
- Abort current
  - `{ id, kind: 'abort' }`

Notes
- `id` is per‑request (not the model id). It correlates responses to requests.

### 3.2 Responses ← Worker

- Accepted
  - `{ id, type: 'accepted' }` (optional ack; generation will run now or later)
- Progress
  - `{ id, type: 'progress', event }` (includes normalized `pct` when possible)
- Result
  - Success: `{ id, type: 'result', ok: true, blob, timeMs }`
  - Failure: `{ id, type: 'result', ok: false, reason, message? }`, where reason ∈ `busy | superseded | cancelled | internal_error | …`
- State (telemetry)
  - `{ type: 'state', value: 'idle' | 'running' | 'aborting' | 'queued' }`

Special cases
- Superseded queued job: the replaced queued request id receives `{ id, type:'result', ok:false, reason:'superseded' }`.

---

## 4) Worker Client Wrapper

The wrapper lives in `src/worker/client.ts` and is exported from `src/index.ts`.

Creation

```ts
import { Txt2ImgWorkerClient } from 'web-txt2img';

// Vite-friendly ESM worker creation under the hood
const client = Txt2ImgWorkerClient.createDefault();
```

Methods

- `detect(): Promise<{ webgpu; shaderF16; webnn; wasm }>`
- `listModels(): Promise<ModelInfo[]>`
- `listBackends(): Promise<BackendId[]>`
- `load(model, options?, onProgress?)`
  - Enforces single‑model policy; rejects if another model is already loaded or a load is in flight.
- `unload(model)`
- `purge(model)`
- `purgeAll()`
- `generate(params, onProgress?, { busyPolicy, replaceQueued, debounceMs }?)`
  - Returns `{ id, promise, abort }`
  - `abort()` cancels the current job (best‑effort for some adapters)

Usage example

```ts
const loadRes = await client.load('sd-turbo', {
  backendPreference: ['webgpu', 'wasm'],
  wasmPaths: '/ort/',
  wasmNumThreads: 4,
  wasmSimd: true,
}, (p) => console.log('load:', p));

const { promise, abort } = client.generate(
  { model: 'sd-turbo', prompt: 'a watercolor cabin', seed: 42 },
  (e) => console.log('gen:', e),
  { busyPolicy: 'queue', debounceMs: 200 }
);
const res = await promise;
if (res.ok) {
  const url = URL.createObjectURL(res.blob);
} else {
  console.warn('failed', res.reason, res.message);
}
```

Worker creation in custom setups

```ts
import { createTxt2ImgWorker, Txt2ImgWorkerClient } from 'web-txt2img';
const worker = createTxt2ImgWorker(); // ESM module worker via new URL('./host.ts', import.meta.url)
const client = new Txt2ImgWorkerClient(worker);
```

Model IDs (strings)

- `sd-turbo` — SD‑Turbo (ONNX Runtime Web)
- `janus-pro-1b` — Janus‑Pro‑1B (Transformers.js)

Programmatically enumerate supported models:

```ts
// Worker client
const models = await client.listModels();
// [{ id: 'sd-turbo', displayName: 'SD-Turbo …' }, { id: 'janus-pro-1b', … }]

// Direct API (no worker)
import { listSupportedModels } from 'web-txt2img';
const models2 = listSupportedModels();
```

---

## 5) Base (Direct) API

Exports from `src/index.ts`. Useful in tests or if running inside your own worker.

- Capabilities and registry
  - `detectCapabilities(): Promise<{ webgpu; shaderF16; webnn; wasm }>`
  - `listBackends(): BackendId[]`
  - `listSupportedModels(): ModelInfo[]`
  - `getModelInfo(id): ModelInfo`
- Lifecycle
  - `loadModel(id, options?): Promise<LoadResult>`
  - `isModelLoaded(id): boolean`
  - `unloadModel(id): Promise<void>`
  - `purgeModelCache(id): Promise<void>`
  - `purgeAllCaches(): Promise<void>`
- Generation
  - `generateImage({ model, prompt, seed?, width?, height?, signal?, onProgress? }): Promise<GenerateResult>`

Important types: see `src/types.ts`.

`LoadOptions`
- `backendPreference?: BackendId[]` (order matters)
- `onProgress?: (p: LoadProgress) => void`
- Dependency injection & config
  - `ort?: any` (onnxruntime-web module instance)
  - `tokenizerProvider?: () => Promise<(text: string, opts?: any) => Promise<{ input_ids: number[] }>>`
  - `wasmPaths?: string` (absolute recommended, e.g. `'/ort/'`)
  - `wasmNumThreads?: number`, `wasmSimd?: boolean`
  - `modelBaseUrl?: string` (override default CDN for SD‑Turbo)

`GenerateParams`
- `model: ModelId`, `prompt: string`, `seed?: number`, `width?: number`, `height?: number`, `signal?: AbortSignal`, `onProgress?: (event) => void`

`GenerateResult`
- Success: `{ ok: true, blob: Blob, timeMs: number }`
- Failure: `{ ok: false, reason: ErrorCode, message?: string }`

---

## 6) Adapter‑Specific Notes

SD‑Turbo (ONNX Runtime Web)
- Backends: WebGPU → WebNN → WASM (preference configurable)
- Size: 512×512 in v1; `seed` supported (deterministic best‑effort)
- Progress phases: `tokenizing → encoding → denoising → decoding → complete`
- WASM assets: must be served; pass `wasmPaths` to `load`
- Worker canvas: uses `OffscreenCanvas` when `HTMLCanvasElement` is not available

Janus‑Pro‑1B (Transformers.js)
- Backends: WebGPU only
- Seed/size controls: not supported here
- Progress: streams `image_tokens` before `complete`
- Abort: best‑effort mid‑run via streamer; may delay until a safe point

---

## 7) Assets, Bundling, and Security

- ESM Worker: created as `new Worker(new URL('./host.ts', import.meta.url), { type: 'module' })`. This pattern is recognized by Vite and other bundlers.
- ONNX WASM assets:
  - Dev (Vite): `wasmPaths: '/node_modules/onnxruntime-web/dist/'`
  - Prod: copy to `public/ort/` and pass `wasmPaths: '/ort/'`
- COOP/COEP: serve with cross‑origin isolation to enable WASM threads for best performance.
- CSP: include appropriate `worker-src` and `connect-src` entries for your model hosting/CDN.

---

## 8) Error Codes & Semantics

- Base errors: `'webgpu_unsupported' | 'backend_unavailable' | 'model_not_loaded' | 'unsupported_option' | 'cancelled' | 'internal_error'`
- Worker‑level reasons on failed result: `'busy' | 'superseded' | 'cancelled' | 'internal_error'`
- Busy cases:
  - Generating with `'reject'` policy
  - Queue has a job and `replaceQueued: false`
  - Load requested while a model is already loaded or a load is in flight

---

## 9) Troubleshooting

- SyntaxError: Unexpected reserved word
  - Ensure the Worker is created via `new Worker(new URL('./host.ts', import.meta.url), { type: 'module' })` so the bundler transpiles the Worker.
- onnxruntime: both async and sync fetching of the wasm failed
  - Set `wasmPaths` and make sure the WASM assets are hosted (dev: node_modules path; prod: `/ort/`).
- HTMLCanvasElement is not defined (in Worker)
  - Expected in Workers without DOM; adapters use `OffscreenCanvas` when `HTMLCanvasElement` is missing.
- Slow performance
  - Prefer WebGPU; for WASM enable SIMD/threads and set `wasmNumThreads`.

---

## 10) Recommendations

- Use the Worker client for production UIs.
- Coalesce rapid user inputs with `debounceMs` (e.g., 150–300ms).
- Prefer `'abort_and_queue'` for “live” UIs where latest input should win.
- Keep only one model loaded at a time (enforced by the Worker).
- Before unloading, abort/let current job finish to avoid surprising failures.

---

## 11) References

- Public types: `src/types.ts`
- Worker protocol: `src/worker/protocol.ts`
- Worker host: `src/worker/host.ts`
- Worker client: `src/worker/client.ts`
- Example app: `examples/minimal/`
