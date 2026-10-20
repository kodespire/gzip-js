import { describe, expect, it } from 'vitest';

import { backends, fixture, FORMATS, pipeChunks, syncError, syncErrorCode, textBytes } from './helpers.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const distinct = (outputs: Uint8Array[]) => new Set(outputs.map(hex)).size;
const STRATEGIES = ['default', 'filtered', 'huffman-only', 'rle', 'fixed'] as const;

describe.each(backends)('%s backend: options', (_name, z) => {
  const corpus = new Uint8Array(fixture('corpus.txt'));

  // Byte comparisons, not sizes: some settings give equal sizes (levels 8 and 9 on this corpus).
  describe.each(FORMATS)('%s: every option changes the output', (format) => {
    it('level', () => {
      // Levels 8 and 9 differ only in how long a match search may run, which the corpus does not
      // reach; this denser text does.
      const src = textBytes(200_000, 3);
      const out = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => z.compressSync(src, { format, level }));
      expect(distinct(out)).toBe(10);
      expect(out[9]!.length).toBeLessThan(out[1]!.length);
      expect(out[6]!.length).toBeLessThan(out[1]!.length);
      expect(out[1]!.length).toBeLessThan(out[0]!.length);
      expect(out[0]!.length).toBeGreaterThan(src.length); // stored, not compressed
    });

    it('memLevel', () => {
      const out = [1, 2, 8, 9].map((memLevel) => z.compressSync(corpus, { format, memLevel }));
      expect(distinct(out)).toBe(4);
    });

    it('windowBits', () => {
      const out = [9, 10, 12, 15].map((windowBits) => z.compressSync(corpus, { format, windowBits }));
      expect(distinct(out)).toBe(4);
      // A 512-byte window finds far fewer matches than 32 KiB.
      expect(out[0]!.length).toBeGreaterThan(out[3]!.length * 1.2);
    });

    it('strategy', () => {
      const out = STRATEGIES.map((strategy) => z.compressSync(corpus, { format, strategy }));
      expect(distinct(out)).toBe(5);
    });

    it('every setting round-trips', () => {
      for (const level of [0, 1, 9]) {
        for (const memLevel of [1, 9]) {
          for (const windowBits of [9, 15]) {
            for (const strategy of STRATEGIES) {
              const o = { format, level, memLevel, windowBits, strategy };
              expect(z.decompressSync(z.compressSync(corpus, o), { format }), JSON.stringify(o)).toEqualBytes(corpus);
            }
          }
        }
      }
    });
  });

  it('the three formats wrap the same deflate data', () => {
    const raw = z.compressSync(corpus, { format: 'deflate-raw' });
    const gzip = z.compressSync(corpus, { format: 'gzip' });
    const zlib = z.compressSync(corpus, { format: 'zlib' });
    expect(gzip.subarray(10, -8)).toEqualBytes(raw);
    expect(zlib.subarray(2, -4)).toEqualBytes(raw);
  });

  it('the zlib header records windowBits and the level', () => {
    // RFC 1950: CMF = CINFO (windowBits - 8) << 4 | CM 8; FLG = FLEVEL << 6 | FCHECK.
    const header = (o: object) => {
      const [cmf, flg] = z.compressSync(corpus, { format: 'zlib', ...o });
      expect(((cmf! << 8) | flg!) % 31).toBe(0);
      return { cinfo: cmf! >> 4, cm: cmf! & 15, flevel: flg! >> 6 };
    };
    expect(header({})).toEqual({ cinfo: 7, cm: 8, flevel: 2 });
    expect(header({ windowBits: 9, level: 1 })).toEqual({ cinfo: 1, cm: 8, flevel: 0 });
    expect(header({ windowBits: 12, level: 4 })).toEqual({ cinfo: 4, cm: 8, flevel: 1 });
    expect(header({ level: 9 })).toEqual({ cinfo: 7, cm: 8, flevel: 3 });
  });

  it('gzip members get a fixed header: no name, MTIME 0, OS 255', () => {
    // XFL is 2 at level 9, 4 for the fastest settings and 0 otherwise, as zlib sets it.
    const cases: [object, number][] = [[{}, 0], [{ level: 9 }, 2], [{ level: 1 }, 4], [{ level: 0 }, 4], [{ strategy: 'rle' }, 4]];
    for (const [o, xfl] of cases) {
      expect([...z.compressSync(corpus, o).subarray(0, 10)], JSON.stringify(o)).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, xfl, 255]);
    }
  });

  it('the level shorthand matches the options form, and the defaults are zlib’s', async () => {
    expect(z.compressSync(corpus, 9)).toEqualBytes(z.compressSync(corpus, { level: 9 }));
    expect(await z.compress(corpus, 9)).toEqualBytes(z.compressSync(corpus, { level: 9 }));
    const defaults = { format: 'gzip', level: 6, memLevel: 8, windowBits: 15, strategy: 'default' } as const;
    expect(z.compressSync(corpus)).toEqualBytes(z.compressSync(corpus, defaults));
    expect(z.DEFAULT_LEVEL).toBe(6);
  });

  // Streamed output is byte-identical to one-shot output, so every option demonstrably reaches
  // the stream path. (Except level 0, whose stored blocks follow the input's chunking.)
  it('streams apply every option: same bytes as one-shot', async () => {
    const matrix = [
      {},
      { level: 1 },
      { level: 9, format: 'zlib' },
      { strategy: 'rle', format: 'deflate-raw' },
      { strategy: 'huffman-only' },
      { memLevel: 1, windowBits: 9 },
      { format: 'zlib', windowBits: 10, strategy: 'filtered', level: 4 },
    ] as const;
    for (const o of matrix) {
      for (const chunk of [7, 65_536]) {
        expect(await pipeChunks(z.createCompressStream(o), corpus, () => chunk), JSON.stringify(o)).toEqualBytes(z.compressSync(corpus, o));
      }
    }
    expect(z.decompressSync(await pipeChunks(z.createCompressStream(0), corpus, () => 1000))).toEqualBytes(corpus);
  });

  it('a dictionary changes the output and is required to decompress (zlib)', () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    const plain = z.compressSync(record, { format: 'zlib' });
    const withDict = z.compressSync(record, { format: 'zlib', dictionary });
    expect(withDict.length).toBeLessThan(plain.length);
    expect(z.decompressSync(withDict, { format: 'zlib', dictionary })).toEqualBytes(record);
    expect(syncError(() => z.decompressSync(withDict, { format: 'zlib' }))).toMatchObject({ code: 'ERR_GZIP_LIBRARY', message: 'zlib: the zlib stream needs a dictionary' });
    expect(syncError(() => z.decompressSync(withDict, { format: 'zlib', dictionary: textBytes(100) }))).toMatchObject({ code: 'ERR_GZIP_LIBRARY', message: 'zlib: incorrect dictionary' });
    // A dictionary given for data that does not use one is not needed, and does no harm.
    expect(z.decompressSync(plain, { format: 'zlib', dictionary })).toEqualBytes(record);
  });

  it('a dictionary changes the output and is required to decompress (deflate-raw)', () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    const withDict = z.compressSync(record, { format: 'deflate-raw', dictionary });
    expect(withDict.length).toBeLessThan(z.compressSync(record, { format: 'deflate-raw' }).length);
    expect(z.decompressSync(withDict, { format: 'deflate-raw', dictionary })).toEqualBytes(record);
    // Raw deflate cannot tell a missing dictionary: it fails, or decodes to the wrong bytes.
    let wrong: Uint8Array | undefined;
    try {
      wrong = z.decompressSync(withDict, { format: 'deflate-raw' });
    } catch (error) {
      expect((error as { code: string }).code).toBe('ERR_GZIP_LIBRARY');
    }
    if (wrong) expect(wrong).not.toEqualBytes(record);
  });

  it('the gzip format refuses a dictionary', () => {
    for (const fn of [() => z.compressSync('x', { dictionary: textBytes(10) }), () => z.decompressSync(z.compressSync('x'), { dictionary: textBytes(10) })]) {
      expect(fn).toThrow(TypeError);
      expect(fn).toThrow(/gzip format cannot use a dictionary/);
    }
  });

  it('results are plain Uint8Arrays, not Buffers', async () => {
    const results = [
      z.compressSync('x'),
      await z.compress('x'),
      z.decompressSync(z.compressSync('x')),
      await z.decompress(z.compressSync('x')),
      await pipeChunks(z.createCompressStream(), textBytes(10)),
    ];
    for (const r of results) expect(Object.getPrototypeOf(r)).toBe(Uint8Array.prototype);
  });

  it('accepts every binary input type', () => {
    const src = textBytes(10_000);
    const packed = z.compressSync(src);
    const padded = new Uint8Array(packed.length + 10);
    padded.set(packed, 5);
    const inputs: unknown[] = [
      packed,
      Buffer.from(packed),
      packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength),
      padded.subarray(5, 5 + packed.length),
      new DataView(padded.buffer, 5, packed.length),
    ];
    for (const input of inputs) expect(z.decompressSync(input as Uint8Array)).toEqualBytes(src);
    expect(z.decompressSync(z.compressSync('héllo ✓'))).toEqualBytes(new TextEncoder().encode('héllo ✓'));
  });

  it('rejects unknown option names instead of ignoring them', () => {
    expect(() => z.compressSync('x', { compressionLevel: 9 } as never)).toThrow(/unknown option "compressionLevel".*Did you mean "level"/);
    expect(() => z.compressSync('x', { mem_level: 9 } as never)).toThrow(/unknown option "mem_level".*Did you mean "memLevel"/);
    expect(() => z.compressSync('x', { windowbits: 9 } as never)).toThrow(/Did you mean "windowBits"/);
    expect(() => z.decompressSync(z.compressSync('x'), { maxOutput: 10 } as never)).toThrow(/unknown option "maxOutput"/);
    expect(() => z.decompressSync(z.compressSync('x'), { level: 1 } as never)).toThrow(/unknown option "level"/);
    expect(() => z.createDecompressStream({ windowBits: 15 } as never)).toThrow(/unknown option "windowBits"/);
  });

  it('validates option values', () => {
    const packed = z.compressSync('x');
    expect(() => z.compressSync('x', { level: 10 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: -1 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: 1.5 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: '6' as never })).toThrow(RangeError);
    expect(() => z.compressSync('x', { memLevel: 0 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { memLevel: 10 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { windowBits: 8 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { windowBits: 16 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { strategy: 'huffman' as never })).toThrow(/strategy must be "default", "filtered", "huffman-only", "rle" or "fixed"/);
    expect(() => z.compressSync('x', { format: 'deflate' as never })).toThrow(/format must be "gzip", "zlib" or "deflate-raw", got "deflate"/);
    expect(() => z.decompressSync(packed, { format: 'gunzip' as never })).toThrow(TypeError);
    expect(() => z.decompressSync(packed, { maxOutputSize: -1 })).toThrow(RangeError);
    expect(() => z.decompressSync(packed, { maxOutputSize: 1.5 })).toThrow(RangeError);
    expect(() => z.decompressSync('abc' as never)).toThrow(TypeError);
    expect(() => z.compressSync(123 as never)).toThrow(TypeError);
    expect(() => z.compressSync('x', null as never)).toThrow(TypeError);
    expect(() => z.createCompressStream({ level: 11 })).toThrow(RangeError);
    expect(syncErrorCode(() => z.decompressSync(packed, { maxOutputSize: Infinity }))).toBe('no error');
  });

  it('isGzip', () => {
    expect(z.isGzip(fixture('corpus.stdin.gz'))).toBe(true);
    expect(z.isGzip(fixture('corpus.name.gz'))).toBe(true);
    expect(z.isGzip(z.compressSync(''))).toBe(true);
    expect(z.isGzip(z.compressSync('x', { format: 'zlib' }))).toBe(false);
    expect(z.isGzip(fixture('corpus.txt'))).toBe(false);
    expect(z.isGzip(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0]))).toBe(false); // shorter than a header
    expect(z.isGzip(new Uint8Array([0x1f, 0x8b, 7, 0, 0, 0, 0, 0, 0, 3]))).toBe(false); // not deflate
    expect(z.isGzip(new Uint8Array([0x1f, 0x8b, 8, 0x20, 0, 0, 0, 0, 0, 3]))).toBe(false); // reserved flag
    expect(z.isGzip(new Uint8Array(2))).toBe(false);
  });
});
