import type { Capabilities } from './types.js';

export async function detectCapabilities(): Promise<Capabilities> {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as any).gpu;
  let shaderF16 = false;
  if (hasWebGPU) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter?.();
      shaderF16 = !!adapter?.features?.has?.('shader-f16');
    } catch {
      shaderF16 = false;
    }
  }
  const webnn = typeof navigator !== 'undefined' && 'ml' in navigator;
  const wasm = true;
  return { webgpu: hasWebGPU, shaderF16, webnn, wasm };
}

export function listBackends(): Array<'webgpu' | 'webnn' | 'wasm'> {
  return ['webgpu', 'webnn', 'wasm'];
}
