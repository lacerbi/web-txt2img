# Web Image Generation Library (Browser-Only) — Technical Design Document

## 0) Purpose & Scope

This document defines the architecture, API, and implementation approach for a lightweight JavaScript/TypeScript **browser-only** library that enables **text-to-image generation** with a unified, ergonomic API across multiple models and backends. It is intended as a **developer guide and starting blueprint** for building the library.

**Primary goals (v1):**

- Clean, unified API for **image generation** in the browser.
- First-class support for **WebGPU**; **WASM fallback** where feasible.
- Initial model support: **SD-Turbo** (ONNX Runtime Web) and **Janus-Pro-1B** (Transformers.js).
- **Graceful failures** when capabilities are missing (no app crashes).
- **Model lifecycle**: list supported models, load, generate, unload, purge cache.
- **Progress & abort** for generation calls.
- **Seeded generation** (deterministic latents) for SD-Turbo.
- **No negative prompts in v1** (explicitly out of scope now).

**Non-goals (v1):**

- Negative prompts and classifier-free guidance (CFG) for SD-Turbo.
- Cross-platform Node.js support (this is **browser-only**). We target browser and Electron renderer only. Pure Node/Electron main process is out of scope for v1 (different runtimes, GPU backends, caching, and worker model).
- In-depth UI. (We will ship a minimal example app solely to showcase usage; we will remove the `examples/` folder later if desired.)

**Audience:** Engineers building the library and developers integrating the library into web apps.

---

## 1) Context & Source References

We’re basing the design on two working, browser-native examples you provided:

- **Janus Pro WebGPU** (React, Transformers.js):

  - _Key references:_

    - `examples/janus-pro-webgpu/src/worker.js` (full) — WebGPU capability checks, model loading, image/text generation, interruptible streaming
    - `examples/janus-pro-webgpu/src/App.jsx` (full) — UI wrapper demonstrating worker messages/progress
    - `examples/janus-pro-webgpu/package.json` (full) — deps: `@huggingface/transformers`

- **SD-Turbo** (vanilla JS, ONNX Runtime Web):

  - _Key references:_

    - `examples/sd-turbo/index.js` (full) — ONNX Runtime Web sessions, Cache Storage caching, latents creation, decode pipeline
    - `examples/sd-turbo/webpack.config.js` (full) — distributing ORT WASM assets
    - `examples/sd-turbo/package.json` (full) — deps: `onnxruntime-web`

> Documentation drift note: `examples/janus-pro-webgpu/README.md` mentions a `janus-webgpu` folder name which differs from the actual `janus-pro-webgpu` directory; this is purely documentation and doesn’t impact code.

---

## 2) Requirements Translated to Design Decisions

### 2.1 Capability & Fallback Strategy

- **Detect capabilities** once at startup (or lazily on first usage):

  - `webgpu`: `navigator.gpu` presence.
  - `shader-f16`: via `adapter.features.has('shader-f16')` (performance optimization only).
  - `webnn`: optional; available on some platforms (`navigator.ml`).
  - `wasm`: assumed available; report `true` for clarity.

- **Backend selection policy per model:**

  - **Janus-Pro-1B**: `["webgpu"]` only (WASM fallback is impractical due to model size/perf).
  - **SD-Turbo**: `["webgpu", "webnn", "wasm"]` in that preference order.

- **Graceful failure**: if no backend is available for a model, return a structured error like `{ ok: false, reason: "backend_unavailable", model: "janus-pro-1b" }`.

### 2.2 Supported Models (v1)

- **Janus-Pro-1B (Transformers.js)**

  - Task: text-to-image (also supports text generation; we focus on image for v1).
  - Seed: **not supported initially** (no exposed deterministic seed in example; treat as unsupported).
  - Negative prompt: **not applicable**; ignore parameter if provided by the app.
  - Backend: **WebGPU required**; partial WASM usage may exist for sub-graphs but not a supported fallback.

- **SD-Turbo (ONNX Runtime Web)**

  - Task: text-to-image (single-step distilled diffusion).
  - Seed: **supported** via seedable PRNG for latents (replace `Math.random()` with deterministic RNG).
  - Negative prompt: **not in v1**; plan for CFG later.
  - Backend: WebGPU preferred; optional WebNN; **WASM fallback** supported.

### 2.3 Model Lifecycle

