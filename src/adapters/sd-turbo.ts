import type {
  Adapter,
  BackendId,
  Capabilities,
  GenerateParams,
  GenerateResult,
  LoadOptions,
  LoadResult,
} from '../types.js';
import { fetchArrayBufferWithCacheProgress, purgeModelCache } from '../cache.js';

type ORT = typeof import('onnxruntime-web');

// Minimal adapter scaffold. Actual ONNX pipeline is TBD.

export class SDTurboAdapter implements Adapter {
  readonly id = 'sd-turbo' as const;

  private loaded = false;
  private backendUsed: BackendId | null = null;
  private ort: ORT | null = null;
  private sessions: {
    unet?: any;
    text_encoder?: any;
    vae_decoder?: any;
  } = {};
  private tokenizerFn: ((text: string, opts?: any) => Promise<{ input_ids: number[] }>) | null = null;
  private tokenizerProvider: (() => Promise<(text: string, opts?: any) => Promise<{ input_ids: number[] }>>) | null = null;
  private modelBase = 'https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main';

  checkSupport(c: Capabilities): BackendId[] {
    const backends: BackendId[] = [];
    if (c.webgpu) backends.push('webgpu');
    if (c.webnn) backends.push('webnn');
    // WASM is assumed available
    backends.push('wasm');
    return backends;
  }

