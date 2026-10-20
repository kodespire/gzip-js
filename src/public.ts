// The documented public API. This file only declares; each entry point
// (entry-node.ts, entry-wasm.ts, entry-workerd.js) implements it, and
// test/types.test-d.ts checks that they match. package.json points "types" here.
import type { BackendKind, Bytes, CompressOptions, DecompressOptions, WasmSource } from './types.js';

/**
 * Compresses `data` into one gzip member, or one zlib or raw deflate stream with `format`.
 *
 * @param data Bytes to compress. Strings are encoded as UTF-8.
 * @param options Options, or just a compression level (`compress(data, 9)`).
 * @example
 * const packed = await compress(data, { level: 9 });
 * const zlibbed = await compress(data, { format: 'zlib' });
 */
export declare function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array>;

/**
 * Synchronous {@link compress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array;

/**
 * Decompresses `data`. For gzip, every member is decoded and the results are joined, as `gunzip`
 * does; zero bytes after the last member are ignored. For zlib and raw deflate, `data` must be
 * exactly one stream.
 *
 * Throws a {@link GzipError} with code `ERR_GZIP_TRUNCATED` if the input is empty or ends partway
 * through a member or stream, `ERR_GZIP_TRAILING_DATA` if other bytes follow it,
 * `ERR_GZIP_OUTPUT_LIMIT` if the output would exceed `maxOutputSize`, and `ERR_GZIP_LIBRARY` if the
 * data is corrupt, fails its CRC-32, length or Adler-32 check, or is not in the given format.
 * It never returns partial output.
 *
 * @example
 * const data = await decompress(packed, { maxOutputSize: 64 * 1024 * 1024 });
 */
export declare function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array>;

/**
 * Synchronous {@link decompress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array;

/**
 * A TransformStream that compresses everything written to it into one gzip member (or zlib or raw
 * deflate stream).
 *
 * @example
 * const compressed = file.stream().pipeThrough(createCompressStream({ level: 9 }));
 */
export declare function createCompressStream(options?: CompressOptions | number): TransformStream<Bytes, Uint8Array>;

/**
 * A TransformStream that decompresses, with the same rules as {@link decompress}. The stream errors
 * if the input is corrupt, ends partway through a member or stream, is followed by other data, or
 * exceeds `maxOutputSize` in total.
 *
 * @example
 * const body = response.body.pipeThrough(createDecompressStream());
 */
export declare function createDecompressStream(options?: DecompressOptions): TransformStream<Bytes, Uint8Array>;

/**
 * Loads the backend ahead of time. Needed before the synchronous functions in browsers, Deno and
 * Workers; optional elsewhere.
 *
 * @param source Where to load `gzip.wasm` from (URL, path, `Response`, bytes or a compiled
 *   `WebAssembly.Module`). Ignored when the native addon is in use.
 */
export declare function init(source?: WasmSource): Promise<void>;

/** Which implementation is running: `'native'` (Node-API addon) or `'wasm'`. */
export declare function activeBackend(): BackendKind;

export { isGzip } from './api.js';
export { GzipError, type GzipErrorCode } from './errors.js';
export type { BackendKind, Bytes, CompressOptions, DecompressOptions, Format, Strategy, WasmSource } from './types.js';
export { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL, ZLIB_VERSION } from './version.js';
