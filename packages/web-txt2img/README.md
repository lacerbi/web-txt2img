# web-txt2img

Generate images from text prompts directly in the browser using open-weights AI models. No server required - all inference runs locally using WebGPU acceleration.

## Features

- 🚀 **100% browser-based** - No server, API keys, or network requests for inference
- 🎨 **Multiple models** - SD-Turbo (fast) and Janus-Pro-1B (quality)
- ⚡ **WebGPU acceleration** - Hardware-accelerated inference for fast generation
- 🔄 **Worker-based** - Non-blocking UI with progress tracking and cancellation
- 💾 **Smart caching** - Models cached locally after first download

## Installation

```bash
npm i web-txt2img @xenova/transformers
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

// Load SD-Turbo model with WebGPU
await client.load('sd-turbo', { 
  backendPreference: ['webgpu'] // WebGPU is required for reliable operation
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

## WebGPU Requirements

This library requires WebGPU support in your browser:
- Chrome/Edge 113+ with WebGPU enabled
- Safari Technology Preview with WebGPU feature flag
- Firefox Nightly with WebGPU enabled

You can verify WebGPU support:
```js
const caps = await client.detect();
if (!caps.webgpu) {
  console.error('WebGPU not supported in this browser');
}
```

## Supported Models

- **`sd-turbo`** - Fast single-step diffusion (512×512, ~2.3GB download)
  - Backend: WebGPU (required)
- **`janus-pro-1b`** - Higher quality autoregressive (~2.2GB)
  - Backend: WebGPU only

## Documentation

- [Full Documentation](https://github.com/lacerbi/web-txt2img#readme)
- [Live Demo](https://lacerbi.github.io/web-txt2img/)
- [Examples](https://github.com/lacerbi/web-txt2img/tree/main/examples)
- [API Reference](https://github.com/lacerbi/web-txt2img/blob/main/docs/DEVELOPER_GUIDE.md)

## Requirements

- Modern WebGPU-enabled browser (Chrome/Edge 113+, Safari Technology Preview, or Firefox Nightly with WebGPU)
- GPU with WebGPU support

## Note on WASM Support

While a WASM fallback exists in the API for compatibility reasons, it is experimental, untested, and not recommended for production use. This library is designed and optimized for WebGPU.

## License

MIT
