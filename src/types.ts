// Shared types for the public API

export type BackendId = 'webgpu' | 'webnn' | 'wasm';
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
  webnn: boolean;
  wasm: boolean;
}

export interface ModelInfo {
  id: ModelId;
  displayName: string;
  task: 'text-to-image';
  supportedBackends: BackendId[];
  notes?: string;
}

export interface LoadOptions {
  backendPreference?: BackendId[];
  modelUrlOverrides?: Record<string, string>;
  onProgress?: (p: LoadProgress) => void;
  // Runtime dependency injection & configuration (robust, no CDN needed)
  ort?: unknown; // onnxruntime-web module instance (e.g., import('onnxruntime-web/webgpu'))
  tokenizerProvider?: () => Promise<(text: string, opts?: any) => Promise<{ input_ids: number[] }>>;
  wasmPaths?: string; // path to onnxruntime-web WASM assets
  wasmNumThreads?: number;
  wasmSimd?: boolean;
  modelBaseUrl?: string; // override default HF base for SD‑Turbo models
}

export interface LoadProgress {
  phase: 'loading';
  message?: string;
  pct?: number;
  bytesDownloaded?: number;
}

export type LoadResult =
  | { ok: true; backendUsed: BackendId; bytesDownloaded?: number }
  | { ok: false; reason: ErrorCode; message?: string };

export interface GenerateParams {
  model: ModelId;
  prompt: string;
  seed?: number; // supported for SD-Turbo only
  width?: number; // multiples of 64 for SD-Turbo
  height?: number; // multiples of 64 for SD-Turbo
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
