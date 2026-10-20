import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as constants from '../src/version.js';
import { instantiateWasmBackend } from '../dist/wasm-backend.js';

const zlibDir = join(import.meta.dirname, '..', 'deps', 'zlib');
const header = readFileSync(join(zlibDir, 'zlib.h'), 'utf8');
const define = (name: string) => new RegExp(`#define ${name}\\s+("[^"]*"|-?\\d+)`).exec(header)![1]!;

describe('version constants', () => {
  it('ZLIB_VERSION matches deps/zlib/zlib.h', () => {
    expect(JSON.stringify(constants.ZLIB_VERSION)).toBe(define('ZLIB_VERSION'));
  });

  it('README.md and THIRD_PARTY_NOTICES.md name the bundled version (update-zlib.yml rewrites them)', () => {
    const doc = (name: string) => readFileSync(join(import.meta.dirname, '..', name), 'utf8');
    expect(doc('README.md')).toContain(`zlib v${constants.ZLIB_VERSION} `);
    expect(doc('README.md')).toContain(`\`'${constants.ZLIB_VERSION}'\``);
    expect(doc('THIRD_PARTY_NOTICES.md')).toContain(`zlib v${constants.ZLIB_VERSION} `);
  });

  it('level constants match zlib.h and deflate.c', () => {
    expect(constants.MIN_LEVEL).toBe(Number(define('Z_NO_COMPRESSION')));
    expect(constants.MAX_LEVEL).toBe(Number(define('Z_BEST_COMPRESSION')));
    const deflate = readFileSync(join(zlibDir, 'deflate.c'), 'utf8');
    expect(deflate).toContain(`if (level == Z_DEFAULT_COMPRESSION) level = ${constants.DEFAULT_LEVEL};`);
  });

  // zlibVersion() of the code actually linked, not the header. Node ships its own zlib (with a
  // different version string) and its headers are on the addon's include path: this fails if
  // either build picks that up instead of deps/zlib.
  it('both builds run the bundled zlib, not the one inside Node', async () => {
    const require = createRequire(import.meta.url);
    const addon = require('node-gyp-build')(join(import.meta.dirname, '..'));
    expect(addon.version).toBe(constants.ZLIB_VERSION);

    const wasm = await instantiateWasmBackend(new WebAssembly.Module(readFileSync(join(import.meta.dirname, '..', 'dist', 'gzip.wasm'))));
    expect(wasm.version).toBe(constants.ZLIB_VERSION);
  });
});
