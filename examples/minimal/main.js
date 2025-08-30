import {
  detectCapabilities,
  listSupportedModels,
  loadModel,
  isModelLoaded,
  generateImage,
  unloadModel,
  purgeModelCache,
} from '/src/index.ts';

const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); el.textContent += `${m}\n`; el.scrollTop = el.scrollHeight; };
const setProgress = (p) => {
  const line = $('progress-line');
  const bar = $('progress-bar');
  if (!line || !bar) return;
  const pct = p?.pct != null ? `${p.pct}%` : '';
  const mb = p?.bytesDownloaded != null ? ` ${(p.bytesDownloaded/1024/1024).toFixed(1)}MB` : '';
  line.textContent = `${p?.message ?? ''}${pct}${mb}`.trim();
  if (p?.pct != null) bar.value = p.pct; else bar.removeAttribute('value');
};

async function init() {
  const caps = await detectCapabilities();
  $('caps').textContent = JSON.stringify(caps);
  const models = listSupportedModels();
  const sel = $('model');
  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = `${m.displayName}`; sel.appendChild(opt);
  });

  $('load').onclick = async () => {
    const model = sel.value;
    log(`Loading: ${model}`);
    const wasmPaths = import.meta.env && import.meta.env.DEV
      ? '/node_modules/onnxruntime-web/dist/'
      : '/ort/';
    const res = await loadModel(model, {
      backendPreference: ['webgpu', 'wasm'],
      wasmPaths,
      wasmNumThreads: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 2,
      wasmSimd: true,
      onProgress: (p) => setProgress(p),
    });
    log(`Load result: ${JSON.stringify(res)}`);
    setProgress({ message: 'Ready', pct: 100 });
  };

  $('gen').onclick = async () => {
    const model = sel.value;
    if (!isModelLoaded(model)) { log('Model not loaded'); return; }
    const prompt = $('prompt').value || 'Hello from web-txt2img';
    const seedVal = $('seed').value;
    const seed = seedVal === '' ? undefined : Number(seedVal);
    log(`Generating with prompt: ${prompt}`);
    const res = await generateImage({
      model,
      prompt,
      seed,
      onProgress: (e) => {
        const name = typeof e.phase === 'string' ? e.phase : 'working';
        setProgress({ message: `generate: ${name}`, pct: e.pct ?? undefined });
      },
    });
    if (res.ok) {
      $('out').src = URL.createObjectURL(res.blob);
      log(`Done in ${Math.round(res.timeMs)}ms`);
      setProgress({ message: 'Image ready', pct: 100 });
    } else {
      log(`Generation failed: ${res.reason} ${res.message ?? ''}`);
      setProgress({ message: `failed: ${res.reason}`, pct: 0 });
    }
  };

  $('unload').onclick = async () => {
    const model = sel.value; await unloadModel(model); log('Unloaded model');
  };
  $('purge').onclick = async () => {
    const model = sel.value; await purgeModelCache(model); log('Purged cache for model'); setProgress({ message: 'Cache cleared', pct: 0, bytesDownloaded: 0 });
  };
}

init();
