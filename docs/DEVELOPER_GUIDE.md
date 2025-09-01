# web-txt2img — Worker Host and Base API (Advanced Developer Guide)

Audience: advanced frontend devs integrating web-txt2img with full control over workers, queues, backends, and bundling.

This document defines the Worker protocol and client wrapper, explains policies (single‑flight, single‑slot queue, abort, debounce), and details the base (direct) library API. The minimal example and the recommended integration use the Worker client exclusively; direct API remains available for special cases.

---

## 1) Overview

- All inference runs in the browser (WebGPU), no server required.
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

Types are defined in `packages/web-txt2img/src/worker/protocol.ts` and re‑exported from `packages/web-txt2img/src/index.ts`.

### 3.1 Requests → Worker

- Lifecycle
  - `{ id, kind: 'detect' }`
  - `{ id, kind: 'listModels' }`
  - `{ id, kind: 'listBackends' }`
  - `{ id, kind: 'load', model, options? }`
  - `{ id, kind: 'unload', model? }`
  - `{ id, kind: 'purge', model? }`
  - `{ id, kind: 'purgeAll' }`
- Generate
- `{ id, kind: 'generate', params, busyPolicy?, replaceQueued?, debounceMs? }`
    - `params`: `{ model?, prompt, seed?, width?, height? }` (`model` is optional in the worker; defaults to the currently loaded model)
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

The wrapper lives in `packages/web-txt2img/src/worker/client.ts` and is exported from `packages/web-txt2img/src/index.ts`.

Creation

```ts
import { Txt2ImgWorkerClient } from 'web-txt2img';

// Vite-friendly ESM worker creation under the hood
const client = Txt2ImgWorkerClient.createDefault();
```

Methods

- `detect(): Promise<{ webgpu; shaderF16; wasm }>` (Note: WASM support is experimental)
- `listModels(): Promise<ModelInfo[]>`
- `listBackends(): Promise<BackendId[]>`
- `load(model, options?, onProgress?)`
  - Enforces single‑model policy; rejects if another model is already loaded or a load is in flight.
- `unload(model?)`
- `purge(model?)`
- `purgeAll()`
- `generate(params, onProgress?, { busyPolicy, replaceQueued, debounceMs }?)`
  - Returns `{ id, promise, abort }`
  - `abort()` cancels the current job (best‑effort for some adapters)

Usage example

```ts
const loadRes = await client.load('sd-turbo', {
  backendPreference: ['webgpu'], // WebGPU is required
  // Note: WASM fallback exists in API but is experimental/untested
}, (p) => console.log('load:', p));

const { promise, abort } = client.generate(
  { prompt: 'a watercolor cabin', seed: 42 },
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

Exports from `packages/web-txt2img/src/index.ts`. Useful in tests or if running inside your own worker.

- Capabilities and registry
  - `detectCapabilities(): Promise<{ webgpu; shaderF16; wasm }>` (Note: WASM is experimental)
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
  - `wasmPaths?: string` (for experimental WASM fallback only)
  - `wasmNumThreads?: number`, `wasmSimd?: boolean` (for experimental WASM fallback only)
  - `modelBaseUrl?: string` (override default CDN for SD‑Turbo)

`GenerateParams`
- Base (direct API): `model: ModelId`, `prompt: string`, `seed?: number`, `width?: number`, `height?: number`, `signal?: AbortSignal`, `onProgress?: (event) => void`
- Worker convenience: `model` is optional and defaults to the currently loaded model. If none is loaded or the provided `model` mismatches the loaded one, the worker returns `{ ok:false, reason:'model_not_loaded' }`.

`GenerateResult`
- Success: `{ ok: true, blob: Blob, timeMs: number }`
- Failure: `{ ok: false, reason: ErrorCode, message?: string }`

---

## 6) Adapter‑Specific Notes

SD‑Turbo (ONNX Runtime Web)
- Backend: WebGPU (required for reliable operation)
- Size: 512×512 in v1; `seed` supported (deterministic best‑effort)
- Progress phases: `tokenizing → encoding → denoising → decoding → complete`
- Worker canvas: uses `OffscreenCanvas` when `HTMLCanvasElement` is not available
- Note: WASM fallback exists in API but is experimental and not recommended

Janus‑Pro‑1B (Transformers.js)
- Backends: WebGPU only
- Seed/size controls: not supported here
- Progress: streams `image_tokens` before `complete`
- Abort: best‑effort mid‑run via streamer; may delay until a safe point

---

## 7) Assets, Bundling, and Security

- ESM Worker: created as `new Worker(new URL('./host.ts', import.meta.url), { type: 'module' })`. This pattern is recognized by Vite and other bundlers.
- WebGPU requirement: Ensure your users have WebGPU-enabled browsers (Chrome/Edge 113+, Safari Technology Preview, Firefox Nightly).
- Note: While WASM assets configuration exists in the API for compatibility, it is experimental and not tested.
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
- "WebGPU is not supported" or "no available backend found"
  - Ensure WebGPU is enabled in the browser. Use Chrome/Edge 113+ or other WebGPU-compatible browsers.
- HTMLCanvasElement is not defined (in Worker)
  - Expected in Workers without DOM; adapters use `OffscreenCanvas` when `HTMLCanvasElement` is missing.
- Slow performance
  - Ensure WebGPU is enabled and GPU drivers are up to date. Check that hardware acceleration is not disabled in browser settings.

---

## 10) Recommendations

- Use the Worker client for production UIs.
- Coalesce rapid user inputs with `debounceMs` (e.g., 150–300ms).
- Prefer `'abort_and_queue'` for “live” UIs where latest input should win.
- Keep only one model loaded at a time (enforced by the Worker).
- Before unloading, abort/let current job finish to avoid surprising failures.

---

## 11) References

- Public types: `packages/web-txt2img/src/types.ts`
- Worker protocol: `packages/web-txt2img/src/worker/protocol.ts`
- Worker host: `packages/web-txt2img/src/worker/host.ts`
- Worker client: `packages/web-txt2img/src/worker/client.ts`
- Example app: `examples/vanilla-worker/`
Type notes
- `ModelInfo` includes optional size fields for UX: `sizeBytesApprox?`, `sizeGBApprox?`, `sizeNotes?`.
- `LoadProgress` during downloads may include: `bytesDownloaded?`, `totalBytesExpected?`, `pct?`, and optionally `asset?`, `accuracy?`.

---

## 12) Experimental WASM Fallback (Not Recommended)

> **⚠️ WARNING**: WASM support is experimental, untested, and not recommended for production use. This library is designed and optimized for WebGPU. The WASM fallback exists in the API primarily for compatibility reasons and may be removed in future versions. Use at your own risk.

### Why You Shouldn't Use WASM

- **Untested**: The WASM code paths have not been thoroughly tested
- **Poor Performance**: Significantly slower than WebGPU (10-100x slower depending on hardware)
- **Memory Issues**: May run out of memory on complex models
- **No Active Development**: WASM support is not being actively maintained or improved

### When WASM Might Be Considered

Only consider WASM if ALL of the following apply:
- Your target browsers absolutely cannot support WebGPU
- You accept significantly degraded performance
- You're willing to test and debug issues yourself
- You understand this is experimental and unsupported

### WASM Setup Instructions

If you still need to experiment with WASM despite the warnings:

#### 1. Install ONNX Runtime Web

```bash
npm i onnxruntime-web
```

#### 2. Serve WASM Assets

ONNX Runtime Web needs to fetch runtime files (`ort-wasm*.wasm`, `*.jsep.mjs`).

**Production Setup:**
```bash
# Copy WASM files to your public directory
mkdir -p public/ort
cp node_modules/onnxruntime-web/dist/ort-wasm*.* public/ort/
```

**Development Setup (Vite):**
```ts
// vite.config.ts
import { defineConfig } from 'vite';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ortPkgPath = '';
try { 
  ortPkgPath = require.resolve('onnxruntime-web/package.json'); 
} catch {}

