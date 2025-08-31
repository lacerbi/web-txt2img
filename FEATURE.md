# Improved Model and Progress Information

Here’s a precise plan to add both features cleanly (no code yet, just the “how” and “where”).

---

# Files you’ll need to touch

**Core/types & registry**

* `packages/web-txt2img/src/types.ts` — extend `ModelInfo` and `LoadProgress`.
* `packages/web-txt2img/src/registry.ts` — hardcode model sizes into the registry entries.
* `packages/web-txt2img/src/index.ts` — ensure new fields flow through public API exports.

**Adapters (progress producers)**

* `packages/web-txt2img/src/adapters/sd-turbo.ts` — already reports coarse progress; augment to include total bytes.
* `packages/web-txt2img/src/adapters/janus-pro.ts` — add proper download byte aggregation via the `progress_callback` hooks, with a hardcoded expected total.

**Worker (progress passthrough)**

* `packages/web-txt2img/src/worker/protocol.ts` — update the type hints for `listModels()` and progress payload (optional).
* `packages/web-txt2img/src/worker/host.ts` — no logic changes required; make sure it forwards the new progress fields.
* `packages/web-txt2img/src/worker/client.ts` — update TypeScript typings for `listModels()` return shape (optional; runtime already passes through).

**Cache/progress helpers (optional convenience)**

* `packages/web-txt2img/src/cache.ts` — keep as-is for SD-Turbo; optionally add a small aggregator util for adapters that don’t own the fetch loop (e.g., Janus).

**Docs & sample UI**

* `docs/DEVELOPER_GUIDE.md`, `README.md` — document the new fields.
* `examples/vanilla-worker/main.js` — already shows `bytesDownloaded`; add optional `totalBytesExpected` in the UI string.

All of the above files are fully available in the provided contents.

---

# 1) Model size in `ModelInfo` (hardcoded)

## What to add

Add an **approximate size** field to `ModelInfo`. Recommend a byte-level field plus a convenience GB field, both optional to keep this a non-breaking change:

* `sizeBytesApprox?: number`
* `sizeGBApprox?: number` (derived from bytes and rounded for display)
* *Optional*: `sizeNotes?: string` (e.g., “varies with dtype; mixed-precision”)

Where:

* **`types.ts`** — extend `ModelInfo`.
* **`registry.ts`** — fill the new fields for each model.

## How to determine sizes now

* **SD-Turbo**: Your adapter already lists rough per-asset sizes:

  * UNet \~640 MB
  * text\_encoder \~1700 MB
  * vae\_decoder \~95 MB
    Total ≈ **2435 MB** → **\~2.44 GB**. Hardcode that.
* **Janus-Pro-1B (ONNX)**: Transformers.js pulls multiple ONNX components (LM, heads, decode). Exact number varies with dtype/quantization, but for an in-browser ONNX 1B stack with mixed precision the footprint is roughly in the **\~1.8–2.4 GB** band today. Since you asked to hardcode a number, pick a **single conservative figure** and annotate with a note, e.g. **\~2.1 GB**, `sizeNotes: 'Mixed-precision ONNX; varies slightly by device/dtype'`.

> Why both bytes and GB?
>
> * `sizeBytesApprox` is easier to sum/compare and to show precise numbers if you later add a programmatic calculator.
> * `sizeGBApprox` makes UI trivial for apps that just want to display one number.

---

# 2) Standardized download % completion

You already expose `LoadProgress` events from `loadModel` with `pct` and `bytesDownloaded` in places, but **not consistently across adapters**. The goal is to make **every adapter** conform to the same payload so the base API and the worker can surface a consistent progress bar.

## The contract (base API)

**Extend `LoadProgress`** (in `types.ts`) to normalize download progress:

* `phase: 'loading'` (unchanged)
* `message?: string` (unchanged)
* `bytesDownloaded?: number` — **cumulative** bytes across all assets for the model (keep this).
* `totalBytesExpected?: number` — **hardcoded** expected total for the model (add this).
* `pct?: number` — computed as `(bytesDownloaded / totalBytesExpected) * 100`, rounded to an integer (keep/expose).
* *Optional*: `asset?: string` (current asset name/path) for more granular UIs.
* *Optional*: `accuracy?: 'exact' | 'approximate'` — lets adapters mark whether `pct` is precise (e.g., SD-Turbo using `fetchArrayBufferWithCacheProgress`) or inferred (e.g., Janus if HF callback is coarse).

