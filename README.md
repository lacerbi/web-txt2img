# web-txt2img — Browser‑Only Text‑to‑Image Library

A lightweight, browser‑only JavaScript/TypeScript library that provides a unified API to generate images from text prompts in the browser. It supports multiple backends (WebGPU, WebNN, WASM) and models via pluggable adapters.

This README shows the recommended worker‑first integration for application developers. For the full advanced guide (worker protocol and the underlying direct API), see docs/DEVELOPER_GUIDE.md.

## Features

- Unified API: load a model, generate an image, unload, purge cache.
- Backends: WebGPU (preferred), WebNN (opportunistic), WASM (fallback).
- Progress + abort: phase updates and `AbortController` support.
- SD‑Turbo: seeded generation (deterministic latents), 512×512 in v1.
- Cache aware: uses Cache Storage for model artifacts where possible.

## Supported Models (v1)

- SD‑Turbo (ONNX Runtime Web)
  - Task: text‑to‑image (single‑step diffusion).
  - Backends: WebGPU → WebNN → WASM.
  - Seed: supported (deterministic best‑effort).
  - Size: 512×512.
- Janus-Pro-1B (Transformers.js)
  - WebGPU only; seed/size controls not supported.

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

To see the library in action, run the minimal example included in this repo:

- Install deps: `npm i`
- Start dev server: `npm run dev`
- Open: `http://localhost:5173/examples/minimal/`

Details and production notes are in `examples/minimal/README.md`.

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
  { model: 'sd-turbo', prompt: 'a cozy cabin in the woods, watercolor', seed: 42 },
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
await client.unload('sd-turbo');
// Optionally: await client.purge('sd-turbo');
```

## WASM Assets (important for bundlers)

ONNX Runtime Web needs to fetch its runtime files (`ort-wasm*.wasm`, `*.jsep.mjs`). You must ensure they are served and tell ORT where they live via `wasmPaths`.

Common setups:
- Dev with Vite: use `wasmPaths: '/node_modules/onnxruntime-web/dist/'`.
- Production: copy files to your public folder and serve at `/ort/`.

Example copy (production):
```bash
mkdir -p public/ort
cp node_modules/onnxruntime-web/dist/ort-wasm*.* public/ort/
```
Then pass `wasmPaths: '/ort/'` when loading the model.

Tip: Configure threads/SIMD via `wasmNumThreads` and `wasmSimd`. For best WASM performance, serve with COOP/COEP headers (cross‑origin isolated) to enable threads.

## Advanced Usage

- The Worker host and protocol, as well as the underlying direct API, are documented in docs/DEVELOPER_GUIDE.md.
- Includes dependency injection (custom ORT, tokenizer), custom model hosting, and full type references.

## API Overview (Worker)

- Detect/backends/models: `client.detect()`, `client.listBackends()`, `client.listModels()`
- Lifecycle: `client.load(model, options?, onProgress?)`, `client.unload(model)`, `client.purge(model)`, `client.purgeAll()`
- Generation: `client.generate(params, onProgress?, { busyPolicy, replaceQueued, debounceMs }?)` returns `{ id, promise, abort }`
- Queue semantics: single‑flight with single‑slot queue (latest wins by default)

## Parameters & Semantics (SD‑Turbo)

- `prompt`: required
- `seed`: supported; deterministic where backend/drivers allow
- `width/height`: 512×512 in v1
- Progress phases: `tokenizing → encoding → denoising → decoding → complete`

## Janus‑Pro‑1B Status

- Adapter included; image generation has limited support here. WebGPU‑only. See docs/DEVELOPER_GUIDE.md for details and limitations.

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

## License

MIT — see `LICENSE` for details.