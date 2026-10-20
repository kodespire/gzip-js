// Builds out/wasm/gzip.wasm from the same C sources as the native addon.
// Requires Emscripten (emcc) on PATH: https://emscripten.org/docs/getting_started/
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { sources } = require('./zlib-sources.cjs');

const exported = [
  'malloc',
  'free',
  'gjs_buf_free',
  'gjs_compress',
  'gjs_decompress',
  'gjs_cstream_create',
  'gjs_cstream_push',
  'gjs_cstream_free',
  'gjs_dstream_create',
  'gjs_dstream_push',
  'gjs_dstream_finish',
  'gjs_dstream_free',
  'gjs_version',
].map((name) => `_${name}`);

const out = join(root, 'out', 'wasm', 'gzip.wasm');
mkdirSync(dirname(out), { recursive: true });

const args = [
  '-O3',
  '-flto',
  '-DNDEBUG',
  '-DZ_PREFIX',
  '-DZLIB_CONST',
  'csrc/gjs.c',
  ...sources(),
  '--no-entry',
  // A plain .wasm with no Emscripten JS glue; src/wasm-backend.ts is the loader.
  '-sSTANDALONE_WASM=1',
  '-sFILESYSTEM=0',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=2MB',
  '-sMAXIMUM_MEMORY=4GB',
  '-sSTACK_SIZE=256KB',
  '-sERROR_ON_UNDEFINED_SYMBOLS=1',
  `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
  '-o',
  out,
];

try {
  execFileSync('emcc', args, { cwd: root, stdio: 'inherit' });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('emcc not found. Install Emscripten and run `source <emsdk>/emsdk_env.sh` first.');
    process.exit(1);
  }
  throw error;
}
console.log(`built ${out} (${statSync(out).size} bytes)`);
