import { defineConfig } from 'vite';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ortPkgPath = '';
try { ortPkgPath = require.resolve('onnxruntime-web/package.json'); } catch {}
const ortPkgRoot = ortPkgPath ? path.dirname(ortPkgPath) : path.resolve(__dirname, '../../node_modules/onnxruntime-web');
const ortDistFs = path.join(ortPkgRoot, 'dist');
const ORT_WASM_BASE_DEV = `/@fs/${ortDistFs}/`;

export default defineConfig(({ mode }) => ({
  root: '.',
  base: process.env.BASE_PATH && mode === 'production' ? process.env.BASE_PATH : '/',
  server: {
    port: 5173,
    open: '/',
    fs: { allow: [path.resolve(__dirname, '../..')] },
  },
  worker: {
    format: 'es',
  },
  resolve: {
    alias: {
      'web-txt2img': path.resolve(__dirname, '../../packages/web-txt2img/src/index.ts'),
    },
  },
  define: {
    __ORT_WASM_BASE_DEV__: JSON.stringify(ORT_WASM_BASE_DEV),
  },
}));