const ortDistFs = path.join(
  ortPkgPath ? path.dirname(ortPkgPath) : path.resolve('node_modules/onnxruntime-web'), 
  'dist'
);
const ORT_WASM_BASE_DEV = `/@fs/${ortDistFs}/`;

export default defineConfig({
  define: { 
    __ORT_WASM_BASE_DEV__: JSON.stringify(ORT_WASM_BASE_DEV) 
  },
});
```

#### 3. Load Model with WASM Fallback

```js
// WASM fallback configuration (NOT RECOMMENDED)
const wasmPaths = import.meta.env?.DEV 
  ? __ORT_WASM_BASE_DEV__ 
  : '/ort/';

await client.load('sd-turbo', {
  backendPreference: ['webgpu', 'wasm'], // Try WebGPU first, fall back to WASM
  wasmPaths: wasmPaths,
  wasmNumThreads: 4, // Adjust based on hardware
  wasmSimd: true,
}, onProgress);

// Or force WASM-only (REALLY NOT RECOMMENDED)
await client.load('sd-turbo', {
  backendPreference: ['wasm'], // Force WASM only
  wasmPaths: wasmPaths,
  wasmNumThreads: navigator.hardwareConcurrency || 4,
  wasmSimd: true,
}, onProgress);
```

#### 4. WASM Performance Optimization

If you must use WASM, these settings may help (but performance will still be poor):

- **Enable SIMD**: Set `wasmSimd: true` (requires browser support)
- **Configure Threads**: Set `wasmNumThreads` to 2-4 (more isn't always better)
- **Enable Cross-Origin Isolation**: Serve with COOP/COEP headers for SharedArrayBuffer support
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

### WASM Troubleshooting

Common issues when using the experimental WASM fallback:

- **"both async and sync fetching of the wasm failed"**
  - WASM files not being served correctly. Check `wasmPaths` and file locations
  
- **Out of memory errors**
  - WASM has memory limitations. Try reducing batch size or image resolution
  
- **Extremely slow performance**
  - This is expected. WASM is 10-100x slower than WebGPU. Consider if you really need to support non-WebGPU browsers

### Final Warning

**We strongly recommend requiring WebGPU support instead of using WASM.** Modern browsers (Chrome/Edge 113+, Safari Technology Preview, Firefox Nightly) support WebGPU. The performance difference is dramatic, and the WASM fallback may be removed in future versions.

If you encounter issues with WASM, please don't file bug reports unless you're also willing to contribute fixes, as WASM support is not actively maintained.
