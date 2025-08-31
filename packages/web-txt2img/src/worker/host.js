// Dev shim so source can point to './host.js' while Vite resolves TS.
// In production builds, 'host.ts' compiles to dist/worker/host.js.
import './host.ts';
export {};

