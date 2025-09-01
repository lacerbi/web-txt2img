import { Txt2ImgWorkerClient } from 'web-txt2img';
// Work around bundlers stripping worker in deps during prod build by importing URL explicitly
// This keeps example prod build robust.
import WorkerUrl from '../../packages/web-txt2img/src/worker/host.ts?worker&url';

// Import and configure transformers.js environment to fix tokenizer loading
import { env } from '@xenova/transformers';

// Configure transformers.js for production - force remote loading from Hugging Face
env.allowLocalModels = false;     // Don't try to load from /models/ locally
env.allowRemoteModels = true;      // Allow loading from remote CDN
env.remoteHost = 'https://huggingface.co/';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.useBrowserCache = true;       // Enable browser cache for downloaded models

const $ = (id) => document.getElementById(id);
const log = (m) => { 
  const el = $('log'); 
  const timestamp = new Date().toLocaleTimeString();
  el.textContent += `[${timestamp}] ${m}\n`; 
  el.scrollTop = el.scrollHeight; 
};
const setProgress = (p) => {
  const line = $('progress-line');
  const bar = $('progress-bar');
  if (!line || !bar) return;
  
  const pct = p?.pct != null ? ` • ${p.pct}%` : '';
  let sizeStr = '';
  if (p?.bytesDownloaded != null && p?.totalBytesExpected != null) {
    const cur = (p.bytesDownloaded/1024/1024).toFixed(1);
    const tot = (p.totalBytesExpected/1024/1024).toFixed(1);
    sizeStr = ` • ${cur}/${tot}MB`;
  } else if (p?.bytesDownloaded != null) {
    sizeStr = ` • ${(p.bytesDownloaded/1024/1024).toFixed(1)}MB`;
  }
  
  line.textContent = `${p?.message ?? 'Ready'}${pct}${sizeStr}`.trim();
  
  if (p?.pct != null) {
    bar.style.width = `${p.pct}%`;
    bar.classList.remove('indeterminate');
  } else if (p?.message && p.message !== 'Ready' && p.message !== 'Image ready') {
    bar.classList.add('indeterminate');
  } else {
    bar.style.width = '0%';
    bar.classList.remove('indeterminate');
  }
};

let client = null;
let generating = false;
let loadedModels = new Set();
let loadedDetails = new Map(); // modelId -> { backendUsed, bytesDownloaded? }
let currentAbort = null;

