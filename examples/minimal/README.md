Minimal self‑contained example (no CDN)

Dev setup

- Install deps in the repo root:
  - npm i
  - If you don’t have TypeScript installed: npm i -D typescript
- Dev (Vite): no manual copy needed — the example points wasmPaths to '/node_modules/onnxruntime-web/dist/'.
- Production build: copy ONNX Runtime Web assets so they are served at '/ort/':
  - mkdir -p public/ort
  - cp node_modules/onnxruntime-web/dist/ort-wasm*.* public/ort/
    (copies .wasm and .jsep.mjs files)
- Start dev server:
  - npm run dev
  - Vite serves at http://localhost:5173
- Open the example:
  - http://localhost:5173/examples/minimal/

Notes

- WebGPU is preferred (backendPreference ['webgpu','wasm']); falls back to WASM.
- The example sets wasmPaths dynamically:
  - Dev: '/node_modules/onnxruntime-web/dist/' (works with Vite dev server)
  - Prod: '/ort/' (served from public)
- For maximum WASM performance enable SIMD/threads:
  - Serve with COOP/COEP headers (cross‑origin isolated) to unlock threads.
  - Adjust wasmNumThreads/wasmSimd in the example (see main.js).
- You can also inject your own ort/tokenizer via loadModel options if desired.

Automation (optional)

- You can keep asset copy automated via npm scripts if you prefer:
  - postinstall → prepare:ort-assets
  - predev → prepare:ort-assets
