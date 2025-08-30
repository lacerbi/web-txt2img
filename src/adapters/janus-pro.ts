import type {
  Adapter,
  BackendId,
  Capabilities,
  GenerateParams,
  GenerateResult,
  LoadOptions,
  LoadResult,
} from '../types.js';
import { purgeModelCache } from '../cache.js';

export class JanusProAdapter implements Adapter {
  readonly id = 'janus-pro-1b' as const;
  private loaded = false;
  private backendUsed: BackendId | null = null;

  checkSupport(c: Capabilities): BackendId[] {
    return c.webgpu ? ['webgpu'] : [];
  }

  async load(options: Required<Pick<LoadOptions, 'backendPreference'>> & LoadOptions): Promise<LoadResult> {
    const preferred = options.backendPreference;
    if (!preferred.includes('webgpu')) {
      return { ok: false, reason: 'backend_unavailable', message: 'Janus requires WebGPU' };
    }
    // Lazy import transformers.js components when app bundles them
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tfjs: any = await import('@huggingface/transformers').catch(() => null);
      if (!tfjs) {
        console.warn('[janus-pro] @huggingface/transformers not found; load() will be a no-op.');
      }
    } catch (e) {
      console.warn('[janus-pro] Failed dynamic import of @huggingface/transformers', e);
    }
    options.onProgress?.({ phase: 'loading', message: 'Preparing Janus-Pro-1B model...' });
    this.backendUsed = 'webgpu';
    this.loaded = true;
    return { ok: true, backendUsed: 'webgpu' };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async generate(params: Omit<GenerateParams, 'model'>): Promise<GenerateResult> {
    if (!this.loaded) return { ok: false, reason: 'model_not_loaded', message: 'Call loadModel() first' };
    const { prompt, signal, onProgress } = params;
    if (!prompt || !prompt.trim()) return { ok: false, reason: 'unsupported_option', message: 'Prompt is required' };

    // Placeholder implementation: indicate unsupported streaming and return an informative image blob.
    onProgress?.({ phase: 'image_tokens', count: 0, total: 0, progress: 0 });
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    const start = performance.now();
    const blob = await renderInfoImage('Janus-Pro placeholder\nStreaming not implemented yet');
    const timeMs = performance.now() - start;
    onProgress?.({ phase: 'complete', pct: 100, timeMs });
    return { ok: true, blob, timeMs };
  }

  async unload(): Promise<void> {
    this.loaded = false;
    this.backendUsed = null;
  }

  async purgeCache(): Promise<void> {
    await purgeModelCache(this.id);
  }
}

async function renderInfoImage(text: string): Promise<Blob> {
  const width = 512;
  const height = 288;
  const hasOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canvas = hasOffscreen ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  (canvas as any).width = width;
  (canvas as any).height = height;
  const ctx = (canvas as any).getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = '#202a44';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#cfe3ff';
  ctx.font = '18px sans-serif';
  const lines = text.split(/\n/);
  lines.forEach((line, i) => ctx.fillText(line, 12, 28 + i * 24));
  if (canvas instanceof HTMLCanvasElement) {
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
  } else {
    return await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' });
  }
}