This keeps backward compatibility (all fields optional) while standardizing a **minimum** contract: when downloading, emit `bytesDownloaded` **and** `totalBytesExpected`.

### Where this shows up

* **Base API**: `loadModel(id, { onProgress })`
* **Worker API**: `client.load(model, options, onProgress)` → Worker forwards progress events intact; host can continue normalizing `pct`.

## Adapter changes

### SD-Turbo (`adapters/sd-turbo.ts`)

* You already compute `totalExpected` (sum of the 3 asset sizes) and call `onProgress` with `pct` and `bytesDownloaded`.
* **Add** `totalBytesExpected: totalExpected` on each load progress event.
* **Keep** the existing per-asset `message` (e.g., “downloading vae\_decoder/model.onnx…”).
* This yields **exact** progress since you own the fetch and can see byte counts.

### Janus-Pro-1B (`adapters/janus-pro.ts`)

* Today you forward the HF `progress_callback` status messages, but not bytes or pct.
* **Add** a small aggregator inside the adapter:

  * Define `const totalBytesExpected = /* hardcoded bytes for Janus ONNX bundle */`.
  * Maintain a `bytesDownloaded` counter.
  * In the `progress_callback` hook for **both** `AutoProcessor.from_pretrained` and `MultiModalityCausalLM.from_pretrained`, attempt to parse byte info if available; if not, estimate based on milestones reported by Transformers.js. In either case, **emit**:

    * `bytesDownloaded`
    * `totalBytesExpected`
    * `pct: Math.min(100, Math.round((bytesDownloaded / totalBytesExpected) * 100))`
    * `accuracy: 'exact' | 'approximate'` depending on what the callback provides.
  * When each component finishes, **snap** `bytesDownloaded` to the known component size if you have a per-component table; otherwise cap at `totalBytesExpected` before switching to “Loading model…” messages.
* **Edge case**: if everything is cached, emit one event with `bytesDownloaded: totalBytesExpected` and `pct: 100` so UIs instantly show “ready”.

> Why not intercept `fetch` globally?
> Keeping it **local to the adapter** avoids surprising the host app and keeps the logic testable without monkey-patching.

## Worker API

* **`worker/host.ts`**: already forwards `event` along with a normalized `pct`. Because your new fields are additive, **no logic change** is needed; the new `totalBytesExpected` simply flows through.
* **`worker/protocol.ts`**: optionally update the `LoadProgress` shape referenced by `WorkerProgress` if you want stricter TS typing for the worker RPC types (not required at runtime).
* **`worker/client.ts`**: types for `listModels` can be updated to include the size fields (optional; again, runtime is fine).

## UI (example) tweak (optional)

* `examples/vanilla-worker/main.js` already shows `bytesDownloaded`.
* Consider showing: `NN.N / MM.MB (XX%)` if `totalBytesExpected` is present.

---

# Putting it all together: workflow & semantics

1. **Registry supplies size**
   `listSupportedModels()` and `getModelInfo()` now return size fields. Apps can **display size before download**.

2. **Adapter emits standardized download progress**
   During `loadModel()`, adapters emit `{ bytesDownloaded, totalBytesExpected, pct }`.

   * SD-Turbo: precise byte counts (exact).
   * Janus-Pro-1B: aggregated estimates upgraded to exact where possible via HF callbacks; otherwise marked approximate.

3. **Worker passes through**
   The existing worker plumbing sends progress events to the UI. No breaking changes.

4. **Cache-aware behavior**
   If an asset is served from Cache Storage, the adapter should emit immediate progress to 100% (you already do this for SD-Turbo via `fetchArrayBufferWithCacheProgress`). Janus should do the same based on HF callback behavior: if the file is cached, HF usually calls back quickly; your aggregator can still send a final 100% event.