- **List supported models** (static registry with metadata).
- **Load model** (download and cache artifacts):

  - Janus: Transformers.js `from_pretrained(...)`.
  - SD-Turbo: ONNX Runtime Web sessions for `unet`, `text_encoder`, `vae_decoder`; cache ONNX files via Cache Storage API.

- **Unload model**: dispose sessions/models to free GPU/CPU memory.
- **Purge cache**: remove model-specific cached URLs (Cache Storage API; see §6).

### 2.4 Generation API (v1)

- **Unified call** with common fields:
  `prompt: string`, `seed?: number`, `width?: number`, `height?: number`, `signal?: AbortSignal`, `onProgress?: (event) => void`
- **Return type**: `{ ok: true, blob: Blob, timeMs: number }` (or `{ ok: false, reason: string }`).
- **Progress events** (standardized phases):

  - `loading` (optional; model ensures warmed up)
  - `tokenizing` (SD-Turbo)
  - `encoding` (SD-Turbo text encoder)
  - `denoising` (SD-Turbo UNet step)
  - `decoding` (SD-Turbo VAE decode) / `image_tokens` (Janus image token stream)
  - `complete` (final metrics)

### 2.5 Abort / Interrupt

- **Janus**: uses interruptible stopping criteria (already demonstrated in example).
- **SD-Turbo**: poll `signal.aborted` between phases to cancel promptly.

---

## 3) Architecture

### 3.1 High-Level Components

1. **Core Library**

   - Public API façade (capabilities, model registry, lifecycle, generation).
   - Backend selection and parameter validation.
   - Common progress/event/error shaping.

2. **Model Adapters** (one per model)

   - `JanusProAdapter` (Transformers.js)
   - `SDTurboAdapter` (ONNX Runtime Web)
   - Shared interface: `checkSupport()`, `load()`, `isLoaded()`, `generate()`, `unload()`, `purgeCache()`.

3. **Worker Host (optional but recommended)**

   - Runs adapters off the main thread.
   - Receives commands (load, generate, abort, unload).
   - Posts progress and result blobs back to the main thread.
   - Keeps GPU/CPU work and large allocations off UI thread.

4. **Cache Manager**

   - Tracks URLs fetched per model.
   - Uses Cache Storage API for add/match/delete.
   - Exposes purge operations with per-model granularity.

5. **Capability Detector**

   - Single place to assess `webgpu`, `shader-f16`, `webnn`, and `wasm`.

### 3.2 Data Flow

**Initialization**

1. App calls `detectCapabilities()` to get capability struct.
2. App calls `listSupportedModels()` to present options.
3. App calls `loadModel(modelId, { backendPreference, onProgress })`.

   - Core selects backend based on capabilities and model support.
   - Adapter downloads/initializes and caches assets.
   - Adapter returns `{ ok, backendUsed, bytesDownloaded? }`.

**Generation**

1. App calls `generateImage({ model, prompt, seed?, width?, height?, signal?, onProgress? })`.
2. Core validates params and forwards to the adapter (possibly within a worker).
3. Adapter emits progress events in a standardized shape.
4. Adapter returns `{ ok: true, blob, timeMs }` or `{ ok: false, reason }`.

**Abort**

- App invokes `AbortController.abort()`; worker/adapter terminates promptly and returns `{ ok: false, reason: "cancelled" }`.

**Unload & Purge**

- App calls `unloadModel(modelId)` to free sessions/models.
- App calls `purgeModelCache(modelId)` or `purgeAllCaches()` to delete cached artifacts.

---

## 4) Public API (Contract)

> Note: Below is a **specification** of method names, parameters, and structured returns. It is **not an implementation**.

### 4.1 Capability & Registry

**`detectCapabilities(): Promise<Capabilities>`**
Returns an object like:

- `webgpu: boolean`
- `shaderF16: boolean`
- `webnn: boolean`
- `wasm: true` (assumed available)

**`listBackends(): BackendId[]`**

- Values are a subset of: `"webgpu" | "webnn" | "wasm"`.

**`listSupportedModels(): ModelInfo[]`**
Each entry includes:

- `id: "janus-pro-1b" | "sd-turbo"` (initially)
- `displayName: string`
- `task: "text-to-image"`
- `supportedBackends: BackendId[]` (per model policy)
- Optional `notes` (seed support, size constraints, etc.)

