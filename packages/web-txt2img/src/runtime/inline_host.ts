// Inline runtime scheduler for web-txt2img — single-flight with single-slot queue
// Runs on main thread without workers while maintaining same scheduling semantics

import {
  generateImage,
  type GenerateParams,
} from '../index.js';
import type { GenerateResult, ModelId } from '../types.js';
import type { WorkerBusyPolicy } from '../worker/protocol.js';

type JobParams = Omit<GenerateParams, 'onProgress' | 'signal'>;

interface CurrentJob {
  id: string;
  controller: AbortController;
  params: JobParams;
  promise: Promise<void>;
}

interface PendingJob {
  id: string;
  params: JobParams;
  debounceUntil?: number;
  onProgress?: (e: any) => void;
  resolve: (result: GenerateResult) => void;
  reject: (error: any) => void;
}

export type SchedulerState = 'idle' | 'running' | 'aborting' | 'queued';

interface SchedulerCallbacks {
  onStateChange?: (state: SchedulerState) => void;
}

export class InlineScheduler {
  private currentJob: CurrentJob | null = null;
  private pendingJob: PendingJob | null = null;
  private aborting = false;
  private readonly ABORT_TIMEOUT_MS = 8000;
  private abortTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedModel: ModelId | null = null;
  private callbacks: SchedulerCallbacks;
  private state: SchedulerState = 'idle';

