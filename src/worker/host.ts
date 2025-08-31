// Worker host for web-txt2img — single-flight with single-slot queue
/// <reference lib="WebWorker" />

import {
  detectCapabilities,
  listBackends,
  listSupportedModels,
  loadModel,
  unloadModel,
  purgeModelCache,
  purgeAllCaches,
  generateImage,
  type GenerateParams,
} from '../index.js';
import type { GenerateResult, ModelId } from '../types.js';
import type { WorkerRequest, WorkerResponse, WorkerState, WorkerBusyPolicy } from './protocol.js';

type JobParams = Omit<GenerateParams, 'onProgress' | 'signal'>;

interface CurrentJob {
  id: string;
  controller: AbortController;
  params: JobParams;
}

interface PendingJob {
  id: string;
  params: JobParams;
  debounceUntil?: number;
}

let currentJob: CurrentJob | null = null;
let pendingJob: PendingJob | null = null;
let aborting = false;
const ABORT_TIMEOUT_MS = 8000;
let abortTimer: number | null = null;
let debounceTimer: number | null = null;
let loadedModel: ModelId | null = null;
let loadInFlight = false;

function post(msg: WorkerResponse) {
  (self as any).postMessage(msg);
}

function setState(state: WorkerState) {
  post({ type: 'state', value: state });
}

function normPct(e: any): number | undefined {
  if (typeof e?.pct === 'number') return e.pct;
  if (typeof e?.progress === 'number') return Math.round(e.progress * 100);
  return undefined;
}

async function runJob(job: CurrentJob) {
  setState('running');
  const startParams = job.params;
  const res: GenerateResult = await generateImage({
    ...startParams,
    signal: job.controller.signal,
    onProgress: (event) => {
      post({ id: job.id, type: 'progress', event: { ...event, pct: normPct(event) } });
    },
  });
  // current job ended
  if (!currentJob || currentJob.id !== job.id) {
    // stale; likely superseded; nothing else to do
    return;
  }
  currentJob = null;
  if (aborting) {
    aborting = false;
    if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; }
  }
  if (res.ok) {
    post({ id: job.id, type: 'result', ok: true, blob: res.blob, timeMs: res.timeMs });
  } else {
    post({ id: job.id, type: 'result', ok: false, reason: res.reason, message: res.message });
  }
  // Maybe start the next pending job
  maybeStartNext();
}

function maybeStartNext() {
  if (currentJob) return; // still running
  if (!pendingJob) {
    setState('idle');
    return;
  }
  setState('queued');
  const now = Date.now();
  const wait = Math.max(0, (pendingJob.debounceUntil ?? 0) - now);
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (wait > 0) {
    debounceTimer = setTimeout(() => {
      startPending();
    }, wait) as unknown as number;
  } else {
    startPending();
  }
}

function startPending() {
  if (!pendingJob || currentJob) return;
  const toStart = pendingJob;
  pendingJob = null;
  const controller = new AbortController();
  currentJob = { id: toStart.id, controller, params: toStart.params };
  runJob(currentJob);
}

function supersedePending(newJob: PendingJob) {
  if (pendingJob) {
    // notify superseded
    post({ id: pendingJob.id, type: 'result', ok: false, reason: 'superseded' });
  }
  pendingJob = newJob;
  setState('queued');
}

function handleAbortTimeout() {
  abortTimer = setTimeout(() => {
    // Abort not honored quickly; emit hint and fall back to queue-after-completion
    if (currentJob) {
      post({ id: currentJob.id, type: 'progress', event: { phase: 'aborting_timeout', pct: normPct({}) } as any });
    }
    aborting = false; // we are no longer actively aborting
  }, ABORT_TIMEOUT_MS) as unknown as number;
}

