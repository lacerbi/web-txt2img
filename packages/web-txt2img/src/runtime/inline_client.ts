// Inline client for web-txt2img — main thread API without workers
// Maintains same API surface as Txt2ImgWorkerClient for compatibility

import {
  detectCapabilities,
  listBackends,
  listSupportedModels,
  loadModel,
  unloadModel,
  purgeModelCache,
  purgeAllCaches,
} from '../index.js';
import type { BackendId, GenerateResult, LoadOptions, ModelId } from '../types.js';
import type { WorkerBusyPolicy, WorkerGenerateParams } from '../worker/protocol.js';
import { InlineScheduler, type SchedulerState } from './inline_host.js';

export type ProgressHandler = (e: any) => void;

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Main thread client for web-txt2img that runs without workers.
 * Provides the same API as Txt2ImgWorkerClient for compatibility.
 */
export class Txt2ImgClient {
  private scheduler: InlineScheduler;
  private loadInFlight = false;
  private stateChangeListeners: Array<(state: SchedulerState) => void> = [];

  constructor() {
    this.scheduler = new InlineScheduler({
      onStateChange: (state) => {
        this.stateChangeListeners.forEach(listener => listener(state));
      },
    });
  }

  /**
   * Subscribe to state changes (idle, running, queued, aborting)
   */
  onStateChange(listener: (state: SchedulerState) => void): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      const index = this.stateChangeListeners.indexOf(listener);
      if (index >= 0) {
        this.stateChangeListeners.splice(index, 1);
      }
    };
  }

  /**
   * Detect browser capabilities
   */
  async detect(): Promise<{ webgpu: boolean; shaderF16: boolean; wasm: boolean }> {
    return await detectCapabilities();
  }

  /**
   * List available models
   */
  async listModels(): Promise<Array<{
    id: ModelId;
    displayName: string;
    task: 'text-to-image';
    supportedBackends: BackendId[];
    notes?: string;
    sizeBytesApprox?: number;
    sizeGBApprox?: number;
    sizeNotes?: string;
  }>> {
    return listSupportedModels();
  }

  /**
   * List available backends
   */
  async listBackends(): Promise<BackendId[]> {
    return listBackends();
  }

  /**
   * Load a model for generation
   */
  async load(
    model: ModelId,
    options?: LoadOptions,
    onProgress?: ProgressHandler
  ): Promise<any> {
    const loadedModel = this.scheduler.getLoadedModel();
    
    if (loadedModel || this.loadInFlight) {
      const reason = 'busy';
      const message = loadedModel
        ? `Model "${loadedModel}" already loaded. Unload before loading another.`
        : 'Another load is in progress.';
      return { ok: false, reason, message };
    }

    this.loadInFlight = true;
    
    try {
      const result = await loadModel(model, {
        ...options,
        onProgress: (p) => {
          onProgress?.({
            ...p,
            pct: typeof p.pct === 'number' ? p.pct : undefined,
          });
        },
      });

      if ((result as any).ok) {
        this.scheduler.setLoadedModel(model);
      }
      
      return result;
    } catch (error) {
      return {
        ok: false,
        reason: 'internal_error',
        message: String(error),
      };
    } finally {
      this.loadInFlight = false;
    }
  }

  /**
   * Unload the currently loaded model
   */
  async unload(model?: ModelId): Promise<void> {
    const loadedModel = this.scheduler.getLoadedModel();
    const target = model ?? loadedModel;

    if (!target) {
      throw new Error('No model loaded to unload.');
    }

    if (loadedModel && loadedModel !== target) {
      throw new Error(
        `Loaded model is "${loadedModel}"; requested unload "${target}".`
      );
    }

    await unloadModel(target);
    
    if (loadedModel === target) {
      this.scheduler.setLoadedModel(null);
    }
  }

  /**
   * Purge model cache
   */
  async purge(model?: ModelId): Promise<void> {
    const loadedModel = this.scheduler.getLoadedModel();
    const target = model ?? loadedModel;

    if (!target) {
      throw new Error('No model specified and none loaded; cannot purge.');
    }

    await purgeModelCache(target);
  }

  /**
   * Purge all model caches
   */
  async purgeAll(): Promise<void> {
    await purgeAllCaches();
  }

  /**
   * Generate an image from text prompt
   */
  generate(
    params: WorkerGenerateParams,
    onProgress?: ProgressHandler,
    opts?: {
      busyPolicy?: WorkerBusyPolicy;
      replaceQueued?: boolean;
      debounceMs?: number;
    }
  ): {
    id: string;
    promise: Promise<GenerateResult>;
    abort: () => Promise<void>;
  } {
    const id = uid();

    const promise = this.scheduler.enqueueGenerate(
      params as any,
      onProgress,
      opts
    );

    const abort = async () => {
      await this.scheduler.abort();
    };

    return { id, promise, abort };
  }

  /**
   * Clean up resources
   */
  terminate() {
    this.scheduler.cleanup();
    this.stateChangeListeners = [];
  }
}

/**
 * Compatibility wrapper for Txt2ImgWorkerClient
 * @deprecated Use Txt2ImgClient instead
 */
export class Txt2ImgWorkerClient extends Txt2ImgClient {
  constructor(worker?: Worker) {
    super();
    if (worker) {
      console.warn(
        'Txt2ImgWorkerClient: Worker parameter is ignored. ' +
        'This class now runs inline without workers. ' +
        'Consider using Txt2ImgClient directly.'
      );
    }
  }

  static createDefault(): Txt2ImgWorkerClient {
    console.warn(
      'Txt2ImgWorkerClient.createDefault() is deprecated. ' +
      'Use "new Txt2ImgClient()" instead for better performance.'
    );
    return new Txt2ImgWorkerClient();
  }
}