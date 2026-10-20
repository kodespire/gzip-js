// Tests run against the built package in dist/ (what users get), once per backend.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import * as nodeEntry from '../dist/entry-node.js';
import * as wasmEntry from '../dist/entry-wasm.js';

export type Gzip = typeof nodeEntry;
export type Format = nodeEntry.Format;

export const backends: [name: 'native' | 'wasm', api: Gzip][] = [
  ['native', nodeEntry],
  ['wasm', wasmEntry as Gzip],
];

export const FORMATS: Format[] = ['gzip', 'zlib', 'deflate-raw'];

const fixturesDir = join(import.meta.dirname, 'fixtures');
export const fixture = (name: string): Buffer => readFileSync(join(fixturesDir, name));
export const fixturePath = (name: string): string => join(fixturesDir, name);

// ---- external reference implementations -------------------------------------

/** CI sets REQUIRE_INTEROP=1 where the tools exist, so a missing tool fails instead of skipping. */
export const requireInterop = process.env['REQUIRE_INTEROP'] === '1';

function works(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

/** The system `gzip` command (GNU gzip on Linux, Apple gzip on macOS), if installed. */
export const gzipCli: string | undefined = works('gzip', ['-h']) || works('gzip', ['--version']) ? 'gzip' : undefined;

/** A Python 3 interpreter with the zlib module, if installed. Always run with -I (isolated mode). */
export const python: string | undefined = ['python3', 'python'].find((cmd) =>
  works(cmd, ['-I', '-c', 'import sys, zlib; sys.exit(0 if sys.version_info[0] == 3 else 1)']),
);

export function run(command: string, args: string[], input: Uint8Array): Uint8Array {
  const r = spawnSync(command, args, { input, maxBuffer: 1 << 30, timeout: 60_000 });
  if (r.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed (${r.error?.message ?? r.signal ?? `exit ${r.status}`}): ${r.stderr}`);
  }
  return new Uint8Array(r.stdout);
}

// Python's zlib, driven through compressobj/decompressobj so every parameter is explicit.
// decompress exits 3 unless the input is exactly one complete stream.
const PY_ZLIB = `
import sys, zlib
op, wbits, level, mem, strategy, zdict = sys.argv[1:7]
data = sys.stdin.buffer.read()
kw = {'zdict': bytes.fromhex(zdict)} if zdict else {}
if op == 'c':
    c = zlib.compressobj(int(level), zlib.DEFLATED, int(wbits), int(mem), int(strategy), **kw)
    out = c.compress(data) + c.flush()
else:
    d = zlib.decompressobj(int(wbits), **kw)
    out = d.decompress(data) + d.flush()
    if not d.eof or d.unused_data:
        sys.exit(3)
sys.stdout.buffer.write(out)
`;

const WBITS: Record<Format, (bits: number) => number> = {
  gzip: (b) => b + 16,
  zlib: (b) => b,
  'deflate-raw': (b) => -b,
};

export interface PyOptions {
  format: Format;
  level?: number;
  windowBits?: number;
  memLevel?: number;
  strategy?: number;
  dictionary?: Uint8Array;
}

export function pyCompress(data: Uint8Array, o: PyOptions): Uint8Array {
  const args = ['c', WBITS[o.format](o.windowBits ?? 15), o.level ?? 6, o.memLevel ?? 8, o.strategy ?? 0, hex(o.dictionary)];
  return run(python!, ['-I', '-c', PY_ZLIB, ...args.map(String)], data);
}

export function pyDecompress(data: Uint8Array, o: Pick<PyOptions, 'format' | 'dictionary'>): Uint8Array {
  return run(python!, ['-I', '-c', PY_ZLIB, 'd', String(WBITS[o.format](15)), '0', '0', '0', hex(o.dictionary)], data);
}

const hex = (b?: Uint8Array) => (b ? Buffer.from(b).toString('hex') : '');

// ---- data ---------------------------------------------------------------------

/** Deterministic pseudo-random bytes (incompressible). */
export function randomBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Deterministic, moderately compressible bytes. */
export function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'gzip ', 'member ', 'block ', '\n'];
  const out = new Uint8Array(length);
  const r = randomBytes(length, seed);
  let i = 0;
  let k = 0;
  while (i < length) {
    const w = words[r[k++ % length]! % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const u32le = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const u16le = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);

export interface MemberHeader {
  text?: boolean;
  extra?: Uint8Array;
  name?: string;
  comment?: string;
  headerCrc?: boolean;
  mtime?: number;
  os?: number;
}

/**
 * A gzip member built by hand around raw deflate data, with any of the optional header
 * fields (RFC 1952: FTEXT, FEXTRA, FNAME, FCOMMENT, FHCRC) set.
 */
export function gzipMember(deflated: Uint8Array, content: Uint8Array, h: MemberHeader = {}): Uint8Array {
  const latin1 = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  const flags = (h.text ? 1 : 0) | (h.headerCrc ? 2 : 0) | (h.extra ? 4 : 0) | (h.name !== undefined ? 8 : 0) | (h.comment !== undefined ? 16 : 0);
  const parts: Uint8Array[] = [new Uint8Array([0x1f, 0x8b, 8, flags]), u32le(h.mtime ?? 0), new Uint8Array([0, h.os ?? 255])];
  if (h.extra) parts.push(u16le(h.extra.length), h.extra);
  if (h.name !== undefined) parts.push(latin1(h.name), new Uint8Array([0]));
  if (h.comment !== undefined) parts.push(latin1(h.comment), new Uint8Array([0]));
  if (h.headerCrc) parts.push(u16le(crc32(concat(...parts)) & 0xffff));
  return concat(...parts, deflated, u32le(crc32(content)), u32le(content.length));
}

// ---- streams and errors ---------------------------------------------------------

/** Runs bytes through a TransformStream, writing them in the given chunk sizes. */
export async function pipeChunks(
  stream: TransformStream<Uint8Array, Uint8Array>,
  data: Uint8Array,
  chunkSizes: (i: number) => number = () => 65536,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for await (const part of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(part);
  })();
  const writer = stream.writable.getWriter();
  try {
    for (let offset = 0, i = 0; offset < data.length; i++) {
      const size = Math.max(1, chunkSizes(i));
      await writer.write(data.subarray(offset, offset + size));
      offset += size;
    }
    await writer.close();
  } catch (error) {
    await reading.catch(() => {});
    throw error;
  }
  await reading;
  return concat(...parts);
}

/** Resolves to the GzipError code thrown by fn, or 'no error'. */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}

export function syncErrorCode(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}

export function syncError(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  return { code: 'no error' };
}