**`getModelInfo(id: ModelId): ModelInfo`**
Retrieves a single entry from the registry.

### 4.2 Lifecycle

**`loadModel(id: ModelId, options?): Promise<LoadResult>`**
Options may include:

- `backendPreference?: BackendId[]` (ordering)
- `modelUrlOverrides?: { ... }` (expert: pin alternative hosting)
- `onProgress?: (p: LoadProgress) => void`

Return:

- `{ ok: true, backendUsed: BackendId, bytesDownloaded?: number }`
- or `{ ok: false, reason: ErrorCode }`

**`isModelLoaded(id: ModelId): boolean`**

**`unloadModel(id: ModelId): Promise<void>`**
Disposes sessions/models and releases GPU allocations.

**`purgeModelCache(id: ModelId): Promise<void>`**
Deletes cached assets for that model.

**`purgeAllCaches(): Promise<void>`**
Deletes all model caches.

### 4.3 Generation

**`generateImage(params): Promise<GenerateResult>`**

Parameters:

- `model: ModelId`
- `prompt: string`
- `seed?: number` _(supported for SD-Turbo; ignored/unsupported for Janus)_
- `width?: number` _(multiples of 64 for SD-Turbo; ignored for Janus unless adapter supports it)_
- `height?: number` _(same as above)_
- `signal?: AbortSignal`
- `onProgress?: (event: GenerationProgressEvent) => void`

Return:

- `{ ok: true, blob: Blob, timeMs: number }`
- or `{ ok: false, reason: ErrorCode }`

**Progress Events** (`GenerationProgressEvent`):

- Common fields: `phase: "loading" | "tokenizing" | "encoding" | "denoising" | "decoding" | "image_tokens" | "complete"`, optional `pct: number`
- Model-specific extensions:

  - **Janus**: `image_tokens` events may include `{ count, total, progress, time }`.
  - **SD-Turbo**: coarse `%` per phase based on elapsed time or known step boundaries.

### 4.4 Error Codes (Standardized)

- `"webgpu_unsupported"` — WebGPU required for selected model.
- `"backend_unavailable"` — No viable backend exists for the model.
- `"model_not_loaded"` — Must call `loadModel` first.
- `"unsupported_option"` — E.g., seed for Janus, unsupported sizes.
- `"cancelled"` — Aborted by caller.
- `"internal_error"` — Unhandled failure (include `message` for dev insight).

---

## 5) Model Adapters

### 5.1 JanusProAdapter (Transformers.js)

**Backend:** WebGPU required (with targeted WASM usage for sub-graphs as in the example).
**Loading:**

- Use `AutoProcessor.from_pretrained(modelId)` and `MultiModalityCausalLM.from_pretrained(modelId)`.
- Detect `shader-f16` support and set mixed-precision `dtype` maps accordingly as per the example.
- Device map aligns to WebGPU for the heavy nodes; WASM for small nodes if needed.
- Provide progress callbacks to forward to `onProgress`.

**Generation:**

- Use the _text-to-image_ chat template (`text_to_image`) with a single user-content turn.
- Stream progress based on image tokens (ProgressStreamer in the example), reporting `image_tokens` phase with `{count,total,progress}`.
- Final output: `Blob` (use `outputs[0].toBlob()` if returned image objects expose it).

**Capabilities:**

- **Seed**: Not supported via the example; mark unsupported.
- **Negative prompt**: Not applicable; ignore if present.
- **Size**: Not supported in the example. Treat sizes as fixed or model-defined. If unsupported, reject or ignore with clear documentation.

**Unload & Purge:**

- Release model references to allow GC.
- Purge caches by deleting URLs that match the model’s HF base path (see §6).

### 5.2 SDTurboAdapter (ONNX Runtime Web)

**Backends:** WebGPU → WebNN → WASM (fallback).
**Loading:**

- Download three models (`unet`, `text_encoder`, `vae_decoder`) from a configurable base URL (default HF repo).
- Use the **Cache Storage API** (`caches.open`) to store fetched ONNX assets.
- Create ORT InferenceSessions with `executionProviders` and `freeDimensionOverrides` as demonstrated.
- Record which URLs are cached for later purge.

**Generation (single-step Turbo):**

