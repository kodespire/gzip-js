// Cloudflare Workers entry. Workers cannot compile WebAssembly from bytes at
// runtime, so the module is imported statically and bundled by wrangler.
// Copied to dist/ as-is; types come from entry-wasm.d.ts.
// Keep the export list in sync with entry-wasm.ts, entry-node.ts and entry-react-native.ts.
import wasmModule from './gzip.wasm';

import { createApi } from './api.js';
import { compileFrom } from './wasm-source.js';
import { createWasmProvider } from './wasm-provider.js';

export const {
  compress,
  compressSync,
  decompress,
  decompressSync,
  createCompressStream,
  createDecompressStream,
  init,
  activeBackend,
} = createApi(
  createWasmProvider(
    (source) => compileFrom(source ?? wasmModule),
    () => wasmModule,
  ),
);

export { isGzip } from './api.js';
export { GzipError } from './errors.js';
export { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL, ZLIB_VERSION } from './version.js';