function onMessage(ev: MessageEvent<WorkerRequest>) {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object' || !('kind' in msg)) return;

  switch (msg.kind) {
    case 'detect': {
      detectCapabilities()
        .then((v) => post({ id: msg.id, type: 'result', ok: true, data: v }))
        .catch((e) => post({ id: msg.id, type: 'result', ok: false, reason: 'internal_error', message: String(e) }));
      break;
    }
    case 'listModels': {
      try { post({ id: msg.id, type: 'result', ok: true, data: listSupportedModels() }); }
      catch (e) { post({ id: msg.id, type: 'result', ok: false, reason: 'internal_error', message: String(e) }); }
      break;
    }
    case 'listBackends': {
      try { post({ id: msg.id, type: 'result', ok: true, data: listBackends() }); }
      catch (e) { post({ id: msg.id, type: 'result', ok: false, reason: 'internal_error', message: String(e) }); }
      break;
    }
    case 'load': {
      if (loadedModel || loadInFlight) {
        const reason = 'busy';
        const message = loadedModel ? `Model "${loadedModel}" already loaded. Unload before loading another.` : 'Another load is in progress.';
        post({ id: msg.id, type: 'result', ok: false, reason, message });
        break;
      }
      loadInFlight = true;
      loadModel(msg.model, {
        ...msg.options,
        onProgress: (p) => post({ id: msg.id, type: 'progress', event: { ...p, pct: typeof p.pct === 'number' ? p.pct : undefined } as any }),
      })
        .then((r) => {
          if ((r as any).ok) {
            post({ id: msg.id, type: 'result', ok: true, data: r });
            loadedModel = msg.model;
          } else {
            const rr: any = r;
            post({ id: msg.id, type: 'result', ok: false, reason: rr.reason ?? 'internal_error', message: rr.message });
          }
        })
        .catch((e) => post({ id: msg.id, type: 'result', ok: false, reason: 'internal_error', message: String(e) }))
        .finally(() => { loadInFlight = false; });
      break;
    }
    case 'unload': {
      unloadModel(msg.model)
        .then(() => {
          if (loadedModel === msg.model) loadedModel = null;
          post({ id: msg.id, type: 'result', ok: true });
        })
        .catch((e) => post({ id: msg.id, type: 'result', ok: false, reason: 'internal_error', message: String(e) }));
      break;
    }
    case 'purge': {
      purgeModelCache(msg.model)
        .then(() => post({ id: msg.id, type: 'result', ok: true }))
        .catch((e) => post({ id: msg.id, type: 'result', ok: false, reason: 'internal_error', message: String(e) }));
      break;
    }
    case 'purgeAll': {
      purgeAllCaches()
        .then(() => post({ id: msg.id, type: 'result', ok: true }))
        .catch((e) => post({ id: msg.id, type: 'result', ok: false, reason: 'internal_error', message: String(e) }));
      break;
    }
    case 'generate': {
      const policy: WorkerBusyPolicy = msg.busyPolicy ?? 'queue';
      const replaceQueued = msg.replaceQueued ?? true;
      const debounceMs = Math.max(0, msg.debounceMs ?? 0);

      // If idle, start immediately
      if (!currentJob) {
        const controller = new AbortController();
        currentJob = { id: msg.id, controller, params: msg.params };
        runJob(currentJob);
        break;
      }

      // Busy path
      if (policy === 'reject') {
        post({ id: msg.id, type: 'result', ok: false, reason: 'busy' });
        break;
      }

      if (policy === 'abort_and_queue') {
        const pj: PendingJob = { id: msg.id, params: msg.params };
        if (replaceQueued) supersedePending(pj); else if (!pendingJob) pendingJob = pj; else { post({ id: msg.id, type: 'result', ok: false, reason: 'busy' }); break; }

        if (debounceMs > 0) {
          const now = Date.now();
          if (pendingJob) pendingJob.debounceUntil = now + debounceMs;
        }

        // Abort current
        if (!aborting && currentJob) {
          aborting = true; setState('aborting');
          currentJob.controller.abort();
          if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; }
          handleAbortTimeout();
        }
        post({ id: msg.id, type: 'accepted' });
        break;
      }

      // Default: 'queue'
      if (pendingJob) {
        if (replaceQueued) {
          supersedePending({ id: msg.id, params: msg.params, debounceUntil: debounceMs ? Date.now() + debounceMs : undefined });
          post({ id: msg.id, type: 'accepted' });
        } else {
          post({ id: msg.id, type: 'result', ok: false, reason: 'busy' });
        }
      } else {
        pendingJob = { id: msg.id, params: msg.params, debounceUntil: debounceMs ? Date.now() + debounceMs : undefined };
        post({ id: msg.id, type: 'accepted' });
      }
      setState('queued');
      break;
    }
    case 'abort': {
      if (currentJob) {
        if (!aborting) {
          aborting = true; setState('aborting');
          currentJob.controller.abort();
          if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; }
          handleAbortTimeout();
        }
        post({ id: msg.id, type: 'accepted' });
      } else {
        // No-op
        post({ id: msg.id, type: 'result', ok: true });
      }
      break;
    }
  }
}

self.addEventListener('message', onMessage as any);
setState('idle');
export {};
