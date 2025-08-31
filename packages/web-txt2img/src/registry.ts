import type { BackendId, ModelId, ModelInfo, RegistryEntry } from './types.js';
import { SDTurboAdapter } from './adapters/sd-turbo.js';
import { JanusProAdapter } from './adapters/janus-pro.js';

const REGISTRY: RegistryEntry[] = [
  {
    id: 'sd-turbo',
    displayName: 'SD-Turbo (ONNX Runtime Web)',
    task: 'text-to-image',
    supportedBackends: ['webgpu', 'webnn', 'wasm'],
    notes: '512×512 only in v1; seed supported.',
    sizeBytesApprox: 2398 * 1024 * 1024,
    sizeGBApprox: 2.34,
    sizeNotes: 'UNet ~640MB, text_encoder ~1700MB, vae_decoder ~95MB',
    createAdapter: () => new SDTurboAdapter(),
  },
  {
    id: 'janus-pro-1b',
    displayName: 'Janus-Pro-1B (Transformers.js)',
    task: 'text-to-image',
    supportedBackends: ['webgpu'],
    notes: 'WebGPU only in v1; seed unsupported.',
    sizeBytesApprox: 2305 * 1024 * 1024,
    sizeGBApprox: 2.25,
    sizeNotes: 'Mixed-precision ONNX; varies slightly by device/dtype',
    createAdapter: () => new JanusProAdapter(),
  },
];

export function listSupportedModels(): ModelInfo[] {
  return REGISTRY.map(({ createAdapter, ...info }) => info);
}

export function getModelInfo(id: ModelId): ModelInfo {
  const found = REGISTRY.find((m) => m.id === id);
  if (!found) throw new Error(`Unknown model id: ${id}`);
  const { createAdapter, ...info } = found;
  return info;
}

export function getRegistryEntry(id: ModelId): RegistryEntry {
  const found = REGISTRY.find((m) => m.id === id);
  if (!found) throw new Error(`Unknown model id: ${id}`);
  return found;
}

export function defaultBackendPreferenceFor(id: ModelId): BackendId[] {
  switch (id) {
    case 'sd-turbo':
      return ['webgpu', 'webnn', 'wasm'];
    case 'janus-pro-1b':
      return ['webgpu'];
  }
}
