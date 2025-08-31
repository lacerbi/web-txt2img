# web-txt2img — Browser‑Only Text‑to‑Image Library

A lightweight, browser‑only JavaScript/TypeScript library that provides a unified API to generate images from text prompts in the browser. It supports multiple backends (WebGPU, WebNN, WASM) and models via pluggable adapters.

This README is for application developers who want to integrate the library into their web app.

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
- To use Janus, install `@huggingface/transformers` (`npm i @huggingface/transformers`) or include it via a `<script>` tag to expose a global `transformers` (experimental here).

## Getting Started (Example App)

To see the library in action, run the minimal example included in this repo:

- Install deps: `npm i`
- Start dev server: `npm run dev`
- Open: `http://localhost:5173/examples/minimal/`

Details and production notes are in `examples/minimal/README.md`.

## Quickstart (SD‑Turbo)

```ts
import {
  detectCapabilities,
  loadModel,
  isModelLoaded,
  generateImage,
  unloadModel,
  purgeModelCache,
} from 'web-txt2img';

// 1) Optional: detect capabilities to decide model/backend
const caps = await detectCapabilities();
console.log('caps', caps); // { webgpu, shaderF16, webnn, wasm }

// 2) Load SD‑Turbo (prefers WebGPU, falls back to WASM)

const loadRes = await loadModel('sd-turbo', {
  backendPreference: ['webgpu', 'wasm'],
  // Tell ONNX Runtime where to find WASM runtime files (see “WASM Assets”)
  wasmPaths: '/ort/',
  wasmNumThreads: 4,
  wasmSimd: true,
  onProgress: (p) => console.log('load:', p),
});
if (!loadRes.ok) throw new Error(loadRes.message ?? loadRes.reason);

// 3) Generate an image
const ac = new AbortController();
const gen = await generateImage({
  model: 'sd-turbo',
  prompt: 'a cozy cabin in the woods, watercolor',
  seed: 42, // deterministic
  signal: ac.signal,
  onProgress: (e) => console.log('gen:', e),
});
if (gen.ok) {
  // Blob -> object URL
  const url = URL.createObjectURL(gen.blob);
  // Display it in an <img> or download
  console.log('done in', Math.round(gen.timeMs), 'ms');
} else {
  console.error('generation failed', gen.reason, gen.message);
}

// 4) Cleanup when done
await unloadModel('sd-turbo');
// Optionally: await purgeModelCache('sd-turbo');
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

## Dependency Injection (advanced, robust)

You can inject runtime dependencies for full control.

- Inject ONNX Runtime:
```ts
import ort from 'onnxruntime-web/webgpu';
await loadModel('sd-turbo', { ort, backendPreference: ['webgpu'], wasmPaths: '/ort/' });
```

- Inject a tokenizer:
```ts
await loadModel('sd-turbo', {
  tokenizerProvider: async () => {
    const { AutoTokenizer } = await import('@xenova/transformers');
    const t = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch16');
    t.pad_token_id = 0;
    return (text: string, opts?: any) => t(text, opts);
  },
});
```

- Override model hosting (use your own CDN):
```ts
await loadModel('sd-turbo', { modelBaseUrl: 'https://your.cdn/sd-turbo' });
```

## API Overview

- Capabilities & Registry:
  - `detectCapabilities(): Promise<{ webgpu; shaderF16; webnn; wasm }>`
  - `listSupportedModels(): ModelInfo[]` (ids, names, supportedBackends)
  - `listBackends(): BackendId[]`
  - `getModelInfo(id)`

- Lifecycle:
  - `loadModel(id, options?): Promise<LoadResult>`
  - `isModelLoaded(id): boolean`
  - `unloadModel(id): Promise<void>`
  - `purgeModelCache(id): Promise<void>`
  - `purgeAllCaches(): Promise<void>`

- Generation:
  - `generateImage({ model, prompt, seed?, width?, height?, signal?, onProgress? }): Promise<GenerateResult>`
  - Progress phases (SD-Turbo): `tokenizing` → `encoding` → `denoising` → `decoding` → `complete`
  - Progress phases (Janus): emits `image_tokens` streaming updates before `complete`

## Parameters & Semantics (SD‑Turbo)

- `prompt`: required.
- `seed`: supported; deterministic where backend/drivers allow.
- `width/height`: 512×512 in v1 (rejects other sizes). Wider sizes coming soon.
- `signal`: supports `AbortController` for cancel.
- `onProgress(e)`: receives phase + `pct` where meaningful.

## Janus‑Pro‑1B Status

- Adapter is included but image generation is experimental in this repo. It is WebGPU‑only. If you need Janus now, integrate directly with Transformers.js or track updates here.
- Abort: mid‑run cancellation is best‑effort; abort is guaranteed only before generation starts.
- Purge: `purgeModelCache('janus-pro-1b')` clears only this library’s Cache Storage entries, not Transformers.js internal caches.

## Troubleshooting

- Error: “no available backend found … both async and sync fetching of the wasm failed”
  - Your app isn’t serving ORT WASM files. Set `wasmPaths` and make sure assets are hosted (see “WASM Assets”).
- Vite complains about dynamic imports of optional deps
  - The library uses computed specifiers and `/* @vite-ignore */` where needed. If your bundler still pre‑bundles optional deps, either install them or inject via options.
- Performance is slow
  - Prefer WebGPU. For WASM, enable SIMD/threads (COOP/COEP) and increase `wasmNumThreads`.

## License

MIT — see `LICENSE` for details.
