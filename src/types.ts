/** Binary input accepted everywhere: any ArrayBuffer, typed array, DataView or Node Buffer. */
export type Bytes = ArrayBuffer | ArrayBufferView;

/**
 * The container around the deflate data:
 * - `'gzip'`: RFC 1952, as written by `gzip` and `CompressionStream('gzip')`. CRC-32 and length checked.
 * - `'zlib'`: RFC 1950, as in `CompressionStream('deflate')` and HTTP `Content-Encoding: deflate`. Adler-32 checked.
 * - `'deflate-raw'`: RFC 1951 with no header or checksum, as in `CompressionStream('deflate-raw')` and zip files.
 */
export type Format = 'gzip' | 'zlib' | 'deflate-raw';

/**
 * How deflate searches for matches (zlib's `strategy` parameter):
 * - `'default'`: normal data.
 * - `'filtered'`: data from a filter or predictor, mostly small values with a random distribution.
 * - `'huffman-only'`: no string matching, Huffman coding only.
 * - `'rle'`: matches only at distance 1 (run-length encoding); fast, good for PNG image data.
 * - `'fixed'`: never use dynamic Huffman codes.
 */
export type Strategy = 'default' | 'filtered' | 'huffman-only' | 'rle' | 'fixed';

export interface CompressOptions {
  /** Output format. Defaults to `'gzip'`. */
  format?: Format;
  /** Compression level, from 0 (no compression, stored blocks) to 9 (smallest). Defaults to 6, the zlib default. */
  level?: number;
  /**
   * Memory for the compression state, from 1 (least memory, slower, worse ratio) to 9 (fastest).
   * Defaults to 8, the zlib default.
   */
  memLevel?: number;
  /**
   * Window size as a power of two, from 9 (512 bytes) to 15 (32 KiB): how far back deflate looks for
   * matches. Smaller windows use less memory but find fewer matches. Defaults to 15.
   */
  windowBits?: number;
  /** Match-finding strategy. Defaults to `'default'`. */
  strategy?: Strategy;
  /**
   * Preset dictionary: bytes likely to occur in the data. Only for `'zlib'` and `'deflate-raw'`; the gzip
   * format has no way to use one. The same dictionary is required to decompress.
   */
  dictionary?: Bytes;
}

export interface DecompressOptions {
  /** Input format. Defaults to `'gzip'`. */
  format?: Format;
  /**
   * Throw ERR_GZIP_OUTPUT_LIMIT instead of producing more than this many bytes.
   * Set it whenever the input is untrusted. Defaults to Infinity.
   */
  maxOutputSize?: number;
  /** Dictionary the data was compressed with. Only for `'zlib'` and `'deflate-raw'`. */
  dictionary?: Bytes;
}

/** Where the WebAssembly module comes from, for `init()`. */
export type WasmSource =
  | WebAssembly.Module
  | Bytes
  | URL
  | string
  | Response
  | PromiseLike<Response>;

export type BackendKind = 'native' | 'wasm';

/** @internal Mode values match GJS_MODE_* in csrc/gjs.h. */
export const MODE_CONTINUE = 0;
/** @internal */
export const MODE_END = 2;

/** @internal Compression parameters, as numbers matching csrc/gjs.h and zlib.h. */
export interface DeflateParams {
  format: number;
  level: number;
  windowBits: number;
  memLevel: number;
  strategy: number;
  dictionary: Uint8Array | null;
}

/** @internal Decompression parameters, as numbers matching csrc/gjs.h. */
export interface InflateParams {
  format: number;
  dictionary: Uint8Array | null;
  maxOutputSize: number;
}

/** @internal */
export interface CStreamHandle {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

/** @internal */
export interface DStreamHandle {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

/** @internal What each backend (native addon, WebAssembly) implements. Errors are GzipError. */
export interface Backend {
  readonly kind: BackendKind;
  /** zlibVersion() of the compiled library. */
  readonly version: string;
  compressSync(data: Uint8Array, p: DeflateParams): Uint8Array;
  compress(data: Uint8Array, p: DeflateParams): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, p: InflateParams): Uint8Array;
  decompress(data: Uint8Array, p: InflateParams): Promise<Uint8Array>;
  createCStream(p: DeflateParams): CStreamHandle;
  createDStream(p: InflateParams): DStreamHandle;
}

/** @internal How an entry point supplies its backend to the public API. */
export interface BackendProvider {
  get(): Promise<Backend>;
  getSync(): Backend;
  init(source?: WasmSource): Promise<void>;
  kind(): BackendKind;
}
