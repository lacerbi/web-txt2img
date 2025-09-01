# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

web-txt2img is a browser-only JavaScript/TypeScript library that generates images from text prompts using AI models (SD-Turbo, Janus-Pro-1B) running entirely client-side via WebGPU.

## Commands

### Development
```bash
# Install all workspace dependencies (run from root)
npm install

# Build the library (required before running examples)
npm run build:lib

# Start development server with hot reload (builds lib + starts example)
npm run dev:vanilla

# Type check the entire workspace
npm run typecheck

# Clean all dist directories
npm run clean
```

### Production Build
```bash
# Build library + example for production
npm run build:vanilla

# Preview production build
cd examples/vanilla-worker && npm run preview
```

### Working with Individual Packages
```bash
# Build only the library
cd packages/web-txt2img && npm run build

# Run only the example dev server (assumes library is built)
cd examples/vanilla-worker && npm run dev
```

## Architecture

### Workspace Structure
This is an npm workspaces monorepo with two packages:
- `packages/web-txt2img/` - Main library (published to npm)
- `examples/vanilla-worker/` - Example implementation

### Core Design: Worker-Based Architecture

The library uses a sophisticated worker architecture to run AI models in background threads:

1. **Client** (`src/worker/client.ts`) - Main thread API that applications use
2. **Host** (`src/worker/host.ts`) - Worker thread that loads models and runs inference
3. **Protocol** (`src/worker/protocol.ts`) - Type-safe message passing between threads

Key worker behaviors:
- Single loaded model at a time (enforced by worker)
- Single-flight execution with single-slot queue
- Busy policies: `'reject'`, `'abort_and_queue'`, `'queue'`
- Debouncing support for rapid user input
- AbortController-based cancellation

### Model Adapter System

Each AI model is implemented as an adapter (`src/adapters/`):
- **Interface**: All adapters implement `ModelAdapter` from `types.ts`
- **Registry**: `registry.ts` manages model metadata and factory functions
- **SD-Turbo**: Uses ONNX Runtime Web with WebGPU backend (WASM exists in API but is experimental/untested)
- **Janus-Pro-1B**: Uses Transformers.js, WebGPU-only

### Critical Implementation Details

#### WebGPU Requirements
All models require WebGPU support. Ensure browser compatibility:
- Chrome/Edge 113+ with WebGPU enabled
- Safari Technology Preview with WebGPU feature flag
- Firefox Nightly with WebGPU enabled

Note: While WASM fallback exists in the API, it is experimental and not recommended.

#### Dynamic Dependency Loading
The library uses dynamic imports for optional dependencies:
- `onnxruntime-web` - Only loaded when using SD-Turbo
- `@xenova/transformers` or `@huggingface/transformers` - For tokenization/Janus
- Allows dependency injection via `LoadOptions`

#### Progress Reporting
Standardized progress events with:
- `pct`: percentage (0-100)
- `bytesDownloaded`/`totalBytesExpected`: when available
- `phase`: current operation phase
- `message`: human-readable status

## Model Support

### SD-Turbo (`'sd-turbo'`)
- Fixed 512×512 resolution
- Seed support for deterministic generation
- Backend: WebGPU (required for reliable operation)
- ~2.34 GB total download

### Janus-Pro-1B (`'janus-pro-1b'`)
- WebGPU-only (no fallback)
- Variable resolution support
- No seed support
- ~2.25 GB download

## Key Files to Understand

When modifying core functionality:
1. `packages/web-txt2img/src/types.ts` - All core type definitions
2. `packages/web-txt2img/src/registry.ts` - Model registration and metadata
3. `packages/web-txt2img/src/worker/protocol.ts` - Worker communication protocol
4. `packages/web-txt2img/src/adapters/*.ts` - Model-specific implementations

## TypeScript Configuration

- Target: ES2021
- Module: ESNext with Node resolution
- Strict mode enabled
- Use `.js` extensions in imports (ESM requirement)

## Important Patterns

1. **Result Types**: Functions return `{ ok: boolean, ... }` objects instead of throwing
2. **Capability Detection**: Check browser features before attempting operations
3. **Cache Management**: Models cached in browser Cache Storage, use `purge()` to clear
4. **Backend Selection**: Use WebGPU for all models - WASM fallback is experimental