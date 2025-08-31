# web-txt2img (package)

Browser-only text-to-image generation library with a worker-first API.

Install

- npm i web-txt2img onnxruntime-web @xenova/transformers
- For Janus-Pro-1B support: npm i @huggingface/transformers

Quickstart

```ts
import { Txt2ImgWorkerClient } from 'web-txt2img';
const client = Txt2ImgWorkerClient.createDefault();
await client.load('sd-turbo', { backendPreference: ['webgpu','wasm'], wasmPaths: '/ort/' });
const { promise } = client.generate({ model: 'sd-turbo', prompt: 'a cozy cabin, watercolor', seed: 42 });
const res = await promise;
if (res.ok) document.querySelector('img').src = URL.createObjectURL(res.blob);
```

Docs

See the repository README and docs/DEVELOPER_GUIDE.md for full details.

