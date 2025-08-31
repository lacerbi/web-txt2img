Vanilla example using the Worker client

Dev setup

- From the repo root (workspace):
  - npm i
  - Build library once: npm run build:lib
  - Start dev: npm run dev:vanilla
  - Vite serves at http://localhost:5173

Notes

- WebGPU is preferred (backendPreference ['webgpu','wasm']); falls back to WASM.
- Uses the Worker client (`Txt2ImgWorkerClient.createDefault()`), offloading generation to a module worker with single‑flight + single‑slot queue.
- WASM assets (onnxruntime-web) are served differently in dev vs prod:
  - Dev (Vite): the app points `wasmPaths` to the package dist folder via an absolute `/@fs/.../node_modules/onnxruntime-web/dist/` path (no import from `/public`).
  - Prod: assets are copied to `public/ort/` and the app points `wasmPaths` to `${import.meta.env.BASE_URL}ort/`.
- For best WASM performance: serve with COOP/COEP headers to enable threads.
- Janus-Pro-1B requires WebGPU and `@huggingface/transformers` installed.

GitHub Pages

- The example has its own `vite.config.ts` with a `base` controlled by `BASE_PATH`.
- The provided GitHub Action sets `BASE_PATH` to `/<repo-name>/` and deploys the built `dist`.