async function init() {
  // Check for WebGPU support first
  if (!navigator.gpu) {
    log('WebGPU is not supported in this browser');
    const warning = $('webgpu-warning');
    const statusEl = $('webgpu-status');
    if (statusEl) {
      statusEl.textContent = 'WebGPU NOT available (navigator.gpu is undefined)';
    }
    if (warning) {
      warning.style.display = 'flex';
    }
    // Disable all control cards and sections
    const cards = document.querySelectorAll('.card');
    cards.forEach(card => card.classList.add('webgpu-disabled'));
    const progressSection = document.querySelector('.progress-section');
    if (progressSection) progressSection.classList.add('webgpu-disabled');
    const outputGrid = document.querySelector('.output-grid');
    if (outputGrid) outputGrid.classList.add('webgpu-disabled');
    // Still initialize to show capabilities, but controls are disabled
  } else {
    // Update status to show WebGPU is available
    const statusEl = $('webgpu-status');
    if (statusEl) {
      statusEl.textContent = 'WebGPU available';
    }
  }
  
  log('System initialized...');
  const worker = new Worker(WorkerUrl, { type: 'module' });
  client = new Txt2ImgWorkerClient(worker);
  const caps = await client.detect();
  const capsText = Object.entries(caps)
    .filter(([k, v]) => v)
    .map(([k]) => k)
    .join(', ') || 'none';
  $('caps').textContent = capsText;
  const models = await client.listModels();
  const modelsById = new Map(models.map((m) => [m.id, m]));
  const sel = $('model');
  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = `${m.displayName}`; sel.appendChild(opt);
  });

  $('load').onclick = async () => {
    const model = sel.value;
    const backendChoice = 'auto';
    log(`Loading: ${model} with backend: ${backendChoice}`);
    
    // Configure backends and assets per model
    const isJanus = model === 'janus-pro-1b';
    
    // Determine backend preference based on user selection
    let backendPreference;
    if (backendChoice === 'auto') {
      backendPreference = isJanus ? ['webgpu'] : ['webgpu', 'wasm'];
    } else {
      // Force specific backend
      backendPreference = [backendChoice];
    }
    
    // Janus only supports WebGPU
    if (isJanus && backendChoice !== 'auto' && backendChoice !== 'webgpu') {
      log(`Warning: Janus-Pro-1B only supports WebGPU. Switching to WebGPU.`);
      backendPreference = ['webgpu'];
    }
    
    const wasmPaths = isJanus ? undefined : (import.meta.env && import.meta.env.DEV
      ? __ORT_WASM_BASE_DEV__
      : (import.meta.env.BASE_URL || '/') + 'ort/');
    
    const res = await client.load(model, {
      backendPreference,
      ...(wasmPaths ? { wasmPaths } : {}),
      ...(wasmPaths ? { wasmNumThreads: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 2 } : {}),
      ...(wasmPaths ? { wasmSimd: true } : {}),
    }, (p) => setProgress(p));
    
    log(`Load result: ${JSON.stringify(res)}`);
    if (res?.ok) { 
      loadedModels.add(model); 
      loadedDetails.set(model, { backendUsed: res.backendUsed, bytesDownloaded: res.bytesDownloaded });
      log(`Successfully loaded with backend: ${res.backendUsed}`);
    } else {
      log(`Failed to load: ${res?.message || 'Unknown error'}`);
    }
    setProgress({ message: 'Ready', pct: 100 });
  };

  $('model-info').onclick = () => {
    const model = sel.value;
    const info = modelsById.get(model);
    if (!info) { log('No model info available'); return; }
    const approxBytes = info.sizeBytesApprox;
    const approxGB = info.sizeGBApprox ?? (approxBytes ? (approxBytes / (1024*1024*1024)) : undefined);
    const approxLine = approxBytes != null
      ? `Approx size: ${(approxBytes/1024/1024).toFixed(1)} MB (~${approxGB?.toFixed ? approxGB.toFixed(2) : (approxGB ?? '')} GB)`
      : 'Approx size: n/a';
    const lines = [];
    lines.push(`[Model] ${info.displayName} (${info.id})`);
    lines.push(`Task: ${info.task}; Backends: ${info.supportedBackends.join(', ')}`);
    if (info.notes) lines.push(`Notes: ${info.notes}`);
    if (info.sizeNotes) lines.push(`Size notes: ${info.sizeNotes}`);
    lines.push(approxLine);
    const det = loadedDetails.get(model);
    const isLoaded = loadedModels.has(model);
    lines.push(`Loaded: ${isLoaded ? `yes (backend: ${det?.backendUsed ?? 'unknown'})` : 'no'}`);
    if (det) {
      const haveBytes = typeof det.bytesDownloaded === 'number';
      const actualMB = haveBytes ? (det.bytesDownloaded/1024/1024).toFixed(1) : 'n/a';
      lines.push(`Downloaded (measured): ${actualMB} MB`);
    } else {
      lines.push('Downloaded (measured): n/a');
    }
    log(lines.join('\n'));
  };

  $('gen').onclick = async () => {
    if (generating) { log('Already generating…'); return; }
    const model = sel.value;
    if (!loadedModels.has(model)) { log('Model not loaded'); return; }
    const prompt = $('prompt').value || 'Hello from web-txt2img';
    const seedVal = $('seed').value;
    const seed = seedVal === '' ? undefined : Number(seedVal);
    log(`Generating with prompt: ${prompt}`);
    generating = true;
    $('abort').disabled = false;
    const { promise, abort } = client.generate({ prompt, seed }, (e) => {
      const name = typeof e.phase === 'string' ? e.phase : 'working';
      const pct = e.pct != null ? e.pct : (typeof e.progress === 'number' ? Math.round(e.progress * 100) : undefined);
      setProgress({ message: `generate: ${name}` + (e.count != null && e.total != null ? ` (${e.count}/${e.total})` : ''), pct });
    }, { busyPolicy: 'queue', debounceMs: 200 });
    currentAbort = abort;
    const res = await promise;
    generating = false;
    $('abort').disabled = true;
    currentAbort = null;
    if (res?.ok) {
      const img = $('out');
      const placeholder = $('placeholder');
      img.src = URL.createObjectURL(res.blob);
      img.classList.add('show');
      if (placeholder) placeholder.style.display = 'none';
      log(`Done in ${Math.round(res.timeMs)}ms`);
      setProgress({ message: 'Image ready', pct: 100 });
    } else {
      log(`Generation failed: ${res?.reason} ${res?.message ?? ''}`);
      setProgress({ message: `failed: ${res?.reason}`, pct: 0 });
    }
  };

  $('unload').onclick = async () => {
    const model = sel.value; await client.unload(); loadedModels.delete(model); log('Unloaded model');
  };
  $('purge').onclick = async () => {
    const model = sel.value; await client.purge(); log('Purged cache for model'); setProgress({ message: 'Cache cleared', pct: 0, bytesDownloaded: 0 });
  };

  $('abort').onclick = async () => {
    if (!generating || !currentAbort) { log('Nothing to abort'); return; }
    const model = sel.value;
    const isJanus = model === 'janus-pro-1b';
    log(`Abort requested${isJanus ? ' (Janus: best-effort mid-run)' : ''}`);
    try { await currentAbort(); } catch {}
  };
}

init();
