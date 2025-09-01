# Goal

* Remove all **Web Worker** usage.
* Keep the **same high-level API** and UX semantics:

  * `detect()`, `listModels()`, `load()`, `unload()`, `purge()`, `purgeAll()`, `generate(...)`.
  * **Single-flight** execution with a **single-slot queue**.
  * Busy policies: `'reject' | 'abort_and_queue' | 'queue'`.
  * Debounce support.
  * `AbortController`-based cancellation.
  * Normalized `progress` events.
* Make production builds boring and deterministic (no worker bundling quirks).

---

# High-level design (Inline Runtime)

We’ll replace the worker “host + protocol + client” with an **inline runtime** that runs on the main thread but enforces the same scheduling semantics.

## Core pieces

1. **Inline scheduler** (single file, e.g., `src/runtime/inline_host.ts`):

   * Maintains:

     * `currentJob: { id, controller, params } | null`
     * `pendingJob: { id, params, debounceUntil? } | null`
     * `aborting: boolean`
   * Implements:

     * `runJob()`, `maybeStartNext()`, `supersedePending()`, `startPending()`
     * Timeouts for abort (as hints), debounce timers.
   * Calls the existing **direct API** (`generateImage`) with `signal` and `onProgress`.
   * **Emits progress/results via callbacks directly** (not `postMessage`).

2. **Inline client** (e.g., `src/runtime/inline_client.ts`):

   * Public surface mirrors `Txt2ImgWorkerClient`.
   * Methods:

     * `detect()`, `listModels()`, `listBackends()`
     * `load(model, options?, onProgress?)`
     * `unload(model?)`, `purge(model?)`, `purgeAll()`
     * `generate(params, onProgress?, opts?) → { id, promise, abort }`
   * Internally calls the inline scheduler instead of posting to a worker.

3. **Adapters remain unchanged for inference** (but see vendor loading below).

4. **Compatibility:** Provide either

   * a new **`Txt2ImgClient`** class (recommended), and **deprecate** `Txt2ImgWorkerClient`, *or*
   * keep the name `Txt2ImgWorkerClient` but implement it **inline** (no worker). I recommend adding a new name and soft-deprecating the old to avoid confusion.

---

# API mapping (preserve signatures)

Mirror the worker client as-is so app code barely changes:

* `detect(): Promise<{ webgpu; shaderF16; wasm }>`
* `listModels(): Promise<ModelInfo[]>`
* `listBackends(): Promise<BackendId[]>`
* `load(model, options?, onProgress?) → LoadResult`
* `unload(model?) → void`
* `purge(model?) → void`
* `purgeAll() → void`
* `generate(params, onProgress?, { busyPolicy, replaceQueued, debounceMs }?) → { id, promise, abort }`

**Abort behavior**: keep `AbortController` internally. Adapters already check `signal` between phases; Janus uses a streamer that throws `JANUS_STOP`.

**Progress events**: keep the normalized fields you already emit (`pct`, `bytesDownloaded`, `totalBytesExpected`, `message`, `phase`).

**Busy policies**: port the exact logic from `worker/host.ts`.

---

# Vendor loading strategy (without workers)

Removing workers **does not** automatically fix the vendor flakiness if you keep exotic dynamic imports. Do this:

* **Simplify to static dynamic imports with literal specifiers only.**

  * In `sd-turbo.ts`, keep:

    ```ts
    const mod = await import('@xenova/transformers'); // literal string
    ```

    Remove the `/* @vite-ignore */` + variable-specifier fallback.
    If you want an HF fallback, add a **second literal** import attempt:

    ```ts
    await import('@huggingface/transformers');
    ```
  * In `janus-pro.ts`, same idea: first try

    ```ts
    await import('@huggingface/transformers');
    ```

    **Remove** `import.meta.resolve` and any `/* @vite-ignore */` paths.
* This allows the bundler to statically see both packages and produce proper chunks.
* Keep the **global fallback** as a last resort (script tag), but don’t depend on it.

> If you want maximum determinism, you can still adopt the **“app must import vendors”** stance, but without workers it’s usually enough to keep literal dynamic imports.

---

# Concrete implementation steps

## 1) Add the inline runtime

Create `packages/web-txt2img/src/runtime/inline_host.ts`:

* Copy the **scheduling logic** from `worker/host.ts`:

  * `currentJob`, `pendingJob`, timers, abort timeout constant.
  * Methods: `maybeStartNext`, `startPending`, `supersedePending`, `runJob`.
* Replace calls to `postMessage` with **in-memory callbacks**:

  * Accept an `onProgress` function and resolve a promise when done.
* Call the existing direct API `generateImage({ ...params, signal, onProgress })`.

Create `packages/web-txt2img/src/runtime/inline_client.ts`:

* Port `Txt2ImgWorkerClient` into **`Txt2ImgClient`**:

  * **No worker construction**.
  * Maintain a `pending map` only if you want to match the worker RPC flavor. Simpler: directly return `{ id, promise, abort }`.
* Implement methods by delegating to:

  * `detectCapabilities()`
  * `listSupportedModels()`
  * `listBackends()`
  * `loadModel()`, `unloadModel()`, `purgeModelCache()`, `purgeAllCaches()`
  * Scheduler’s `enqueueGenerate()` (your inline host).

Update `packages/web-txt2img/src/index.ts`:

* Export `Txt2ImgClient` (new default client).
* Keep exporting the **direct API** functions (unchanged).
* Optionally **re-export** a shim `Txt2ImgWorkerClient` that internally instantiates `Txt2ImgClient` and logs a deprecation warning.

## 2) Remove worker paths from example