  async load(options: Required<Pick<LoadOptions, 'backendPreference'>> & LoadOptions): Promise<LoadResult> {
    const preferred = options.backendPreference;
    const supported = ['webgpu', 'webnn', 'wasm'] as BackendId[];
    let chosen = preferred.find((b) => supported.includes(b));
    if (!chosen) return { ok: false, reason: 'backend_unavailable', message: 'No viable backend for SD-Turbo' };

    // Resolve model base URL override
    if (options.modelBaseUrl) this.modelBase = options.modelBaseUrl;
    if (options.tokenizerProvider) this.tokenizerProvider = options.tokenizerProvider;

    // Resolve ORT runtime: injected → dynamic import → global
    try {
      let ort: any = options.ort ?? null;
      if (!ort) {
        let ortMod: any = null;
        if (chosen === 'webgpu') {
          ortMod = await import('onnxruntime-web/webgpu').catch(() => null);
        } else {
          // WebNN and WASM share the default entry; provider chosen via options
          ortMod = await import('onnxruntime-web').catch(() => null);
        }
        ort = ortMod && (ortMod.default ?? ortMod);
      }
      if (!ort) {
        const gOrt = (globalThis as any).ort; // fallback if app added <script>
        if (gOrt) ort = gOrt;
      }
      if (!ort) {
        return { ok: false, reason: 'internal_error', message: 'onnxruntime-web not available. Install as a dependency or inject via loadModel({ ort }).' };
      }
      this.ort = ort as ORT;
    } catch (e) {
      return { ok: false, reason: 'internal_error', message: `Failed to load onnxruntime-web: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Placeholder for downloading model assets using Cache Storage
    try {
      options.onProgress?.({ phase: 'loading', message: 'Preparing SD-Turbo model...' });
      this.backendUsed = chosen;

      const ort = this.ort!;
      const opt: any = {
        executionProviders: [chosen === 'webnn' ? { name: 'webnn', deviceType: 'gpu', powerPreference: 'default' } : chosen],
        enableMemPattern: false,
        enableCpuMemArena: false,
        extra: {
          session: {
            disable_prepacking: '1',
            use_device_allocator_for_initializers: '1',
            use_ort_model_bytes_directly: '1',
            use_ort_model_bytes_for_initializers: '1',
          },
        },
      };
      if (chosen === 'webgpu') {
        (opt as any).preferredOutputLocation = { last_hidden_state: 'gpu-buffer' };
      }
      // Configure WASM env if provided, regardless of EP; ORT may still load WASM helpers
      try {
        if (options.wasmPaths) (ort as any).env.wasm.wasmPaths = options.wasmPaths;
        if (typeof options.wasmNumThreads === 'number') (ort as any).env.wasm.numThreads = options.wasmNumThreads;
        if (typeof options.wasmSimd === 'boolean') (ort as any).env.wasm.simd = options.wasmSimd;
      } catch {}

      const models = {
        unet: {
          url: 'unet/model.onnx', sizeMB: 640,
          opt: { freeDimensionOverrides: { batch_size: 1, num_channels: 4, height: 64, width: 64, sequence_length: 77 } },
        },
        text_encoder: {
          url: 'text_encoder/model.onnx', sizeMB: 1700,
          opt: { freeDimensionOverrides: { batch_size: 1 } },
        },
        vae_decoder: {
          url: 'vae_decoder/model.onnx', sizeMB: 95,
          opt: { freeDimensionOverrides: { batch_size: 1, num_channels_latent: 4, height_latent: 64, width_latent: 64 } },
        },
      } as const;

      // compute base URL
      const base = this.modelBase;

      // Fetch and create sessions with progress
      let bytesDownloaded = 0;
      const totalExpected = Object.values(models).reduce((acc, m) => acc + m.sizeMB * 1024 * 1024, 0);
      options.onProgress?.({ phase: 'loading', message: `starting downloads (~${Math.round(totalExpected/1024/1024)}MB total)...`, bytesDownloaded: 0, pct: 0 });
      for (const key of Object.keys(models) as Array<keyof typeof models>) {
        const model = models[key];
        options.onProgress?.({ phase: 'loading', message: `downloading ${model.url}...`, bytesDownloaded });
        const expectedTotal = model.sizeMB * 1024 * 1024;
        const buf = await fetchArrayBufferWithCacheProgress(`${base}/${model.url}`, this.id, (loaded, total) => {
          const pct = total ? Math.round(((bytesDownloaded + loaded) / totalExpected) * 100) : undefined;
          options.onProgress?.({ phase: 'loading', message: `downloading ${model.url}...`, pct, bytesDownloaded: bytesDownloaded + loaded });
        }, expectedTotal);
        bytesDownloaded += buf.byteLength;
        const start = performance.now();
        const sess = await (ort as any).InferenceSession.create(buf, { ...opt, ...(model.opt as any) });
        const ms = performance.now() - start;
        options.onProgress?.({ phase: 'loading', message: `${model.url} ready in ${ms.toFixed(1)}ms`, bytesDownloaded });
        (this.sessions as any)[key] = sess;
      }

      this.loaded = true;
      return { ok: true, backendUsed: chosen, bytesDownloaded };
    } catch (e) {
      console.error('[sd-turbo] load error', e);
      return { ok: false, reason: 'internal_error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async generate(params: Omit<GenerateParams, 'model'>): Promise<GenerateResult> {
    if (!this.loaded) return { ok: false, reason: 'model_not_loaded', message: 'Call loadModel() first' };

    const { prompt, width = 512, height = 512, signal, onProgress, seed } = params;
    if (!prompt || !prompt.trim()) return { ok: false, reason: 'unsupported_option', message: 'Prompt is required' };
    if (width !== 512 || height !== 512) {
      return { ok: false, reason: 'unsupported_option', message: 'Only 512x512 is supported in v1' };
    }

    const start = performance.now();
    const ort = this.ort!;

    try {
      // Tokenizer (injected or dynamic)
      onProgress?.({ phase: 'tokenizing', pct: 10 });
      if (!this.tokenizerFn) {
        if (this.tokenizerProvider) this.tokenizerFn = await this.tokenizerProvider();
        else this.tokenizerFn = await getTokenizer();
      }
      if (signal?.aborted) return { ok: false, reason: 'cancelled' };
      const tok = this.tokenizerFn!;
      const { input_ids } = await tok(prompt, { padding: true, max_length: 77, truncation: true, return_tensor: false });

      // Text encoder
      onProgress?.({ phase: 'encoding', pct: 25 });
      const ids = Int32Array.from(input_ids as number[]);
      let encOut: any;
      try {
        encOut = await this.sessions.text_encoder!.run({ input_ids: new (ort as any).Tensor('int32', ids, [1, ids.length]) });
      } catch (e) {
        throw new Error(`text_encoder.run failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const last_hidden_state = (encOut as any).last_hidden_state ?? encOut;
      if (signal?.aborted) return { ok: false, reason: 'cancelled' };

      // Latents
      const latent_shape = [1, 4, 64, 64];
      const sigma = 14.6146;
      const vae_scaling_factor = 0.18215;
      const latent = new (ort as any).Tensor(randn_latents(latent_shape, sigma, seed), latent_shape);
      const latent_model_input = scale_model_inputs(ort as any, latent, sigma);

      // UNet
      onProgress?.({ phase: 'denoising', pct: 70 });
      const tstep = [BigInt(999)];
      const feed: Record<string, any> = {
        sample: latent_model_input,
        timestep: new (ort as any).Tensor('int64', tstep as any, [1]),
        encoder_hidden_states: last_hidden_state,
      };
      let out_sample: any;
      try {
        out_sample = await this.sessions.unet!.run(feed);
        // Some builds return object with key out_sample; others return first output value
        out_sample = (out_sample as any).out_sample ?? out_sample;
      } catch (e) {
        throw new Error(`unet.run failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (typeof (last_hidden_state as any).dispose === 'function') (last_hidden_state as any).dispose();

      // Scheduler step
      const new_latents = step(ort as any, out_sample, latent, sigma, vae_scaling_factor);

      // VAE decode
      onProgress?.({ phase: 'decoding', pct: 95 });
      let vaeOut: any;
      try {
        vaeOut = await this.sessions.vae_decoder!.run({ latent_sample: new_latents });
      } catch (e) {
        throw new Error(`vae_decoder.run failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const sample = (vaeOut as any).sample ?? vaeOut;

      const blob = await tensorToPngBlob(sample);
      const timeMs = performance.now() - start;
      onProgress?.({ phase: 'complete', pct: 100, timeMs });
      return { ok: true, blob, timeMs };
    } catch (e) {
      console.error('[sd-turbo] generate error', e);
      return { ok: false, reason: 'internal_error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  async unload(): Promise<void> {
    this.loaded = false;
    this.backendUsed = null;
  }

  async purgeCache(): Promise<void> {
    await purgeModelCache(this.id);
  }
}

// Helpers

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randn_latents(shape: number[], noise_sigma: number, seed?: number) {
  const rand = seed !== undefined ? mulberry32(seed) : Math.random;
  function randn() {
    const u = rand();
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  let size = 1;
  for (const s of shape) size *= s;
  const data = new Float32Array(size);
  for (let i = 0; i < size; i++) data[i] = randn() * noise_sigma;
  return data;
}

function scale_model_inputs(ort: ORT, t: any, sigma: number) {
  const d_i: Float32Array = t.data;
  const d_o = new Float32Array(d_i.length);
  const divi = Math.sqrt(sigma * sigma + 1);
  for (let i = 0; i < d_i.length; i++) d_o[i] = d_i[i] / divi;
  return new (ort as any).Tensor(d_o, t.dims);
}

function step(ort: ORT, model_output: any, sample: any, sigma: number, vae_scaling_factor: number) {
  const d_o = new Float32Array(model_output.data.length);
  const prev_sample = new (ort as any).Tensor(d_o, model_output.dims);
  const sigma_hat = sigma * (0 + 1);
  for (let i = 0; i < model_output.data.length; i++) {
    const pred_original_sample = sample.data[i] - sigma_hat * model_output.data[i];
    const derivative = (sample.data[i] - pred_original_sample) / sigma_hat;
    const dt = 0 - sigma_hat;
    d_o[i] = (sample.data[i] + derivative * dt) / vae_scaling_factor;
  }
  return prev_sample;
}

async function tensorToPngBlob(t: any): Promise<Blob> {
  // t: [1, 3, H, W]
  const [n, c, h, w] = t.dims;
  const data: Float32Array = t.data;
  const out = new Uint8ClampedArray(w * h * 4);
  let idx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = data[0 * h * w + y * w + x];
      const g = data[1 * h * w + y * w + x];
      const b = data[2 * h * w + y * w + x];
      const clamp = (v: number) => {
        let x = v / 2 + 0.5;
        if (x < 0) x = 0;
        if (x > 1) x = 1;
        return Math.round(x * 255);
      };
      out[idx++] = clamp(r);
      out[idx++] = clamp(g);
      out[idx++] = clamp(b);
      out[idx++] = 255;
    }
  }
  const imageData = new ImageData(out, w, h);
  const hasOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canvas = hasOffscreen ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  (canvas as any).width = w; (canvas as any).height = h;
  const ctx = (canvas as any).getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.putImageData(imageData, 0, 0);
  if (canvas instanceof HTMLCanvasElement) {
    return await new Promise<Blob>((resolve) => (canvas as HTMLCanvasElement).toBlob((b) => resolve(b!), 'image/png'));
  } else {
    return await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  }
}

let _tokInstance: any = null;
async function getTokenizer(): Promise<any> {
  if (_tokInstance) return (text: string, opts: any) => _tokInstance(text, opts);
  // Prefer a global AutoTokenizer (if host app preloaded it), else dynamic import.
  const g: any = globalThis as any;
  if (g.AutoTokenizer && typeof g.AutoTokenizer.from_pretrained === 'function') {
    _tokInstance = await g.AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch16');
    _tokInstance.pad_token_id = 0;
    return (text: string, opts: any) => _tokInstance(text, opts);
  }
  let AutoTokenizerMod: any = null;
  try {
    const mod = await import('@xenova/transformers');
    AutoTokenizerMod = (mod as any).AutoTokenizer;
  } catch {
    try {
      const spec = '@huggingface/transformers';
      const mod2 = await import(/* @vite-ignore */ spec);
      AutoTokenizerMod = (mod2 as any).AutoTokenizer;
    } catch {
      throw new Error('Failed to load a tokenizer. Install @xenova/transformers or provide tokenizerProvider in loadModel options.');
    }
  }
  _tokInstance = await AutoTokenizerMod.from_pretrained('Xenova/clip-vit-base-patch16');
  _tokInstance.pad_token_id = 0;
  return (text: string, opts: any) => _tokInstance(text, opts);
}
