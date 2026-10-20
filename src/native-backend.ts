import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DeflateParams, DStreamHandle, InflateParams } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

// Positional arguments, in the order csrc/addon.cc reads them.
type DeflateArgs = [format: number, level: number, windowBits: number, memLevel: number, strategy: number, dict: Uint8Array | null];
type InflateArgs = [format: number, dict: Uint8Array | null, maxOutput: number];

interface NativeAddon {
  version: string;
  compressSync(data: Uint8Array, ...args: DeflateArgs): Uint8Array;
  compress(data: Uint8Array, ...args: DeflateArgs): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, ...args: InflateArgs): Uint8Array;
  decompress(data: Uint8Array, ...args: InflateArgs): Promise<Uint8Array>;
  CStream: new (...args: DeflateArgs) => NativeCStream;
  DStream: new (...args: InflateArgs) => NativeDStream;
}

const deflateArgs = (p: DeflateParams): DeflateArgs => [p.format, p.level, p.windowBits, p.memLevel, p.strategy, p.dictionary];
const inflateArgs = (p: InflateParams): InflateArgs => [p.format, p.dictionary, p.maxOutputSize];

// The addon returns Node Buffers; expose plain Uint8Array views (no copy) so results
// behave the same in every runtime.
const view = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

/** Loads the prebuilt (or locally built) addon. Throws if none matches this platform. */
export function loadNativeBackend(): Backend {
  const require = createRequire(import.meta.url);
  const nodeGypBuild = require('node-gyp-build') as (dir: string) => NativeAddon;
  const addon = nodeGypBuild(fileURLToPath(new URL('..', import.meta.url)));

  return {
    kind: 'native',
    version: addon.version,
    compressSync: wrapSync((data, p) => view(addon.compressSync(data, ...deflateArgs(p)))),
    compress: (data, p) => addon.compress(data, ...deflateArgs(p)).then(view, rethrowNative),
    decompressSync: wrapSync((data, p) => view(addon.decompressSync(data, ...inflateArgs(p)))),
    decompress: (data, p) => addon.decompress(data, ...inflateArgs(p)).then(view, rethrowNative),
    createCStream: wrapSync((p): CStreamHandle => {
      const s = new addon.CStream(...deflateArgs(p));
      return {
        push: wrapSync((chunk, mode) => view(s.push(chunk, mode))),
        pushAsync: (chunk, mode) => s.pushAsync(chunk, mode).then(view, rethrowNative),
        close: wrapSync(() => s.close()),
      };
    }),
    createDStream: wrapSync((p): DStreamHandle => {
      const s = new addon.DStream(...inflateArgs(p));
      return {
        push: wrapSync((chunk) => view(s.push(chunk))),
        pushAsync: (chunk) => s.pushAsync(chunk).then(view, rethrowNative),
        finish: wrapSync(() => s.finish()),
        close: wrapSync(() => s.close()),
      };
    }),
  };
}