- Tokenize prompt with tokenizer (e.g., `clip-vit-base-patch16`).
- Text encoder → `last_hidden_state`.
- **Seeded latents**: create latents using a **seedable PRNG** (replace Box–Muller `Math.random()` with deterministic generator).
- Scale latents; run UNet once; minimal scheduler step; decode with VAE.
- Convert decoded tensor to `ImageData` → `Blob` (PNG).
- Report progress in phases: `tokenizing` → `encoding` → `denoising` → `decoding`.

**Parameters:**

- **Seed**: Supported — deterministic across runs for identical prompt/size/backend/impl version.
- **Width/Height**: Multiples of 64 (latent 64×64 corresponds to 512×512 output). If unspecified, default to 512×512. Validate and return `"unsupported_option"` if invalid.
- **Negative prompt**: Not supported in v1; reject or ignore consistently.

**Abort:**

- Between each phase, check `signal.aborted` and exit early with `"cancelled"`.

**Unload & Purge:**

- Dispose `last_hidden_state` GPU buffers when applicable.
- Clear cached URLs via Cache Storage.

---

## 6) Caching & Storage

**Why:** Avoid repeated downloads; enable offline usage after initial fetch.

**Mechanisms:**

- **Cache Storage API** for model artifacts (ONNX files, tokenizer files, weight shards).
- Per-model **URL tracking**:

  - Maintain a list of URLs fetched for each model instance during `loadModel`.
  - Expose `purgeModelCache(id)` to iterate and delete entries.

- **Transformers.js**: It uses standard `fetch` paths; we will **match by URL prefixes** corresponding to the HF model ID to purge entries. Keep this loosely coupled in case library internals change.

**Deletion strategy:**

- `purgeModelCache(id)`: delete only URLs associated with that model’s base.
- `purgeAllCaches()`: iterate known caches used by the library and delete them.
  _Note:_ Deleting entire Cache Storage is heavy-handed; prefer URL-level deletion when possible.

**Offline behavior:**

- When artifacts are present in Cache Storage, subsequent `loadModel` calls should rely on cache (as shown in the SD-Turbo example).
- Keep clear telemetry in `LoadResult` (e.g., `bytesDownloaded` = 0 if fully cached).

---

## 7) WASM Fallback (What It Is & When to Use It)

**Definition:** Running model inference using **WebAssembly** (CPU) when WebGPU/WebNN are unavailable.

**Where we use it:**

- **SD-Turbo**: Fully supported via `onnxruntime-web` WASM EP.
- **Janus-Pro-1B**: **Not a supported fallback** due to model size/performance. Treat Janus as WebGPU-only in v1.

**Performance considerations:**

- WASM is significantly slower than WebGPU.
- If the host page is **cross-origin isolated** (COOP/COEP headers), enabling **SIMD and threads** in ORT WASM improves throughput.
- If the page is not isolated, expect **single-thread** performance.

**Library policy:**

- Default `backendPreference`: SD-Turbo uses `["webgpu", "webnn", "wasm"]`.
- Allow apps to override (e.g., force WebGPU only to avoid slow fallbacks).
- If no allowed backend is available, fail gracefully with `"backend_unavailable"`.

---

## 8) Progress & Telemetry

**Progress semantics (model-agnostic):**

- Phases: `loading`, `tokenizing`, `encoding`, `denoising`, `decoding`, `image_tokens`, `complete`.
- Include an optional `pct` (0–100) if meaningful.
- For **Janus**, `image_tokens` reports `{count, total, progress, time}` from the streamer.
- For **SD-Turbo**, progress is **phase-based**; you can provide rough percentages (e.g., `tokenizing` \~10%, `encoding` \~25%, `denoising` \~70%, `decoding` \~95%) to improve UX consistency.

**Final metrics:**

- Include `timeMs` from start of generation to final blob.

**Abort semantics:**

- On abort, send a last progress event `{ phase: "complete", aborted: true }` and return `{ ok: false, reason: "cancelled" }`.

---

## 9) Determinism & Seeds

**SD-Turbo:**

- Implement a **seedable PRNG** for latent noise.
- Determinism holds if:

  - Same prompt, seed, width/height, and model version.
  - Same backend and platform (some numerical drift between backends may occur).

- Specify that **WASM (single vs multi-thread)** and **WebGPU drivers** may introduce small differences.