In `examples/vanilla-worker/main.js`:

* **Delete**:

  ```js
  import WorkerUrl from '../../packages/web-txt2img/src/worker/host.ts?worker&url';
  const worker = new Worker(WorkerUrl, { type: 'module' });
  client = new Txt2ImgWorkerClient(worker);
  ```
* **Replace** with:

  ```js
  import { Txt2ImgClient } from 'web-txt2img';
  client = new Txt2ImgClient();
  ```
* The rest of the example can remain identical: it already calls `client.detect()`, `client.load()`, `client.generate()`, etc.

## 3) Simplify adapter vendor loading

### `packages/web-txt2img/src/adapters/sd-turbo.ts`

* In `getTokenizer()`:

  * Keep the **global** fast path (OK).
  * Keep a **literal** dynamic import of `@xenova/transformers`:

    ```ts
    const mod = await import('@xenova/transformers');
    const { AutoTokenizer } = mod as any;
    ```
  * Optionally add a **second** literal attempt for HF:

    ```ts
    const mod2 = await import('@huggingface/transformers');
    const { AutoTokenizer } = mod2 as any;
    ```
  * **Remove** the `/* @vite-ignore */` and `import(/* @vite-ignore */ spec)` fallback.
* Rationale: literal specifiers = bundler can see and include chunks. Vite/Rollup will rewrite `import('@xenova/transformers')` to a URL that exists in prod.

### `packages/web-txt2img/src/adapters/janus-pro.ts`

* In `load()`:

  * First try `await import('@huggingface/transformers')`.
  * If that fails, look for `globalThis.transformers`.
  * **Remove** `import.meta.resolve` and the `/* @vite-ignore */` dynamic import based on a resolved URL string.

This change alone eliminates the “sometimes it bundles, sometimes it doesn’t” behavior.

## 4) Keep abort & progress exactly as today

* **Abort**: you already thread an `AbortSignal` down to adapters; both adapters check `signal` between phases (SD-Turbo) or via the Janus streamer. Good.
* **Progress**: keep your normalized events. The inline host should pass through `pct`, `bytesDownloaded`, `totalBytesExpected`, etc.

## 5) Docs & deprecation

* Update `docs/DEVELOPER_GUIDE.md`:

  * Replace the “Worker Architecture” with “Inline Runtime” and keep the same **policies** (single-flight, queue, abort, debounce).
  * Note that all methods are main-thread now.
* In `README`:

  * Replace `Txt2ImgWorkerClient.createDefault()` examples with `new Txt2ImgClient()` usage.
* Mark `Txt2ImgWorkerClient` **deprecated** in the API with a clear message (and possibly keep it as a tiny inline wrapper for one release).

---

# Trade-offs

* **Main thread execution**: heavy tokenization (JS) and some orchestrations can block the UI for short bursts.

  * Mitigations:

    * Keep WebGPU backends (they are async).
    * Emit progress early (`tokenizing`) so UIs can show spinners.
    * Optionally sprinkle `await Promise.resolve()` between expensive phases to yield the event loop.
* **Determinism**: production builds get simpler — no worker chunk graphs; vendor imports are visible to the bundler.

---

# Validation checklist

1. **Build determinism**

   * `vite build` runs without worker chunk warnings.
   * No `@vite-ignore`-style dynamic imports remain in adapters.

2. **Local preview**

   * `vite preview` and open the example.
   * `detect()` shows `webgpu` true on a compatible browser.
   * `load('sd-turbo', { backendPreference: ['webgpu'] }, onProgress)` completes and shows download progress.
   * `generate(...)` returns an image blob and logs phases.

3. **Abort**

   * Start a generation, click abort; ensure `reason: 'cancelled'` and UI updates.

4. **Busy policies**

   * Trigger rapid successive `generate()` calls while one is running:

     * With `'queue'`: last input runs after current completes.
     * With `'abort_and_queue'`: current aborts quickly, last queued runs.
     * With `'reject'`: new call returns `{ ok:false, reason:'busy' }`.

5. **Janus**

   * Install `@huggingface/transformers` in the example.
   * `load('janus-pro-1b', { backendPreference:['webgpu'] })`.
   * `generate({ prompt })` works; abort is best-effort mid-run.

---

# What to delete (or keep temporarily)

* **Delete** (or mark internal and unused):

  * `packages/web-txt2img/src/worker/host.ts`
  * `packages/web-txt2img/src/worker/host.js`
  * `packages/web-txt2img/src/worker/client.ts`
  * `packages/web-txt2img/src/worker/protocol.ts`

* **Keep** for one release as deprecated (optional):

  * An empty shell `Txt2ImgWorkerClient` that internally uses `Txt2ImgClient` and logs a deprecation warning. This minimizes breaking changes for downstream users.

---

# Suggested project task breakdown

1. **Runtime**

   * Implement `inline_host.ts` scheduler (port from worker host).
   * Implement `inline_client.ts` (public class `Txt2ImgClient`).

2. **Adapters**

   * Remove `@vite-ignore`/`import.meta.resolve` paths.
   * Keep only literal dynamic imports + global fallback.
   * Sanity test both SD-Turbo and Janus.

3. **Entrypoint**

   * Export `Txt2ImgClient` from `src/index.ts`.
   * Add deprecation wrapper for `Txt2ImgWorkerClient` (optional).

4. **Example**

   * Switch to `new Txt2ImgClient()`.
   * Remove worker URL import.
   * Verify dev/prod build & preview.

5. **Docs**

   * Update `README`, `DEVELOPER_GUIDE.md`.
   * Add a short “Why inline runtime?” rationale.