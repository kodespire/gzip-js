// WebAssembly entry: browsers, Deno, and anything without the native addon.
// Keep the export list in sync with entry-node.ts and entry-workerd.js.
import { compileWasm, compileWasmSync } from '#load-wasm';

import { createApi } from './api.js';
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
} = createApi(createWasmProvider(compileWasm, compileWasmSync));

export { isGzip } from './api.js';
export { GzipError, type GzipErrorCode } from './errors.js';
export type { BackendKind, Bytes, CompressOptions, DecompressOptions, Format, Strategy, WasmSource } from './types.js';
export { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL, ZLIB_VERSION } from './version.js';
