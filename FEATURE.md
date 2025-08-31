# Worker Host + “Single-Flight with Single-Slot Queue” — Implementation Guide

**Audience:** Junior–mid frontend devs implementing the worker host for `web-txt2img`
**Goal:** Keep heavy image generation off the main thread, handle multiple incoming requests gracefully, and give a predictable UX via a “single-flight” rule with a one-item queue.

---

## 1) Why a Worker Host?

Image generation is heavy (GPU, WASM, large allocations). Running it on the UI thread can:

* jank the UI (drop frames)
* freeze inputs and progress bars
* complicate cancellation

A **Web Worker** solves this by moving the work off the main thread. The worker talks to your app via messages. We’ll also give the worker a **single-flight** guarantee: only one generation runs at once, and at most **one** new generation is queued behind it. This provides a clean, “latest wins” or “finish then next” behavior without an unbounded backlog.

---

## 2) Core Ideas (TL;DR)

* **Single-Flight:** only **one** generation can be running at a time.
* **Single-Slot Queue:** when a new request arrives while busy, we keep at most **one** pending request (the latest one).
* **Busy Policy:** caller chooses what should happen if a request arrives while busy:

  1. `'reject'` – the new request is immediately rejected
  2. `'abort_and_queue'` – current generation is aborted; the new one replaces any pending job
  3. `'queue'` (default) – finish current; then run the latest queued request
* **Abort Timeout (robust):** if an abort doesn’t take effect quickly (e.g., model only checks at phase boundaries), we fall back to “queue after completion”.
* **Debounce (robust):** optional small delay to coalesce rapid inputs (e.g., typing or slider changes) into a single queued job.
* **Progress + Results:** progress events streamed to the UI; results or errors are sent with reasons (`'busy'`, `'superseded'`, `'cancelled'`, `'internal_error'`).

---

## 3) High-Level Architecture

Main Thread (UI) ↔ **Worker Host** ↔ Library Adapters (SD-Turbo / Janus)

* The **UI** posts commands to the worker (load model, generate image, abort).
* The **Worker** calls the library (`generateImage`, `loadModel`, etc.), streams **progress**, and enforces **single-flight**.
* The **Adapters** (already implemented) do the compute (WebGPU/WebNN/WASM).

---

## 4) Concepts & Definitions

* **Job:** one request to generate an image for a prompt (plus options).
* **Current Job:** the job actively running.
* **Pending Job:** the latest queued job waiting for the current one to finish (or abort).
* **Busy Policy:**

  * `'reject'` – don’t accept new requests while busy.
  * `'abort_and_queue'` – cancel current job, then run the latest requested job.
  * `'queue'` – accept a pending job to run once the current job completes.

---

## 5) Message Protocol

The worker uses plain messages (postMessage). Each request has an `id` so you can correlate responses.

### 5.1 Requests → Worker

* **Lifecycle**

  * `{ id, kind: 'detect' }`
  * `{ id, kind: 'listModels' }`
  * `{ id, kind: 'listBackends' }`
  * `{ id, kind: 'load', model, options }`
  * `{ id, kind: 'unload', model }`
  * `{ id, kind: 'purge', model }`
  * `{ id, kind: 'purgeAll' }`
* **Generate**

  ```ts
  {
    id,
    kind: 'generate',
    params: { model, prompt, seed?, width?, height? }, // same as library GenerateParams minus onProgress
    busyPolicy?: 'reject' | 'abort_and_queue' | 'queue', // default 'queue'
    replaceQueued?: boolean,  // default true
    debounceMs?: number       // default 0 (optional)
  }
  ```
* **Abort current**

  * `{ id, kind: 'abort' }`  // aborts the *currently running* job

> Note: `id` is unique per call. It is *not* the model id.

### 5.2 Responses ← Worker

* **Accepted (queued or immediate start)**

  * `{ id, type: 'accepted' }` (optional ack to inform the caller it will run)
* **Progress**

  * `{ id, type: 'progress', event }` (library’s progress event)
* **Result (success)**

  * `{ id, type: 'result', ok: true, blob, timeMs }`
* **Result (failure)**

  * `{ id, type: 'result', ok: false, reason, message? }`
  * `reason` is one of: `'busy' | 'superseded' | 'cancelled' | 'internal_error'`
* **State (optional telemetry)**

  * `{ type: 'state', value: 'idle' | 'running' | 'aborting' | 'queued' }`

Special cases you should emit:

* **Superseded queued job**: when a new queued request replaces an older queued one:

  * `oldQueuedId` gets: `{ id: oldQueuedId, type: 'result', ok: false, reason: 'superseded' }`

---

## 6) Worker Internal State

At most one lane is needed for most apps:

