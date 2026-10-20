export type GzipErrorCode =
  /**
   * zlib rejected the data: not in the expected format, corrupt, a CRC-32, length or Adler-32
   * mismatch, or a missing or wrong dictionary.
   */
  | 'ERR_GZIP_LIBRARY'
  /** The input ended before the end of a gzip member or zlib/raw stream, or was empty. */
  | 'ERR_GZIP_TRUNCATED'
  /** Bytes other than zero padding follow the last gzip member, or anything follows a zlib/raw stream. */
  | 'ERR_GZIP_TRAILING_DATA'
  /** Decompressed output would exceed `maxOutputSize`. */
  | 'ERR_GZIP_OUTPUT_LIMIT'
  | 'ERR_GZIP_OUT_OF_MEMORY'
  | 'ERR_GZIP_INVALID_ARGUMENT'
  /** A synchronous call was made before the WebAssembly module was loaded with `init()`. */
  | 'ERR_GZIP_NOT_INITIALIZED';

export class GzipError extends Error {
  readonly code: GzipErrorCode;

  constructor(code: GzipErrorCode, message: string) {
    super(message);
    this.name = 'GzipError';
    this.code = code;
  }
}

// Indexed by the GJS_ERR_* values in csrc/gjs.h.
const CODES: readonly (GzipErrorCode | undefined)[] = [
  undefined,
  'ERR_GZIP_LIBRARY',
  'ERR_GZIP_TRUNCATED',
  'ERR_GZIP_OUTPUT_LIMIT',
  'ERR_GZIP_OUT_OF_MEMORY',
  'ERR_GZIP_INVALID_ARGUMENT',
  'ERR_GZIP_TRAILING_DATA',
];

export function errorFromCore(rc: number, detail: string): GzipError {
  const code = CODES[rc] ?? 'ERR_GZIP_LIBRARY';
  return new GzipError(code, code === 'ERR_GZIP_LIBRARY' ? `zlib: ${detail}` : detail);
}

/** Converts an error thrown by the native addon into a GzipError with a JavaScript stack. */
export function rethrowNative(error: unknown): never {
  if (error !== null && typeof error === 'object' && typeof (error as { gjsCode?: unknown }).gjsCode === 'number') {
    throw errorFromCore((error as { gjsCode: number }).gjsCode, (error as Error).message);
  }
  throw error;
}
