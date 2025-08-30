import {
  detectCapabilities,
  listSupportedModels,
  loadModel,
  isModelLoaded,
  generateImage,
  unloadModel,
  purgeModelCache,
} from '../../dist/index.js';

const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); el.textContent += `${m}\n`; el.scrollTop = el.scrollHeight; };

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
    const res = await loadModel(model, { onProgress: (p) => {
      const pct = p.pct != null ? ` ${p.pct}%` : '';
      const mb = p.bytesDownloaded != null ? ` ${(p.bytesDownloaded/1024/1024).toFixed(1)}MB` : '';
      log(`progress: ${p.message ?? ''}${pct}${mb}`)
    }});
    log(`Load result: ${JSON.stringify(res)}`);
  };

  $('gen').onclick = async () => {
    const model = sel.value;
    if (!isModelLoaded(model)) { log('Model not loaded'); return; }
    const prompt = $('prompt').value || 'Hello from web-txt2img';
    const seedVal = $('seed').value;
    const seed = seedVal === '' ? undefined : Number(seedVal);
    log(`Generating with prompt: ${prompt}`);
    const res = await generateImage({ model, prompt, seed, onProgress: (e) => log(`phase: ${e.phase} ${e.pct ?? ''}`) });
    if (res.ok) {
      $('out').src = URL.createObjectURL(res.blob);
      log(`Done in ${Math.round(res.timeMs)}ms`);
    } else {
      log(`Generation failed: ${res.reason} ${res.message ?? ''}`);
    }
  };

  $('unload').onclick = async () => {
    const model = sel.value; await unloadModel(model); log('Unloaded model');
  };
  $('purge').onclick = async () => {
    const model = sel.value; await purgeModelCache(model); log('Purged cache for model');
  };
}

init();