```ts
let currentJob: null | {
  id: string;
  controller: AbortController;
  params: any;           // GenerateParams minus onProgress
} = null;

let pendingJob: null | {
  id: string;
  params: any;
  debounceUntil?: number;
} = null;

let aborting = false;            // true after we call controller.abort()
const ABORT_TIMEOUT_MS = 8000;   // configurable safety timeout
let abortTimer: number | null = null;
```

> Why `AbortController`? The adapters respect `signal` and check it either continuously (Janus streamer) or at phase boundaries (SD-Turbo). That makes cancellation graceful.

---

## 7) State Machine (Single-Flight + Single Queue)

**States:** `idle`, `running`, `aborting`, `queued`

**Transitions (simplified):**

* `idle` + generate → `running`
* `running` + generate(`'reject'`) → reject new request
* `running` + generate(`'queue'`) → put/replace `pendingJob` → `queued`
* `running` + generate(`'abort_and_queue'`) → set `pendingJob`, call `abort()`, go to `aborting`
* `aborting` → when current job actually ends → start `pendingJob` if any → `running` else `idle`
* `running` → when current finishes → start `pendingJob` if any → `running` else `idle`

**Replacement rule (single-slot queue):**

* If there’s already a `pendingJob` and `replaceQueued: true` (default), immediately send `{ ok:false, reason:'superseded' }` to the old queued `id`, then store the new one.
* If `replaceQueued: false`, keep the existing pending job and reject newcomers with `{ ok:false, reason: 'busy' }`.

---

## 8) Handling Busy Policies

When a `generate` arrives and **currentJob exists**:

1. **`'reject'`**

   * Respond `{ ok:false, reason: 'busy' }`.
   * Do not modify `currentJob` or `pendingJob`.

2. **`'abort_and_queue'`**

   * If `pendingJob` exists and `replaceQueued` is true, supersede it with the new one.
   * Set `aborting = true`. Call `currentJob.controller.abort()`.
   * Start an **abort timeout** (`ABORT_TIMEOUT_MS`):

     * If the current job doesn’t finish in time (e.g., mid-phase of SD-Turbo), **fallback** to “queue after completion”. Emit an optional progress hint so the UI can explain the delay.
   * When the current job ends, start the `pendingJob` if present.

3. **`'queue'` (default)**

   * If `pendingJob` exists:

     * If `replaceQueued`, supersede it with the new one.
     * Else reject `{ ok:false, reason: 'busy' }`.
   * If no `pendingJob`, set it and (optionally) reply with `accepted`.

---

## 9) Debounce (Optional but Recommended)

When user input updates rapidly (typing, slider), you don’t want to restart the queued job on each keystroke. Add `debounceMs` (e.g., 150–300ms):

* When a new job becomes `pendingJob`, set `pendingJob.debounceUntil = now + debounceMs`.
* **Don’t start** the pending job until after `debounceUntil`.
* If a newer request arrives before the debounce time, it **replaces** the pending job (if `replaceQueued` is true) and restarts the timer.

This coalesces bursts into a single generation.

---

## 10) Abort Semantics (Robust)

* **SD-Turbo:** Abort takes effect at phase boundaries (`tokenizing`, `encoding`, `denoising`, `decoding`). Expect short delays.
* **Janus:** Best-effort mid-run abort via token streamer. Might not be instant; could finish the token loop first.

**Best Practice:**
Start an **abort timer** when you call `abort()`. If it expires and the job is still running:

* Emit a progress hint: `{ phase: 'aborting_timeout' }` (or a simple message string).
* Treat it as if policy were `'queue'` (let the current job complete; then run the pending one).

This keeps UX predictable.

---

## 11) Progress Normalization

Adapters emit different progress shapes. Normalize a simple `%` when possible:

* If `event.pct` exists use it.
* Else, if `event.progress` ∈ \[0..1], use `Math.round(progress * 100)`.

Always forward the **raw** event fields too, so advanced UIs can display richer data (e.g., Janus image token counts).

---

## 12) Special Responses

* **`accepted`**: Optional ack so callers know their job will run (now or later).
* **`superseded`**: emit to the *old* queued job when it’s replaced.
* **`busy`**: for `'reject'` policy or when `replaceQueued:false` and a queued job already exists.
* **`cancelled`**: when a job is aborted (either by `abort` message or `'abort_and_queue'` policy) and the adapters report cancellation.

---

## 13) Integrating with the Existing Library

Inside the worker, you’ll call these **already-implemented** APIs:

* `detectCapabilities()`, `listSupportedModels()`, `listBackends()`
* `loadModel(model, options)` – **Important:** WASM assets path (`wasmPaths`) must be **absolute** (`'/ort/'`), or correctly resolvable from the worker’s URL.
* `unloadModel(model)`, `purgeModelCache(model)`, `purgeAllCaches()`
* `generateImage({ model, prompt, seed?, width?, height?, signal, onProgress })`

**Blobs:** `Blob` is structured-cloneable. Send it back to the main thread. There, create an object URL and set `<img src={url}>`.

---

