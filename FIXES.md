# Summary of Planned Fixes (Spec vs. Impl)

* ✅ Core API, registry, capability detection, progress events (SD-Turbo), seedable SD-Turbo, caching for SD-Turbo via Cache Storage, DI hooks, and a minimal example are implemented.
* ⚠️ Gaps vs. LIBRARY.md:

  1. Janus interruptible generation not implemented (only pre-start abort check).
  2. SD-Turbo sizes: code enforces **512×512 only** (keep this), but LIBRARY.md/registry text implies “multiples of 64”.
  3. Purging cache for Janus is effectively a no-op (Transformers.js manages its own caches).
  4. SD-Turbo `unload()` doesn’t dispose ORT sessions.
  5. `modelUrlOverrides` exists in types but isn’t used.

---

# Fix List (with code pointers & what to do)

## 1) Janus interruptible generation (investigate; may not be possible)

**Files:**

* `src/adapters/janus-pro.ts` (primary)

**What to try (in order):**

1. **Streamer-based early stop probe**

   * In the custom `ProgressStreamer.put`, when `signal?.aborted` is set, **throw** a small sentinel error (e.g., `"JANUS_STOP"`) to see if `generate_images` catches/propagates it.
   * In the outer `try/catch`, convert that sentinel into `{ ok: false, reason: 'cancelled' }`.
   * If this cleanly interrupts, wire in the abort path and emit a final progress event with `{ phase: 'complete', aborted: true }`.

2. **Library API check**

   * Review if `@huggingface/transformers` exposes an interrupt mechanism for image generation (e.g., stopping criteria/hooks). If present, integrate it (pass a stopping callback that checks `signal.aborted` and returns a stop decision).

3. **If neither works**

   * Leave pre-start abort check only (current behavior).
   * **Document limit** explicitly:

     * `README.md` → “Janus: Abort supported only **before** generation starts.”
     * `examples/minimal/README.md` and UI log line when abort is pressed while Janus is running: “Abort will take effect before the next run for Janus.”
     * Optionally, disable/grey out the “Abort” button during Janus generation to avoid confusion.

**Acceptance:** Either actual mid-run cancellation works, or the limitation is clearly documented & reflected in UI.

---

## 2) SD-Turbo sizes → keep **512×512 only** (align docs)

**Files to update:**

* `LIBRARY.md`

  * §2.2 / §2.5 / §10 and any place that implies “multiples of 64” → replace with “**512×512 only in v1**.”
* `src/registry.ts`

  * `REGISTRY` entry for `sd-turbo` → update `notes` to “**512×512 only in v1; seed supported**.”
* `README.md`

  * Already states 512×512; verify consistency across the file.
* `examples/minimal/index.html` (optional UI hint)

  * Clarify that size controls are fixed to 512×512 (no inputs visible).

**No code changes** in the adapter; the enforcement already exists here:

```
src/adapters/sd-turbo.ts
if (width !== 512 || height !== 512) {
  return { ok: false, reason: 'unsupported_option', message: 'Only 512x512 is supported in v1' };
}
```

---

## 3) Janus cache purge (clarify behavior; optional advanced work)

**Files:**

* `README.md`, `examples/minimal/README.md`
* `src/adapters/janus-pro.ts` (optional improvements)

**What to do now (minimum):**

* **Document** that `purgeModelCache('janus-pro-1b')` only affects the library’s Cache Storage and **does not** clear Transformers.js internal caches. Add a note right under the Janus section in README and the example README.

**Optional (advanced, only if needed later):**

* Add an **opt-in** hook to the adapter, e.g., `load({ hfCacheClear?: (hf: HF) => Promise<void> })`, and call it inside `purgeCache()` if provided. This lets host apps clear HF caches via library-specific knowledge without us committing to HF internals.

**Why:** Transformers.js manages its own cache (often IndexedDB); we don’t reliably control or enumerate those entries from here.

---

## 4) SD-Turbo unload should dispose sessions

**Files:**

* `src/adapters/sd-turbo.ts`

**What to do:**

* In `unload()`, call `release()` (if present) on each `InferenceSession` and **null out** references:

  * `this.sessions.unet?.release?.()`, `this.sessions.text_encoder?.release?.()`, `this.sessions.vae_decoder?.release?.()`.
  * `this.sessions = {}`; `this.ort = null`; `this.loaded = false; this.backendUsed = null;`
* Keep the existing disposal of temporary outputs during `generate()` (you already do `last_hidden_state.dispose?.()`).

**Acceptance:** After `unload()`, GPU/CPU memory footprint drops and subsequent `load()` works cleanly.

---

## 5) `modelUrlOverrides` (remove or wire up)

**Files:**

* `src/types.ts` (definition)
* `src/adapters/sd-turbo.ts` (usage, if keeping)

**Option A (simplest now):** Remove from the public types to avoid API drift until there’s a real use case.

**Option B (wire it):** In SD-Turbo `load()`, accept a map like:

```ts
modelUrlOverrides?: { unet?: string; text_encoder?: string; vae_decoder?: string }
```

and use those in place of the hardcoded relative `model.url` paths when building URLs against `modelBaseUrl`.

**Recommendation:** **Option A** for v1. You already have `modelBaseUrl` for CDNs; keep it minimal.

---

# Nice-to-have (not required for v1)

* **Worker host integration** (keeps UI snappy during large GPU/WASM work):

  * Provide an optional worker bundle that proxies `load/generate/unload/purge`.
  * The Janus example already uses a worker; consider promoting a generic worker to the library later.

---

# Concrete To-Do Checklist

1. **Janus abort (investigate)**

   * Probe streamer-based early stop; if viable, implement and return `{ reason: 'cancelled' }`.
   * If not viable, update docs + UI behavior to clarify limitation.

2. **Docs alignment for sizes**

   * LIBRARY.md: replace “multiples of 64” with “512×512 only in v1”.
   * `src/registry.ts`: adjust `notes` for `sd-turbo`.
   * Confirm README and minimal example text reflect 512×512.

3. **Janus purge docs**

   * README & example README: state that “Purge Cache” only affects SD-Turbo; Janus uses Transformers.js caches, not cleared here.

4. **Dispose SD-Turbo sessions**

   * Add session `.release?.()` calls in `src/adapters/sd-turbo.ts:unload()` and null out references.

5. **Prune or implement `modelUrlOverrides`**

   * Prefer removing from `src/types.ts` for now to avoid unused public API.