  constructor(callbacks: SchedulerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  private setState(state: SchedulerState) {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  getState(): SchedulerState {
    return this.state;
  }

  setLoadedModel(model: ModelId | null) {
    this.loadedModel = model;
  }

  getLoadedModel(): ModelId | null {
    return this.loadedModel;
  }

  private normPct(e: any): number | undefined {
    if (typeof e?.pct === 'number') return e.pct;
    if (typeof e?.progress === 'number') return Math.round(e.progress * 100);
    return undefined;
  }

  private async runJob(job: CurrentJob, onProgress?: (e: any) => void): Promise<GenerateResult> {
    this.setState('running');
    const startParams = job.params;
    
    const res: GenerateResult = await generateImage({
      ...startParams,
      signal: job.controller.signal,
      onProgress: (event) => {
        onProgress?.({ ...event, pct: this.normPct(event) });
      },
    });

    // Check if job is still current
    if (!this.currentJob || this.currentJob.id !== job.id) {
      // Stale job, likely superseded
      return { ok: false, reason: 'cancelled' as any };
    }

    this.currentJob = null;
    if (this.aborting) {
      this.aborting = false;
      if (this.abortTimer) {
        clearTimeout(this.abortTimer);
        this.abortTimer = null;
      }
    }

    // Maybe start the next pending job
    this.maybeStartNext();

    return res;
  }

  private maybeStartNext() {
    if (this.currentJob) return; // Still running
    
    if (!this.pendingJob) {
      this.setState('idle');
      return;
    }

    this.setState('queued');
    const now = Date.now();
    const wait = Math.max(0, (this.pendingJob.debounceUntil ?? 0) - now);
    
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (wait > 0) {
      this.debounceTimer = setTimeout(() => {
        this.startPending();
      }, wait);
    } else {
      this.startPending();
    }
  }

  private startPending() {
    if (!this.pendingJob || this.currentJob) return;
    
    const toStart = this.pendingJob;
    this.pendingJob = null;
    
    const controller = new AbortController();
    const job: CurrentJob = {
      id: toStart.id,
      controller,
      params: toStart.params,
      promise: Promise.resolve(), // Will be replaced
    };

    // Run the job and handle result
    job.promise = this.runJob(job, toStart.onProgress).then(
      (result) => toStart.resolve(result),
      (error) => toStart.reject(error)
    );

    this.currentJob = job;
  }

  private supersedePending(newJob: PendingJob) {
    if (this.pendingJob) {
      // Notify superseded job
      this.pendingJob.resolve({ ok: false, reason: 'cancelled' as any });
    }
    this.pendingJob = newJob;
    this.setState('queued');
  }

  private handleAbortTimeout(onProgress?: (e: any) => void) {
    this.abortTimer = setTimeout(() => {
      // Abort not honored quickly; emit hint
      if (this.currentJob) {
        onProgress?.({ phase: 'aborting_timeout', pct: undefined });
      }
      this.aborting = false; // No longer actively aborting
    }, this.ABORT_TIMEOUT_MS);
  }

  async enqueueGenerate(
    params: JobParams,
    onProgress?: (e: any) => void,
    options?: {
      busyPolicy?: WorkerBusyPolicy;
      replaceQueued?: boolean;
      debounceMs?: number;
    }
  ): Promise<GenerateResult> {
    const policy = options?.busyPolicy ?? 'queue';
    const replaceQueued = options?.replaceQueued ?? true;
    const debounceMs = Math.max(0, options?.debounceMs ?? 0);

    // Resolve model
    const reqModel = params.model;
    const resolvedModel = reqModel ?? this.loadedModel;
    
    if (!resolvedModel) {
      return {
        ok: false,
        reason: 'model_not_loaded',
        message: 'No model loaded; specify a model or call load() first.',
      };
    }

    if (!this.loadedModel) {
      return {
        ok: false,
        reason: 'model_not_loaded',
        message: 'No model loaded; call load() first.',
      };
    }

    if (this.loadedModel !== resolvedModel) {
      return {
        ok: false,
        reason: 'model_not_loaded',
        message: `Loaded model is "${this.loadedModel}"; requested generate for "${resolvedModel}".`,
      };
    }

    const resolvedParams: JobParams = { ...params, model: resolvedModel };
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);

    return new Promise((resolve, reject) => {
      // If idle, start immediately
      if (!this.currentJob) {
        const controller = new AbortController();
        const job: CurrentJob = {
          id,
          controller,
          params: resolvedParams,
          promise: Promise.resolve(),
        };

        job.promise = this.runJob(job, onProgress).then(
          (result) => resolve(result),
          (error) => reject(error)
        );

        this.currentJob = job;
        return;
      }

      // Busy path
      if (policy === 'reject') {
        resolve({ ok: false, reason: 'internal_error' as any, message: 'Generator is busy' });
        return;
      }

      const pendingJob: PendingJob = {
        id,
        params: resolvedParams,
        debounceUntil: debounceMs > 0 ? Date.now() + debounceMs : undefined,
        onProgress,
        resolve,
        reject,
      };

      if (policy === 'abort_and_queue') {
        if (replaceQueued) {
          this.supersedePending(pendingJob);
        } else if (!this.pendingJob) {
          this.pendingJob = pendingJob;
        } else {
          resolve({ ok: false, reason: 'internal_error' as any, message: 'Generator is busy' });
          return;
        }

        // Abort current job
        if (!this.aborting && this.currentJob) {
          this.aborting = true;
          this.setState('aborting');
          this.currentJob.controller.abort();
          
          if (this.abortTimer) {
            clearTimeout(this.abortTimer);
            this.abortTimer = null;
          }
          this.handleAbortTimeout(onProgress);
        }
        return;
      }

      // Default: 'queue'
      if (this.pendingJob) {
        if (replaceQueued) {
          this.supersedePending(pendingJob);
        } else {
          resolve({ ok: false, reason: 'internal_error' as any, message: 'Generator is busy' });
        }
      } else {
        this.pendingJob = pendingJob;
      }
      this.setState('queued');
    });
  }

  async abort(): Promise<void> {
    if (this.currentJob) {
      if (!this.aborting) {
        this.aborting = true;
        this.setState('aborting');
        this.currentJob.controller.abort();
        
        if (this.abortTimer) {
          clearTimeout(this.abortTimer);
          this.abortTimer = null;
        }
        this.handleAbortTimeout();
      }
    }
    // Return immediately, don't wait for actual abort
  }

  cleanup() {
    // Abort any running job
    if (this.currentJob) {
      this.currentJob.controller.abort();
      this.currentJob = null;
    }

    // Clear pending job
    if (this.pendingJob) {
      this.pendingJob.resolve({ ok: false, reason: 'cancelled' });
      this.pendingJob = null;
    }

    // Clear timers
    if (this.abortTimer) {
      clearTimeout(this.abortTimer);
      this.abortTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.aborting = false;
    this.setState('idle');
  }
}