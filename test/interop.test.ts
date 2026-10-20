// Interoperability with independent implementations:
// - the system gzip command (GNU gzip on Linux, Apple gzip on macOS), which also made the
//   gzip fixtures (scripts/make-fixtures.mjs)
// - Python's zlib module for the zlib and raw formats, which made those fixtures
// - node:zlib and the CompressionStream / DecompressionStream globals, as extra references
// The CLI and Python tests skip when the tool is missing, except under REQUIRE_INTEROP=1 (CI on
// Linux and macOS), where a missing tool fails them.
import * as nodeZlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  backends,
  concat,
  fixture,
  FORMATS,
  gzipCli,
  pipeChunks,
  pyCompress,
  pyDecompress,
  python,
  randomBytes,
  requireInterop,
  run,
  textBytes,
  type Format,
} from './helpers.js';

const corpus = new Uint8Array(fixture('corpus.txt'));
const dictionary = new Uint8Array(fixture('dict.bin'));
const record = new Uint8Array(fixture('record.json'));

describe.each(backends)('%s backend: decodes fixtures from gzip and Python', (_name, z) => {
  it.each(['corpus.stdin.gz', 'corpus.1.gz', 'corpus.9.gz', 'corpus.name.gz', 'corpus.multi.gz'])('%s', async (name) => {
    expect(z.decompressSync(fixture(name))).toEqualBytes(corpus);
    expect(await z.decompress(fixture(name))).toEqualBytes(corpus);
    expect(await pipeChunks(z.createDecompressStream(), fixture(name), () => 1000)).toEqualBytes(corpus);
  });

  it('empty.gz (a member holding zero bytes, with a file name)', () => {
    expect(z.decompressSync(fixture('empty.gz'))).toEqualBytes(new Uint8Array(0));
  });

  it.each([
    ['corpus.zlib', 'zlib'],
    ['corpus.small-window.zlib', 'zlib'],
    ['corpus.raw', 'deflate-raw'],
    ['corpus.rle.raw', 'deflate-raw'],
  ] as const)('%s', (name, format) => {
    expect(z.decompressSync(fixture(name), { format })).toEqualBytes(corpus);
  });

  it('dictionary streams', () => {
    expect(z.decompressSync(fixture('record.dict.zlib'), { format: 'zlib', dictionary })).toEqualBytes(record);
    expect(z.decompressSync(fixture('record.dict.raw'), { format: 'deflate-raw', dictionary })).toEqualBytes(record);
  });
});

describe.skipIf(!gzipCli && !requireInterop).each(backends)('%s backend: system gzip, both ways', (_name, z) => {
  const gunzip = (data: Uint8Array) => run('gzip', ['-d', '-c'], data);

  it.each([
    {},
    { level: 0 },
    { level: 1 },
    { level: 9 },
    { strategy: 'huffman-only' },
    { strategy: 'rle' },
    { strategy: 'fixed' },
    { windowBits: 9, memLevel: 1 },
  ] as const)('gzip -d decodes our output: %o', (o) => {
    const src = textBytes(500_000, 101);
    const member = z.compressSync(src, o);
    expect(gunzip(member)).toEqualBytes(src);
    run('gzip', ['-t'], member); // exit status 0: integrity check passed
  });

  it('gzip -d decodes our streamed output and our multi-member output', async () => {
    const src = textBytes(800_000, 5);
    const streamed = await pipeChunks(z.createCompressStream(), src, () => 77_777);
    expect(gunzip(streamed)).toEqualBytes(src);
    const b = randomBytes(5000, 6);
    expect(gunzip(concat(streamed, z.compressSync(b), z.compressSync('')))).toEqualBytes(concat(src, b));
  });

  it.each([['-1'], ['-6'], ['-9'], ['-n', '-9']])('we decode gzip %s', async (...args) => {
    const src = concat(textBytes(300_000, 7), randomBytes(20_000, 8));
    const member = run('gzip', ['-c', ...args], src);
    expect(z.decompressSync(member)).toEqualBytes(src);
    expect(await pipeChunks(z.createDecompressStream(), member, () => 4096)).toEqualBytes(src);
  });
});

