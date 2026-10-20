import type { Bytes, CompressOptions, DecompressOptions, DeflateParams, Format, InflateParams, Strategy } from './types.js';
import { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL } from './version.js';

const encoder = new TextEncoder();

// Values match GJS_FORMAT_* in csrc/gjs.h.
const FORMATS: Readonly<Record<Format, number>> = { gzip: 0, zlib: 1, 'deflate-raw': 2 };
const GZIP = FORMATS.gzip;

// Values match zlib.h: Z_DEFAULT_STRATEGY, Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED.
const STRATEGIES: Readonly<Record<Strategy, number>> = { default: 0, filtered: 1, 'huffman-only': 2, rle: 3, fixed: 4 };

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/** A Uint8Array view over the caller's bytes (no copy). */
export function toBytes(input: unknown, name: string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (isArrayBufferLike(input)) return new Uint8Array(input);
  throw new TypeError(`${name} must be an ArrayBuffer, a typed array, a DataView or a Buffer`);
}

/** Like toBytes, and also accepts strings (encoded as UTF-8). */
export function toInputBytes(input: unknown): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : toBytes(input, 'data');
}

const normalize = (key: string) => key.toLowerCase().replace(/[-_]/g, '');

// Unknown keys throw instead of being ignored, so a typo such as
// `{ compressionLevel: 9 }` cannot silently compress at the default level.
function checkKeys(options: object, allowed: readonly string[], fn: string): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      const near =
        allowed.find((name) => normalize(name) === normalize(key)) ??
        (/level/i.test(key) && !/mem/i.test(key) && allowed.includes('level') ? 'level' : undefined);
      const hint = near ? ` Did you mean "${near}"?` : '';
      throw new TypeError(`${fn}: unknown option "${key}". Valid options: ${allowed.join(', ')}.${hint}`);
    }
  }
}

function checkOptionsObject(options: unknown, fn: string): void {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new TypeError(`${fn}: options must be an object`);
  }
}

function choice<K extends string>(table: Readonly<Record<K, number>>, value: unknown, fallback: K, name: string, fn: string): number {
  const v = value ?? fallback;
  if (typeof v !== 'string' || !Object.hasOwn(table, v)) {
    const names = Object.keys(table).map((k) => `"${k}"`);
    throw new TypeError(`${fn}: ${name} must be ${names.slice(0, -1).join(', ')} or ${names.at(-1)}, got ${typeof v === 'string' ? `"${v}"` : String(v)}`);
  }
  return table[v as K];
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string, fn: string): number {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${fn}: ${name} must be an integer from ${min} to ${max}, got ${String(v)}`);
  }
  return v;
}

function dictionaryOption(value: Bytes | undefined, format: number, fn: string): Uint8Array | null {
  if (value === undefined) return null;
  if (format === GZIP) {
    throw new TypeError(`${fn}: the gzip format cannot use a dictionary; use format "zlib" or "deflate-raw"`);
  }
  const dictionary = toBytes(value, 'dictionary');
  return dictionary.length > 0 ? dictionary : null;
}

const COMPRESS_KEYS = ['format', 'level', 'memLevel', 'windowBits', 'strategy', 'dictionary'] as const;

export function resolveCompressOptions(options: CompressOptions | number | undefined, fn: string): DeflateParams {
  if (typeof options === 'number') options = { level: options };
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, COMPRESS_KEYS, fn);
  const format = choice(FORMATS, options?.format, 'gzip', 'format', fn);
  return {
    format,
    level: integer(options?.level, DEFAULT_LEVEL, MIN_LEVEL, MAX_LEVEL, 'level', fn),
    memLevel: integer(options?.memLevel, 8, 1, 9, 'memLevel', fn),
    windowBits: integer(options?.windowBits, 15, 9, 15, 'windowBits', fn),
    strategy: choice(STRATEGIES, options?.strategy, 'default', 'strategy', fn),
    dictionary: dictionaryOption(options?.dictionary, format, fn),
  };
}

const DECOMPRESS_KEYS = ['format', 'maxOutputSize', 'dictionary'] as const;

export function resolveDecompressOptions(options: DecompressOptions | undefined, fn: string): InflateParams {
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, DECOMPRESS_KEYS, fn);
  const format = choice(FORMATS, options?.format, 'gzip', 'format', fn);
  const maxOutputSize = options?.maxOutputSize ?? Infinity;
  if (typeof maxOutputSize !== 'number' || Number.isNaN(maxOutputSize) || maxOutputSize < 0 ||
      (Number.isFinite(maxOutputSize) && !Number.isInteger(maxOutputSize))) {
    throw new RangeError(`${fn}: maxOutputSize must be a non-negative integer or Infinity`);
  }
  return { format, maxOutputSize, dictionary: dictionaryOption(options?.dictionary, format, fn) };
}

export type { Bytes };