## 14) Main-Thread Client Wrapper (Ergonomics)

A tiny wrapper class helps you:

* construct the worker (`type: 'module'`)
* send requests and get a Promise per `id`
* subscribe to progress per job
* call `abort()` on the *current* job
* receive `accepted`, `superseded`, `busy`, `cancelled`

Your UI code becomes:

* `await client.load('sd-turbo', { wasmPaths: '/ort/' }, onLoadProgress)`
* `const { id, promise, abort } = client.generate(params, onGenProgress)`
* `abort()` if user hits stop
* handle `{ ok:false, reason:'superseded' }` gracefully (i.e., ignore and wait for the newer job)

---

## 15) Security, Asset Paths, Bundling

* **Worker must be ESM**: create with `{ type: 'module' }`.
* **WASM assets**: ORT files must be visible to the worker. Use `wasmPaths: '/ort/'` (absolute) or ensure proper relative paths from the worker origin.
* **COOP/COEP**: For WASM threads & SIMD, serve your app cross-origin isolated (add COOP/COEP headers). This boosts SD-Turbo’s WASM performance.
* **CSP**: Allow `worker-src` and `connect-src` for model URLs you fetch (e.g., HF CDN or your own CDN).

---

## 16) Testing Plan

**Unit**

* State transitions:

  * idle → running → idle
  * running + `'reject'` → busy error
  * running + `'queue'` → queued replaced on new request
  * running + `'abort_and_queue'` → abort called, queued replaced on new request
* Debounce logic: last request within window runs, earlier ones superseded.

**Integration**

* SD-Turbo (WASM) run with a fixed seed; verify:

  * `'queue'` finishes current then runs the last queued
  * `'abort_and_queue'` stops early (within timeout bounds) then runs queued
* Janus (WebGPU) if available:

  * Ensure abort triggers best-effort stop (or gracefully falls back).

**Manual**

* Rapidly type prompts; watch that only the latest queued job runs after debounce.
* Click Generate repeatedly with different policies; confirm behavior.

---

## 17) Edge Cases & How to Handle Them

* **`load(modelB)` while `modelA` is running**

  * Simplest: respond `{ ok:false, reason: 'busy' }`.
  * Optional: treat `load` as a special step to perform *before* the pending generation (store `preLoad` on `pendingJob`). Start with the simple rule unless you really need switch-mid-flight.

* **Two different callers using one worker**

  * If you need isolation, implement **lanes** keyed by `params.key` (optional feature below).
  * Otherwise, the default single lane ensures system isn’t overwhelmed.

* **Abort called when idle**

  * Reply `{ ok:true, aborted:false }` or no-op.

* **Huge blobs / memory pressure**

  * Create object URLs on the main thread and revoke them when not needed (`URL.revokeObjectURL(url)`).

---

## 18) Optional Enhancements (Nice-to-Have)

* **Lanes**: Support multiple lanes keyed by `key`, each with its own `{currentJob, pendingJob}` state. Useful if multiple canvases or features need independent single-flight behavior.
* **FIFO queue mode**: Bounded length N instead of single-slot replacement. Only if your UX needs it.
* **Preload step**: Allow a `pendingJob` to include a `preLoad: { model, options }` so switching models mid-queue is seamless.
* **Telemetry hooks**: Track latencies, abort frequency, supersede rate.
* **Progress ETA**: Low-fidelity ETA for UI (“\~4s remaining”) based on past runs.
* **Backoff after abort spam**: If users trigger many aborts, add a small cooldown.

---

## 19) Implementation Checklist

* [ ] Create a **module** worker that imports the library’s API.
* [ ] Implement the message protocol (requests/responses) exactly as above.
* [ ] Maintain `currentJob`, `pendingJob`, `aborting`, `abortTimer`.
* [ ] Enforce **single-flight** and **single-slot queue** with replace semantics.
* [ ] Support `busyPolicy` (`'queue'` default), `replaceQueued`, `debounceMs`.
* [ ] Add **abort timeout** fallback.
* [ ] Normalize progress `%` and forward raw details.
* [ ] Handle special responses: `accepted`, `superseded`, `busy`.
* [ ] Ensure **WASM assets** path is correct for the worker (`/ort/`).
* [ ] Add a tiny **client wrapper** on the main thread.
* [ ] Test the transitions, supersede, and abort behavior.

---

## 20) Motivation Recap (for Juniors)

* **Why single-flight?** Prevents overloading the GPU/CPU and makes results predictable.
* **Why single-slot queue?** Live UIs (prompt typing, sliders) generate many requests; you almost always want only the latest one to run next.
* **Why `abort_and_queue`?** In live scenarios, continuing a stale generation wastes time. Abort early to start the latest request.
* **Why debounce?** Avoid restarting the queued job too often during rapid input bursts.
* **Why a worker?** Keeps your UI smooth and responsive while the heavy lifting happens elsewhere.