describe.skipIf(!python && !requireInterop).each(backends)('%s backend: Python zlib, both ways', (_name, z) => {
  const src = concat(textBytes(200_000, 11), randomBytes(5_000, 12));
  const STRATEGY = { default: 0, filtered: 1, 'huffman-only': 2, rle: 3, fixed: 4 } as const;
  const settings = [
    {},
    { level: 0 },
    { level: 1 },
    { level: 9 },
    { memLevel: 1 },
    { windowBits: 9 },
    { strategy: 'filtered' },
    { strategy: 'huffman-only' },
    { strategy: 'rle' },
    { strategy: 'fixed' },
  ] as const;

  describe.each(FORMATS)('%s', (format: Format) => {
    it.each(settings)('Python decodes our output: %o', (o) => {
      expect(pyDecompress(z.compressSync(src, { format, ...o }), { format })).toEqualBytes(src);
    });

    it.each(settings)('we decode Python output: %o', (o) => {
      const strategy = 'strategy' in o ? STRATEGY[o.strategy] : undefined;
      expect(z.decompressSync(pyCompress(src, { format, ...o, strategy }), { format })).toEqualBytes(src);
    });
  });

  it.each(['zlib', 'deflate-raw'] as const)('%s with a dictionary, both ways', (format) => {
    expect(pyDecompress(z.compressSync(record, { format, dictionary }), { format, dictionary })).toEqualBytes(record);
    expect(z.decompressSync(pyCompress(record, { format, dictionary, level: 9 }), { format, dictionary })).toEqualBytes(record);
  });
});

describe.each(backends)('%s backend: node:zlib, both ways', (_name, z) => {
  const src = concat(textBytes(300_000, 21), randomBytes(10_000, 22));
  const theirs = {
    gzip: { compress: nodeZlib.gzipSync, decompress: nodeZlib.gunzipSync },
    zlib: { compress: nodeZlib.deflateSync, decompress: nodeZlib.inflateSync },
    'deflate-raw': { compress: nodeZlib.deflateRawSync, decompress: nodeZlib.inflateRawSync },
  };
  const C = nodeZlib.constants;

  describe.each(FORMATS)('%s', (format) => {
    it.each([
      [{}, {}],
      [{ level: 1, memLevel: 1 }, { level: 1, memLevel: 1 }],
      [{ level: 9, windowBits: 10 }, { level: 9, windowBits: 10 }],
      [{ strategy: 'rle' }, { strategy: C.Z_RLE }],
      [{ strategy: 'filtered' }, { strategy: C.Z_FILTERED }],
    ] as const)('%o', (ours, node) => {
      expect(theirs[format].decompress(z.compressSync(src, { format, ...ours }))).toEqualBytes(src);
      expect(z.decompressSync(theirs[format].compress(src, node), { format })).toEqualBytes(src);
    });
  });

  it('dictionaries (zlib and deflate-raw)', () => {
    expect(nodeZlib.inflateSync(z.compressSync(record, { format: 'zlib', dictionary }), { dictionary })).toEqualBytes(record);
    expect(z.decompressSync(nodeZlib.deflateSync(record, { dictionary }), { format: 'zlib', dictionary })).toEqualBytes(record);
    expect(nodeZlib.inflateRawSync(z.compressSync(record, { format: 'deflate-raw', dictionary }), { dictionary })).toEqualBytes(record);
    expect(z.decompressSync(nodeZlib.deflateRawSync(record, { dictionary }), { format: 'deflate-raw', dictionary })).toEqualBytes(record);
  });

  it('multi-member gzip and zero padding are read the same way as gunzipSync', () => {
    const data = concat(z.compressSync(src), nodeZlib.gzipSync('tail'), new Uint8Array(16));
    expect(z.decompressSync(data)).toEqualBytes(nodeZlib.gunzipSync(data));
  });
});

describe.each(backends)('%s backend: CompressionStream and DecompressionStream', (_name, z) => {
  const src = textBytes(400_000, 31);
  const names: Record<Format, CompressionFormat> = { gzip: 'gzip', zlib: 'deflate', 'deflate-raw': 'deflate-raw' };
  const through = async (data: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>) =>
    new Uint8Array(await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream)).arrayBuffer());

  it.each(FORMATS)('%s, both ways', async (format) => {
    const theirs = await through(src, new CompressionStream(names[format]) as TransformStream<Uint8Array, Uint8Array>);
    expect(await z.decompress(theirs, { format })).toEqualBytes(src);
    const ours = await z.compress(src, { format, level: 9 });
    expect(await through(ours, new DecompressionStream(names[format]) as TransformStream<Uint8Array, Uint8Array>)).toEqualBytes(src);
  });
});
