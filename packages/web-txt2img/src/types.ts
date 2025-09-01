// Shared types for the public API

export type BackendId = 'webgpu' | 'wasm';
export type ModelId = 'sd-turbo' | 'janus-pro-1b';

export type ErrorCode =
  | 'webgpu_unsupported'
  | 'backend_unavailable'
  | 'model_not_loaded'
  | 'unsupported_option'
  | 'cancelled'
  | 'internal_error';

export interface Capabilities {
  webgpu: boolean;
  shaderF16: boolean;
  wasm: boolean;
}

export interface ModelInfo {
  id: ModelId;
  displayName: string;
  task: 'text-to-image';
  supportedBackends: BackendId[];
  notes?: string;
  // Approximate model size information for UX purposes (optional, non-breaking)
  sizeBytesApprox?: number;
  sizeGBApprox?: number;
  sizeNotes?: string;
}

export interface LoadOptions {
  backendPreference?: BackendId[];
  onProgress?: (p: LoadProgress) => void;
  // Runtime dependency injection & configuration (robust, no CDN needed)
  ort?: unknown; // onnxruntime-web module instance (e.g., import('onnxruntime-web/webgpu'))
  tokenizerProvider?: () => Promise<(text: string, opts?: any) => Promise<{ input_ids: number[] }>>;
  wasmPaths?: string; // path to onnxruntime-web WASM assets
  wasmNumThreads?: number;
  wasmSimd?: boolean;
  modelBaseUrl?: string; // override default HF base for SD‑Turbo models
  // Approximate total model bytes for standardized load progress; injected from registry
  approxTotalBytes?: number;
}

export interface LoadProgress {
  phase: 'loading';
  message?: string;
  pct?: number;
  bytesDownloaded?: number;
  // Standardized total for computing % across adapters (optional)
  totalBytesExpected?: number;
  // Optional extra context for UIs
  asset?: string;
  accuracy?: 'exact' | 'approximate';
}

export type LoadResult =
  | { ok: true; backendUsed: BackendId; bytesDownloaded?: number }
  | { ok: false; reason: ErrorCode; message?: string };

export interface GenerateParams {
  model: ModelId;
  prompt: string;
  seed?: number; // supported for SD-Turbo only
  width?: number; // SD-Turbo: 512 only in v1
  height?: number; // SD-Turbo: 512 only in v1
  signal?: AbortSignal;
  onProgress?: (event: GenerationProgressEvent) => void;
}

export type GenerationProgressPhase =
  | 'loading'
  | 'tokenizing'
  | 'encoding'
  | 'denoising'
  | 'decoding'
  | 'image_tokens'
  | 'complete';

export interface GenerationProgressEvent {
  phase: GenerationProgressPhase;
  pct?: number;
  // model-specific payloads (narrow at call sites)
  [key: string]: unknown;
}

export type GenerateResult =
  | { ok: true; blob: Blob; timeMs: number }
  | { ok: false; reason: ErrorCode; message?: string };

export interface Adapter {
  readonly id: ModelId;
  checkSupport(capabilities: Capabilities): BackendId[];
  load(options: Required<Pick<LoadOptions, 'backendPreference'>> & LoadOptions): Promise<LoadResult>;
  isLoaded(): boolean;
  generate(params: Omit<GenerateParams, 'model'>): Promise<GenerateResult>;
  unload(): Promise<void>;
  purgeCache(): Promise<void>;
}

export interface RegistryEntry extends ModelInfo {
  createAdapter(): Adapter;
}
