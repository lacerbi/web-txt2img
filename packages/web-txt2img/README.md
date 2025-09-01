# web-txt2img

Generate images from text prompts directly in the browser using open-weights AI models. No server required - all inference runs locally using WebGPU, WebNN, or WebAssembly.

## Features

- 🚀 **100% browser-based** - No server, API keys, or network requests for inference
- 🎨 **Multiple models** - SD-Turbo (fast) and Janus-Pro-1B (quality)
- ⚡ **WebGPU acceleration** - Hardware-accelerated inference with automatic fallback
- 🔄 **Worker-based** - Non-blocking UI with progress tracking and cancellation
- 💾 **Smart caching** - Models cached locally after first download

## Installation

```bash
npm i web-txt2img onnxruntime-web @xenova/transformers
```

For Janus-Pro-1B support, also install:
```bash
npm i @huggingface/transformers
```

## Quick Start

```ts
import { Txt2ImgWorkerClient } from 'web-txt2img';

// Create worker client
const client = Txt2ImgWorkerClient.createDefault();

// Load SD-Turbo model
await client.load('sd-turbo', { 
  backendPreference: ['webgpu', 'wasm'],
  wasmPaths: '/ort/' // Important: serve ONNX Runtime WASM files here
});

// Generate image
const { promise } = client.generate({ 
  prompt: 'a cozy cabin in the woods, watercolor',
  seed: 42 
});

const result = await promise;
if (result.ok) {
  const url = URL.createObjectURL(result.blob);
  document.querySelector('img').src = url;
}
```

## Important: WASM Assets

For SD-Turbo, copy ONNX Runtime WASM files to your public directory:

```bash
cp node_modules/onnxruntime-web/dist/ort-wasm*.* public/ort/
```

Then set `wasmPaths: '/ort/'` when loading the model.

## Supported Models

- **`sd-turbo`** - Fast single-step diffusion (512×512, ~2.3GB download)
- **`janus-pro-1b`** - Higher quality autoregressive (WebGPU only, ~2.2GB)

## Documentation

- [Full Documentation](https://github.com/lacerbi/web-txt2img#readme)
- [Live Demo](https://lacerbi.github.io/web-txt2img/)
- [Examples](https://github.com/lacerbi/web-txt2img/tree/main/examples)
- [API Reference](https://github.com/lacerbi/web-txt2img/blob/main/docs/DEVELOPER_GUIDE.md)

## Requirements

- Modern browser with WebGPU support (Chrome/Edge 113+)
- Falls back to WebAssembly on older browsers

## License

MIT
