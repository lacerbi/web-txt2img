import type {
  Adapter,
  BackendId,
  Capabilities,
  ErrorCode,
  GenerateParams,
  GenerateResult,
  LoadOptions,
  LoadProgress,
  LoadResult,
  ModelId,
  ModelInfo,
} from './types.js';
export type { Capabilities, BackendId, ModelId, ModelInfo, LoadOptions, LoadResult, GenerateParams, GenerateResult } from './types.js';

import { detectCapabilities as _detectCapabilities, listBackends as _listBackends } from './capabilities.js';
import { getModelInfo, listSupportedModels as _listSupportedModels, getRegistryEntry, defaultBackendPreferenceFor } from './registry.js';
import * as cache from './cache.js';

// Adapter instances
const adapters = new Map<ModelId, Adapter>();
let cachedCapabilities: Capabilities | null = null;

export async function detectCapabilities(): Promise<Capabilities> {
  if (!cachedCapabilities) cachedCapabilities = await _detectCapabilities();
  return cachedCapabilities;
}

export function listBackends(): BackendId[] {
  return _listBackends();
}

export function listSupportedModels(): ModelInfo[] {
  return _listSupportedModels();
}

export { getModelInfo };

function adapterFor(id: ModelId): Adapter {
  let a = adapters.get(id);
  if (!a) {
    a = getRegistryEntry(id).createAdapter();
    adapters.set(id, a);
  }
  return a;
}

export async function loadModel(id: ModelId, options: LoadOptions = {}): Promise<LoadResult> {
  const caps = await detectCapabilities();
  const a = adapterFor(id);
  const supported = a.checkSupport(caps);
  if (supported.length === 0) {
    return { ok: false, reason: id === 'janus-pro-1b' ? 'webgpu_unsupported' : 'backend_unavailable', message: 'No supported backend detected' };
  }
  const backendPreference = options.backendPreference ?? defaultBackendPreferenceFor(id);
  const chosen = backendPreference.find((b) => supported.includes(b));
  if (!chosen) return { ok: false, reason: 'backend_unavailable', message: 'No backend available matching preference' };
  return a.load({ ...options, backendPreference });
}

export function isModelLoaded(id: ModelId): boolean {
  return adapterFor(id).isLoaded();
}

export async function unloadModel(id: ModelId): Promise<void> {
  await adapterFor(id).unload();
}

export async function purgeModelCache(id: ModelId): Promise<void> {
  await adapterFor(id).purgeCache();
}

export async function purgeAllCaches(): Promise<void> {
  await cache.purgeAllCaches();
}

export async function generateImage(params: GenerateParams): Promise<GenerateResult> {
  const a = adapterFor(params.model);
  if (!a.isLoaded()) return { ok: false, reason: 'model_not_loaded', message: 'Call loadModel() first' };
  const { model, ...rest } = params as any;
  return a.generate(rest);
}
