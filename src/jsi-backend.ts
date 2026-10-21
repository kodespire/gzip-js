// React Native backend: the C++ TurboModule in cpp/ (the gjs C layer, as in the
// Node-API addon), reached through JSI. It returns ArrayBuffers that own the
// native output, and throws or rejects with errors carrying `gjsCode`.
import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DeflateParams, DStreamHandle, InflateParams } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): ArrayBuffer;
  pushAsync(chunk: Uint8Array, mode: number): Promise<ArrayBuffer>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): ArrayBuffer;
  pushAsync(chunk: Uint8Array): Promise<ArrayBuffer>;
  finish(): void;
  close(): void;
}

// Positional arguments, in the order cpp/KodespireGzipModule.cpp reads them.
type DeflateArgs = [format: number, level: number, windowBits: number, memLevel: number, strategy: number, dict: Uint8Array | null];
type InflateArgs = [format: number, dict: Uint8Array | null, maxOutput: number];

/** @internal What cpp/KodespireGzipModule.cpp exposes. */
export interface NativeModule {
  version(): string;
  compressSync(data: Uint8Array, ...args: DeflateArgs): ArrayBuffer;
  compress(data: Uint8Array, ...args: DeflateArgs): Promise<ArrayBuffer>;
  decompressSync(data: Uint8Array, ...args: InflateArgs): ArrayBuffer;
  decompress(data: Uint8Array, ...args: InflateArgs): Promise<ArrayBuffer>;
  createCStream(...args: DeflateArgs): NativeCStream;
  createDStream(...args: InflateArgs): NativeDStream;
}

const deflateArgs = (p: DeflateParams): DeflateArgs => [p.format, p.level, p.windowBits, p.memLevel, p.strategy, p.dictionary];
const inflateArgs = (p: InflateParams): InflateArgs => [p.format, p.dictionary, p.maxOutputSize];

const bytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

export function createJsiBackend(m: NativeModule): Backend {
  return {
    kind: 'native',
    version: m.version(),
    compressSync: wrapSync((data, p) => bytes(m.compressSync(data, ...deflateArgs(p)))),
    compress: (data, p) => m.compress(data, ...deflateArgs(p)).then(bytes, rethrowNative),
    decompressSync: wrapSync((data, p) => bytes(m.decompressSync(data, ...inflateArgs(p)))),
    decompress: (data, p) => m.decompress(data, ...inflateArgs(p)).then(bytes, rethrowNative),
    // The stream methods are plain functions bound to their native context.
    createCStream: wrapSync((p): CStreamHandle => {
      const { push, pushAsync, close } = m.createCStream(...deflateArgs(p));
      return {
        push: wrapSync((chunk, mode) => bytes(push(chunk, mode))),
        pushAsync: (chunk, mode) => pushAsync(chunk, mode).then(bytes, rethrowNative),
        close: wrapSync(() => close()),
      };
    }),
    createDStream: wrapSync((p): DStreamHandle => {
      const { push, pushAsync, finish, close } = m.createDStream(...inflateArgs(p));
      return {
        push: wrapSync((chunk) => bytes(push(chunk))),
        pushAsync: (chunk) => pushAsync(chunk).then(bytes, rethrowNative),
        finish: wrapSync(() => finish()),
        close: wrapSync(() => close()),
      };
    }),
  };
}
