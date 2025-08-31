#!/usr/bin/env node
/* Copy ONNX Runtime Web runtime assets into examples/vanilla-worker/public/ort so they can be served. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true }).catch(() => {});
}

async function copyFile(src, dst) {
  await ensureDir(path.dirname(dst));
  await fsp.copyFile(src, dst);
}

async function main() {
  // Workspace root is above examples/vanilla-worker; resolve node_modules from there
  const root = path.resolve(__dirname, '../../..');
  // Try to resolve the package location robustly (works with npm workspaces and hoisting)
  let pkgJsonPath;
  try {
    pkgJsonPath = require.resolve('onnxruntime-web/package.json', { paths: [__dirname, path.join(__dirname, '..'), root] });
  } catch {}
  const srcDir = pkgJsonPath ? path.join(path.dirname(pkgJsonPath), 'dist') : path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
  const dstDir = path.join(__dirname, '..', 'public', 'ort');
  try {
    await fsp.access(srcDir);
  } catch {
    console.warn('[copy-ort-assets] onnxruntime-web not installed; skipping');
    return;
  }
  await ensureDir(dstDir);
  const entries = await fsp.readdir(srcDir);
  const wanted = entries.filter((f) => /^ort-wasm.*\.(wasm|jsep\.mjs)$/i.test(f));
  if (wanted.length === 0) {
    console.warn('[copy-ort-assets] No ort-wasm assets found in dist.');
  }
  const ops = wanted.map((f) => copyFile(path.join(srcDir, f), path.join(dstDir, f)));
  await Promise.all(ops);
  console.log(`[copy-ort-assets] Copied ${wanted.length} files to public/ort`);
}

main().catch((e) => {
  console.error('[copy-ort-assets] Failed:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
