Vanilla example using the Worker client

Dev setup

- From the repo root (workspace):
  - npm i
  - Build library once: npm run build:lib
  - Start dev: npm run dev:vanilla
  - Vite serves at http://localhost:5173

Notes

- WebGPU is required for all models (backendPreference ['webgpu']).
- Uses the Worker client (`Txt2ImgWorkerClient.createDefault()`), offloading generation to a module worker with single‑flight + single‑slot queue.
- Both SD-Turbo and Janus-Pro-1B require WebGPU-enabled browsers (Chrome/Edge 113+).
- Janus-Pro-1B additionally requires `@huggingface/transformers` installed.
- Note: While WASM fallback exists in the API, it is experimental and not tested.

GitHub Pages

- The example has its own `vite.config.ts` with a `base` controlled by `BASE_PATH`.
- The provided GitHub Action sets `BASE_PATH` to `/<repo-name>/` and deploys the built `dist`.