**Janus-Pro-1B:**

- No reliable seed support (per current example).
- Document seed as “unsupported for Janus” in v1; ignore if provided.

---

## 10) Performance & Memory

**General:**

- Offload heavy work to a **Web Worker** (esp. Transformers.js and ORT sessions).
- Dispose tensors/buffers promptly (ORT GPU buffers like `last_hidden_state`).
- For Janus, ensure you **release references** to processor/model on `unloadModel` to let GC collect GPU memory.

**SD-Turbo-specific:**

- Allow only widths/heights that are **multiples of 64**.
- Default to **512×512** for throughput/quality balance.
- Tune ORT session options based on backend:

  - WebGPU: `preferredOutputLocation` for GPU buffers when efficient.
  - WASM: enable `simd` and `numThreads` where possible.

**Janus-specific:**

- Maintain the device map and mixed precision settings based on `shader-f16` capability to optimize throughput.

---

## 11) Security & Privacy

- **No server-side compute**; all inference runs in-browser.
- Models are **downloaded from remote hosts** (e.g., Hugging Face). Disclose bandwidth and storage usage.
- If the host app wants best WASM performance:

  - Serve with **COOP/COEP** headers for cross-origin isolation (enables WASM threads).

- Respect **CSP**: document that the library uses Web Workers and `fetch` to model URLs; host app must allow them.

---

## 12) Packaging & Distribution

**Module format:** ESM.
**TypeScript:** provide type declarations for API consumers.

**Dependencies:**

- Do **not** bundle `onnxruntime-web` or `@huggingface/transformers` into the core by default. Treat them as **peer dependencies** or **lazy-loaded** optional deps to keep bundle size small.
- Provide **adapters** that import them dynamically only when needed.

**Workers:**

- Option A: ship a dedicated worker script as a separate file (simplest for consumers).
- Option B: allow the library to **instantiate an inline worker** via `Blob` URL (no extra file but larger main bundle).

**Examples:**

- Provide a minimal example app (e.g., in `/examples/`) demonstrating:

  - Capability detection display.
  - Model dropdown (Janus, SD-Turbo).
  - Load model with progress.
  - Prompt input (+ optional seed).
  - Generate + Abort.
  - Render image blob.
  - Purge cache buttons.

- This folder is for internal development and **may be removed** prior to release.

**Versioning & Compatibility:**

- Semantic versioning for the library and registry.
- Document tested versions of ORT and Transformers.js.

---

## 13) Example App (Demonstration Plan)

> We will include a tiny example app to showcase usage, **not** as a framework dependency.

**Features to demonstrate:**

- Detect and list capabilities.
- Select model; show supported backends for that model.
- Load model (with download + file-level progress).
- Prompt input; optional seed (enabled only for SD-Turbo).
- Generate image; show phase-based progress.
- Abort current generation.
- Unload model.
- Purge cache per model and global.

**Implementation notes:**

- Keep the UI minimal (vanilla or simple React).
- Use the library’s API only (no direct transformer/ORT calls) to keep it faithful.
- Provide logging panel for dev visibility.
- Cite in docs that `/examples` will be removed in production.

---

## 14) Testing Strategy

**Unit tests:**

- Capability detection logic under different `navigator` mocks.
- Backend selection algorithm given capability matrices.
- Parameter validation: size multiples, missing prompt, unsupported options.
- Error shaping: each `ErrorCode` path returns correct structure.

**Integration tests (per adapter):**

- SD-Turbo: end-to-end generation on WASM (CI-friendly) with a fixed seed; compare against stored **golden histogram** or checksum of downscaled image to allow small numeric drift.
- Janus (if feasible in CI): smoke test that loads and returns an image blob on WebGPU-enabled runners; otherwise manual testing.

**E2E (manual/bench):**

- Run on WebGPU-enabled Chrome/Edge, plus a WASM-only environment.
- Measure time to first image and generation latency.
- Memory leak checks with repeat load/unload/generate cycles.

**Abort tests:**

- Abort early and mid-phase; ensure clean cancellation paths.

**Cache tests:**

- Load once online; then switch to offline mode; confirm generation works using cache (for SD-Turbo).

---

## 15) Browser Support Guidance