---

# Concrete places to update (quotes from current code)

**`types.ts`** — Current `ModelInfo` and `LoadProgress`:

```ts
export interface ModelInfo {
  id: ModelId;
  displayName: string;
  task: 'text-to-image';
  supportedBackends: BackendId[];
  notes?: string;
}

export interface LoadProgress {
  phase: 'loading';
  message?: string;
  pct?: number;
  bytesDownloaded?: number;
}
```

→ Extend with `sizeBytesApprox?`, `sizeGBApprox?`, `sizeNotes?`, and `totalBytesExpected?` in `LoadProgress`.

---

**`registry.ts`** — Current entries:

```ts
const REGISTRY: RegistryEntry[] = [
  {
    id: 'sd-turbo',
    displayName: 'SD-Turbo (ONNX Runtime Web)',
    task: 'text-to-image',
    supportedBackends: ['webgpu', 'webnn', 'wasm'],
    notes: '512×512 only in v1; seed supported.',
    createAdapter: () => new SDTurboAdapter(),
  },
  {
    id: 'janus-pro-1b',
    displayName: 'Janus-Pro-1B (Transformers.js)',
    task: 'text-to-image',
    supportedBackends: ['webgpu'],
    notes: 'WebGPU only in v1; seed unsupported.',
    createAdapter: () => new JanusProAdapter(),
  },
];
```

→ Add `sizeBytesApprox` & `sizeGBApprox` for both entries (e.g., SD-Turbo ≈ 2.44 GB; Janus ≈ 2.1 GB) and optionally `sizeNotes`.

---

**`adapters/sd-turbo.ts`** — You already compute total and emit progress:

```ts
const totalExpected = Object.values(models).reduce((acc, m) => acc + m.sizeMB * 1024 * 1024, 0);
options.onProgress?.({ phase: 'loading', message: `starting downloads (~${Math.round(totalExpected/1024/1024)}MB total)...`, bytesDownloaded: 0, pct: 0 });
...
const buf = await fetchArrayBufferWithCacheProgress(`${base}/${model.url}`, this.id, (loaded, total) => {
  const pct = total ? Math.round(((bytesDownloaded + loaded) / totalExpected) * 100) : undefined;
  options.onProgress?.({ phase: 'loading', message: `downloading ${model.url}...`, pct, bytesDownloaded: bytesDownloaded + loaded });
}, expectedTotal);
```

→ Include `totalBytesExpected: totalExpected` in every `onProgress` call above.

---

**`adapters/janus-pro.ts`** — You currently do:

```ts
options.onProgress?.({ phase: 'loading', message: 'Loading Janus-Pro-1B processor…' });

const progress_callback = (x: any) => {
  options.onProgress?.({ phase: 'loading', message: x?.status ?? 'loading…' });
};
...
const processorP = hf.AutoProcessor.from_pretrained(model_id, { progress_callback });
...
options.onProgress?.({ phase: 'loading', message: 'Loading Janus-Pro-1B model…' });
const modelP = hf.MultiModalityCausalLM.from_pretrained(model_id, { dtype, device, progress_callback });
```

→ Replace `progress_callback` with one that **accumulates bytes** (if available), or **estimates** by milestones, and emit `{ bytesDownloaded, totalBytesExpected, pct, accuracy }`. Keep the human-friendly `message`.

---

# Notes on compatibility

* All new fields are **optional**, so external apps won’t break.
* The worker’s `pct` normalization already exists; we’re just ensuring `bytesDownloaded` and `totalBytesExpected` are present across adapters.
* This approach doesn’t require any breaking changes to the worker protocol.

---

# Optional niceties (future-proofing)

* Add a `getModelInfo(id)` field `assets?: Array<{ name: string; bytesApprox: number }>` so UIs can show a breakdown and adapters can snap to exact numbers when a component finishes.
* If you want to avoid hardcoding Janus size forever, you could:

  * Measure on first successful load (sum of `content-length`/HF callback data),
  * Store under a stable key (Cache Storage metadata or `indexedDB`),
  * Still keep the hardcoded default as a fallback for `totalBytesExpected`.