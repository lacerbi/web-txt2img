# web-txt2img — Browser‑Only Text‑to‑Image Library

A lightweight, browser‑only JavaScript/TypeScript library that provides a unified API to generate images from text prompts in the browser. It uses open-weights text-to-image generation models such as SD-Turbo and Janus-Pro-1B. It supports multiple backends (WebGPU, WebNN, WASM) and models via pluggable adapters. Models are downloaded on-the-fly and stored locally.

## Features

- Unified API: load a model, generate an image, unload, purge cache.
- Backends: WebGPU (preferred), WebNN (opportunistic), WASM (fallback).
- Progress + abort: phase updates and `AbortController` support.
- SD‑Turbo: seeded generation (deterministic latents), 512×512 image size.
- Cache aware: uses Cache Storage for model artifacts where possible.

## Supported Models

- **SD-Turbo (ONNX Runtime Web)** — `sd-turbo`  
  Fast single-step text-to-image model distilled from Stable Diffusion 2.1 using Adversarial Diffusion Distillation (ADD). Ideal for real-time generation in the browser.  
  - Task: text-to-image (single-step diffusion; the family supports ~1–4 steps).  
  - Backends: WebGPU → WebNN → WASM (auto-selected).  
  - Controls: `prompt`, `seed` (best-effort determinism), `width/height` = 512×512.  
  - Assets: UNet/VAE in ONNX; CLIP tokenization via Transformers.js.  
  - References: [Model card](https://huggingface.co/stabilityai/sd-turbo), [ADD report](https://stability.ai/research/adversarial-diffusion-distillation), [ORT WebGPU docs](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html).

- **Janus-Pro-1B (Transformers.js)** — `janus-pro-1b`  
  Autoregressive, unified multimodal model (any-to-any). In this library, only image generation is exposed. WebGPU-only.
  - Task: text-to-image (limited; no seed/size controls).  
  - Backend: WebGPU (no WASM/WebNN path).  
  - Controls: `prompt` only.  
  - See docs/DEVELOPER_GUIDE.md for details and limitations
  - References: [Paper](https://arxiv.org/html/2501.17811v1), [HF model](https://huggingface.co/deepseek-ai/Janus-Pro-1B), [ONNX community export](https://huggingface.co/onnx-community/Janus-Pro-1B-ONNX), [Repo](https://github.com/deepseek-ai/Janus).

<details>
<summary>SD-Turbo & Janus-Pro-1B — Details & Tips</summary>

### SD-Turbo — Details & Tips

- **What it is.** A distilled Stable Diffusion 2.1 variant trained with **ADD** for single-step (turbo) synthesis; great for low-latency browser generation. See the model card and research report above.  
- **Backends.** Prefer **WebGPU** for speed; WebNN and WASM serve as opportunistic/fallback paths. See the ORT WebGPU execution provider docs for capabilities and flags.  
- **Determinism.** `seed` aims for deterministic latents, but cross-backend/driver differences can introduce small variations.  
- **Demos & references.** Community demos show SD-Turbo running fully in-browser (e.g., ORT WebGPU SD-Turbo demo; WebNN SD-Turbo demo).  
  - Example demos: [guschmue/ort-webgpu (SD-Turbo)](https://github.com/guschmue/ort-webgpu), [WebNN SD-Turbo demo](https://microsoft.github.io/webnn-developer-preview/demos/sd-turbo/).

### Janus-Pro-1B — Details & Tips

- **What it is.** A ~1B-parameter **autoregressive** unified multimodal model (“Janus-Pro”) from DeepSeek; research indicates improved text-to-image quality vs. earlier Janus.  
- **Browser support.** **WebGPU-only** in this library’s adapter due to heavy shader workloads and memory usage.  
- **Library note.** Use **Transformers.js** (v3+) in the browser. You can install the official package (`@huggingface/transformers`) or include it via a `<script>` tag to expose a global `transformers`. See the Transformers.js docs and examples for environment setup.  
  - Docs: [Transformers.js installation](https://huggingface.co/docs/transformers.js/en/installation), [GitHub](https://github.com/huggingface/transformers.js).

</details>

## Requirements

- Modern browser. For WebGPU path, a WebGPU‑enabled browser (Chrome/Edge) and compatible GPU.
- No server required — all inference runs in the browser.

## Install

Install the library and its peer runtime dependencies in your app:

```bash
npm i web-txt2img onnxruntime-web @xenova/transformers
# or: pnpm add … / yarn add …
```

Notes:
- `@xenova/transformers` is used to tokenize prompts for SD-Turbo (CLIP). You can also inject your own tokenizer (see DI below).
- To use Janus, install `@huggingface/transformers` (`npm i @huggingface/transformers`) or include it via a `<script>` tag to expose a global `transformers`.

## Getting Started (Example App)

This repo is organized as a workspace. The minimal example lives under `examples/vanilla-worker`.

- Install deps: `npm i`
- Start example dev server: `npm run dev:vanilla`
- Open: `http://localhost:5173/`

Details and production notes are in `examples/vanilla-worker/README.md`.

## Quickstart (Worker‑First)

```ts
import { Txt2ImgWorkerClient } from 'web-txt2img';

// 1) Create the worker client (ESM module worker under the hood)
const client = Txt2ImgWorkerClient.createDefault();

// 2) Optional: detect capabilities
const caps = await client.detect();
console.log('caps', caps); // { webgpu, shaderF16, webnn, wasm }

// 3) Load a model (SD‑Turbo prefers WebGPU, falls back to WASM)
const loadRes = await client.load('sd-turbo', {
  backendPreference: ['webgpu', 'wasm'],
  // Tell ONNX Runtime where to find WASM runtime files (see “WASM Assets”)
  wasmPaths: '/ort/',
  wasmNumThreads: 4,
  wasmSimd: true,
}, (p) => console.log('load:', p));
if (!loadRes?.ok) throw new Error(loadRes?.message ?? 'load failed');

// 4) Generate an image
const { promise, abort } = client.generate(
  { prompt: 'a cozy cabin in the woods, watercolor', seed: 42 },
  (e) => console.log('gen:', e),
  { busyPolicy: 'queue', debounceMs: 200 }
);
const gen = await promise;
if (gen.ok) {
  const url = URL.createObjectURL(gen.blob);
  // Display in an <img> or download
  console.log('done in', Math.round(gen.timeMs), 'ms');
} else {
  console.error('generation failed', gen.reason, gen.message);
}

// 5) Cleanup when done
await client.unload();
// Optionally: await client.purge();
```

### Model IDs (strings)

Use these exact strings when calling `load`. For `generate`, `unload`, and `purge` the worker defaults to the currently loaded model if omitted:

- `sd-turbo`: SD‑Turbo (ONNX Runtime Web)
- `janus-pro-1b`: Janus‑Pro‑1B (Transformers.js)

You can also enumerate supported models at runtime:

```ts
const models = await client.listModels();
// [{ id: 'sd-turbo', displayName: 'SD-Turbo …' }, { id: 'janus-pro-1b', … }]
```

## WASM Assets (important for bundlers)

ONNX Runtime Web needs to fetch its runtime files (`ort-wasm*.wasm`, `*.jsep.mjs`). You must ensure they are served and tell ORT where they live via `wasmPaths`.

Common setups:
- Recommended (dev and prod): copy files to your public folder and serve at `/ort/`, then set `wasmPaths: '/ort/'`.
- Vite (advanced): in dev, point `wasmPaths` to the package dist via an absolute `/@fs/.../node_modules/onnxruntime-web/dist/` path. See `examples/vanilla-worker/vite.config.ts` for a robust way to compute this.

Example copy (production):
```bash
mkdir -p public/ort
cp node_modules/onnxruntime-web/dist/ort-wasm*.* public/ort/
```
Then pass `wasmPaths: '/ort/'` when loading the model.

Tip: Configure threads/SIMD via `wasmNumThreads` and `wasmSimd`. For best WASM performance, serve with COOP/COEP headers (cross‑origin isolated) to enable threads.

## API Overview (Worker)

- Detect/backends/models: `client.detect()`, `client.listBackends()`, `client.listModels()`
- Lifecycle: `client.load(model, options?, onProgress?)`, `client.unload(model?)`, `client.purge(model?)`, `client.purgeAll()`
- Generation: `client.generate(params, onProgress?, { busyPolicy, replaceQueued, debounceMs }?)` returns `{ id, promise, abort }` (`params.model` optional; defaults to loaded model)
- Queue semantics: single‑flight with single‑slot queue (latest wins by default)

Progress events on `load` include standardized fields: `bytesDownloaded` and `totalBytesExpected` (when known) and `pct`. UIs can render precise progress for SD‑Turbo and best‑effort for Janus.

## Parameters & Semantics

- `prompt`: required
- `seed`: supported for `sd-turbo`; deterministic where backend/drivers allow
- `width/height`: 512×512

Model registry entries now include approximate size fields for UX:
- `sizeBytesApprox?`, `sizeGBApprox?`, `sizeNotes?`

## Advanced Usage

- The Worker host and protocol, as well as the underlying direct API, are documented in docs/DEVELOPER_GUIDE.md.
- Includes dependency injection (custom ORT, tokenizer), custom model hosting, and full type references.

## Recipes

Practical snippets distilled from `examples/vanilla-worker` so you don’t have to open the example to get started.

<details>
<summary>Show Recipes</summary>

### 1) Dev vs. Prod WASM paths (Vite)

Use the ONNX Runtime Web WASM assets directly from `node_modules` in **dev**, and from `/public/ort/` in **prod**.

```ts
// vite.config.ts — expose a dev-only absolute path to ORT's dist folder
import { defineConfig } from 'vite';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let ortPkgPath = '';
try { ortPkgPath = require.resolve('onnxruntime-web/package.json'); } catch {}
const ortDistFs = path.join(ortPkgPath ? path.dirname(ortPkgPath) : path.resolve('node_modules/onnxruntime-web'), 'dist');
const ORT_WASM_BASE_DEV = `/@fs/${ortDistFs}/`;

export default defineConfig({
  define: { __ORT_WASM_BASE_DEV__: JSON.stringify(ORT_WASM_BASE_DEV) },
});
```

```js
// When loading SD-Turbo
const isJanus = model === 'janus-pro-1b';
const wasmPaths = isJanus ? undefined
  : (import.meta.env?.DEV ? __ORT_WASM_BASE_DEV__ : (import.meta.env.BASE_URL || '/') + 'ort/');

await client.load(model, {
  backendPreference: isJanus ? ['webgpu'] : ['webgpu', 'wasm'],
  ...(wasmPaths ? { wasmPaths } : {}),
  ...(wasmPaths ? { wasmNumThreads: Math.min(4, navigator.hardwareConcurrency ?? 2) } : {}),
  ...(wasmPaths ? { wasmSimd: true } : {}),
}, onProgress);
```

> Production: copy the ORT files into `public/ort/` (e.g., via a small script) and serve them. See “WASM Assets” above for the one-liner `cp` command.

### 2) Progress UI wiring (standardized fields)

`load()` (and `generate()`) emit normalized progress with `pct`, and—when available—`bytesDownloaded` and `totalBytesExpected`. A tiny helper drives a `<progress>` bar and a status line:

```html
<progress id="bar" max="100" value="0" style="width: 420px;"></progress>
<span id="line">Idle</span>
```

```js
function setProgress(p = {}) {
  const bar = document.getElementById('bar');
  const line = document.getElementById('line');
  const pct = p.pct != null ? `${p.pct}%` : '';
  let size = '';
  if (p.bytesDownloaded != null && p.totalBytesExpected != null) {
    size = ` ${(p.bytesDownloaded/1024/1024).toFixed(1)}/${(p.totalBytesExpected/1024/1024).toFixed(1)}MB`;
  }
  line.textContent = `${p.message ?? ''} ${pct}${size}`.trim();
  if (p.pct != null) bar.value = p.pct; else bar.removeAttribute('value');
}

// Use it:
await client.load('sd-turbo', opts, (p) => setProgress(p));
const { promise } = client.generate({ prompt, seed }, (e) => setProgress({ ...e, message: `generate: ${e.phase}` }));
```

### 3) “Live” UIs: queue + debounce + abort

Use a single-slot queue with debounce while the user types; wire the returned `abort()` to a button:

```js
let generating = false;
let currentAbort = null;

async function startGeneration(prompt, seed) {
  if (generating) return;
  generating = true;
  const { promise, abort } = client.generate(
    { prompt, seed },
    (e) => setProgress({ ...e, message: `generate: ${e.phase}` }),
    { busyPolicy: 'queue', debounceMs: 200 }
  );
  currentAbort = abort;
  const res = await promise;
  generating = false;
  currentAbort = null;
  if (res.ok) document.querySelector('#out').src = URL.createObjectURL(res.blob);
}

document.querySelector('#abort').onclick = async () => {
  if (currentAbort) { try { await currentAbort(); } catch {} }
};
```

### 4) Model size in UX + measured downloads

Use registry estimates **before** loading, and the **actual bytes** from the load result:

```js
const models = await client.listModels();
const sd = models.find(m => m.id === 'sd-turbo');
console.log(`Approx size: ${(sd.sizeBytesApprox/1024/1024).toFixed(1)} MB`);

const res = await client.load('sd-turbo', opts, onProgress);
if (res.ok) {
  console.log('Backend used:', res.backendUsed);
  if (typeof res.bytesDownloaded === 'number') {
    console.log('Downloaded (measured):', (res.bytesDownloaded/1024/1024).toFixed(1), 'MB');
  }
}
```

### 5) Janus-Pro-1B quick checklist

* **WebGPU-only** (no WASM/WebNN path in this adapter).
* Ensure `@huggingface/transformers` is available:

  * **Bundled:** `npm i @huggingface/transformers` and import normally.
  * **Script tag:** include Transformers.js to expose a global `window.transformers` (check the official docs for the latest URL).

    ```html
    <!-- Example; confirm the latest version/URL in the Transformers.js docs -->
    <script src="https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.x/dist/transformers.min.js"></script>
    ```
* Then simply:

  ```js
  await client.load('janus-pro-1b', { backendPreference: ['webgpu'] }, onProgress);
  const { promise } = client.generate({ prompt: 'a watercolor cabin at dusk' }, onProgress);
  const res = await promise;
  ```

### 6) One model at a time (worker policy)

The worker enforces a **single loaded model**. To switch:

```js
await client.unload();            // unload current
await client.load('janus-pro-1b', { backendPreference: ['webgpu'] });
```

If you try to `load()` while another is loaded (or a load is in flight), you’ll get `{ ok:false, reason:'busy' }`.

### 7) Self-hosting SD-Turbo (and injecting a tokenizer)

Point to your own CDN and (optionally) inject a tokenizer to avoid bundling `@xenova/transformers` globally:

```js
await client.load('sd-turbo', {
  backendPreference: ['webgpu', 'wasm'],
  wasmPaths: '/ort/',
  modelBaseUrl: 'https://my-cdn.example.com/sd-turbo-ort-web',
  tokenizerProvider: async () => {
    const { AutoTokenizer } = await import('@xenova/transformers');
    const tok = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch16');
    tok.pad_token_id = 0;
    return (text, opts) => tok(text, opts);
  },
}, onProgress);
```

### 8) Cache control

Artifacts are cached in Cache Storage per model. You can clear them:

```js
await client.purge();   // purge the currently-loaded model’s cache
await client.purgeAll();// purge all web-txt2img caches
```

> Tip: after `purge()`, the next `load()` will re-download the model; consider showing a warning in your UI.

</details>

## Troubleshooting

- Error: “no available backend found … both async and sync fetching of the wasm failed”
  - Your app isn’t serving ORT WASM files. Set `wasmPaths` and make sure assets are hosted (see “WASM Assets”).
- Vite complains about dynamic imports of optional deps
  - The library uses computed specifiers and `/* @vite-ignore */` where needed. If your bundler still pre‑bundles optional deps, either install them or inject via options.
- Performance is slow
  - Prefer WebGPU. For WASM, enable SIMD/threads (COOP/COEP) and increase `wasmNumThreads`.

## Acknowledgements

This library’s design and adapters were inspired by prior work:

- **Janus Pro WebGPU (Transformers.js example)**  
  https://github.com/huggingface/transformers.js-examples/tree/main/janus-pro-webgpu

- **ONNX Runtime Web SD-Turbo browser example**  
  https://github.com/microsoft/onnxruntime-inference-examples/tree/main/js/sd-turbo
  ((live demo)[https://guschmue.github.io/ort-webgpu/sd-turbo/index.html])

This library was written using [Codex CLI](https://developers.openai.com/codex/cli/).

## License

MIT — see `LICENSE` for details.