- **WebGPU path:** “Modern browsers that implement WebGPU” (Chrome/Edge stable; others vary). Do not hardcode versions here; detect at runtime.
- **WASM fallback path:** Broad support across modern browsers; performance varies by SIMD/threading availability and COOP/COEP.
- **WebNN (optional):** Available on select platforms; treat as opportunistic.

Document that **capabilities are detected at runtime**, and the library selects the best available backend per model.

---

## 16) Roadmap (Post-v1)

- **SD-Turbo**: Add **negative prompt** and **CFG** (two-pass conditioning) with single-step guidance.
- **Janus**: Investigate **seed** control if/when Transformers.js exposes deterministic controls for T2I path.
- **Additional models**: SDXL-Turbo variants; lightweight T2I models with better WASM viability.
- **Multi-image generation** per call; batching ergonomics.
- **Streaming APIs** for tile-based or progressive outputs where models support it.
- **Persistent cache index** with size quotas and LRU eviction.
- **Telemetry hooks** (opt-in) for performance and error analytics.

---

## 17) Open Decisions (Confirmed as of now)

- ✅ **No negative prompts** in v1 (both models).
- ✅ **WASM fallback**: **Only** for SD-Turbo; Janus is WebGPU-only.
- ✅ Library-first design; **example app** exists only to **showcase usage** and will be removed before release if desired.
- ✅ Keep adapters decoupled; use peer/lazy dependencies for ORT and Transformers.js.

---

## 18) Risks & Mitigations

- **Large model downloads** (time/bandwidth):

  - Mitigation: file-level progress reporting; clear messaging; caching; optional prefetch.

- **Memory pressure or leaks (GPU/CPU)**:

  - Mitigation: strict `unloadModel`, disposal of tensors, and GC-friendly patterns.

- **Backend divergence (numeric drift)**:

  - Mitigation: seed determinism documented as _best-effort_; tests use relaxed comparisons.

- **Cache eviction by the browser**:

  - Mitigation: treat cache as opportunistic; handle re-download gracefully; expose `bytesDownloaded` so apps can log or warn.

---

## 19) Developer Checklist (Implementation Order)

1. **Core scaffolding** (capabilities, registry, error model).
2. **SD-Turbo adapter**:

   - Load (cache), generate (seedable), progress, abort, unload, purge cache.
   - Backends: WebGPU, WebNN, WASM.

3. **Janus adapter**:

   - Load (Transformers.js), generate (image tokens progress), abort, unload, purge cache.
   - Backend: WebGPU only.

4. **Worker host** (message protocol; command routing; progress proxy; abort).
5. **Example app** (simple UI + full flow).
6. **Docs & tests** (unit, integration, manual benches).

---

## 20) Glossary

- **WebGPU**: Modern web standard for GPU access in browsers.
- **WASM**: WebAssembly – portable binary format for high-performance apps in browsers (CPU-bound).
- **ONNX Runtime Web (ORT)**: JS runtime for ONNX models, with WebGPU/WebNN/WASM backends.
- **Transformers.js**: JavaScript inference library for Transformers models (Hugging Face).
- **CFG (Classifier-Free Guidance)**: Technique to incorporate negative prompts/guidance in diffusion models.
- **COOP/COEP**: HTTP headers enabling cross-origin isolation, required for WASM threads.

---

## 21) Source Evidence & Proven Patterns (No code, just references)

- **WebGPU + shader-f16 capability detection** — demonstrated in `examples/janus-pro-webgpu/src/worker.js`.
- **Janus image generation** with token-based streaming and interruptibility — `examples/janus-pro-webgpu/src/worker.js`.
- **ONNX Runtime Web model caching** via Cache Storage API — `examples/sd-turbo/index.js`.
- **SD-Turbo pipeline** — tokenizer → text encoder → UNet (1 step) → VAE decode → canvas render — `examples/sd-turbo/index.js`.

---

## 22) Integration Notes for App Developers

- Detect capabilities and choose a model that your users’ devices can support.
- Prefer **WebGPU** for performance. Enable **WASM** fallback for broader compatibility (SD-Turbo only).
- Consider **COOP/COEP** headers to unlock **WASM threads** (if you want the best non-GPU performance).
- Provide UX for:

  - Model selection and loading (with progress).
  - Prompt (and **seed** for SD-Turbo).
  - Generate, view image, abort.
  - Cache purge and model unload (useful on constrained devices).
