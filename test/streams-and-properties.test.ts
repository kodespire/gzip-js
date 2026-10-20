import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { backends, concat, errorCode, FORMATS, pipeChunks, randomBytes, syncErrorCode, textBytes, type Format } from './helpers.js';

describe.each(backends)('%s backend: streams', (_name, z) => {
  it.each(FORMATS)('%s: compress stream output decodes with one-shot decompress, for many chunk sizes', async (format) => {
    const src = textBytes(1_000_000, 21);
    for (const chunk of [1_000, 32 * 1024, 64 * 1024, 300_000, 2_000_000]) {
      const packed = await pipeChunks(z.createCompressStream({ format }), src, () => chunk);
      expect(z.decompressSync(packed, { format }), `chunk ${chunk}`).toEqualBytes(src);
    }
  });

  it.each(FORMATS)('%s: decompress stream handles input split at every kind of boundary', async (format) => {
    const src = textBytes(400_000, 22);
    const packed = z.compressSync(src, { format, level: 7 });
    for (const chunk of [1, 3, 4096, 65_536, packed.length]) {
      const out = await pipeChunks(z.createDecompressStream({ format }), packed, () => chunk);
      expect(out, `chunk ${chunk}`).toEqualBytes(src);
    }
  });

  it('decompress stream joins members split mid-member, and accepts zero padding', async () => {
    const a = textBytes(100_000, 1);
    const b = randomBytes(50_000, 2);
    const data = concat(z.compressSync(a), z.compressSync(b), new Uint8Array(100));
    expect(await pipeChunks(z.createDecompressStream(), data, () => 999)).toEqualBytes(concat(a, b));
  });

  // The rules for bytes after a member must not depend on where chunks split them: every
  // split of the input into two writes, and one byte per write, give the one-shot result.
  it('trailing-data rules hold at every split point', async () => {
    const member = z.compressSync(textBytes(300, 3));
    const tails: [Uint8Array, string][] = [
      [new Uint8Array([0, 0, 0]), 'no error'],
      [new Uint8Array([0, 0, 0x41]), 'ERR_GZIP_TRAILING_DATA'],
      [new Uint8Array([0x1f]), 'ERR_GZIP_TRUNCATED'],
      [new Uint8Array([0x1f, 0x8b]), 'ERR_GZIP_TRUNCATED'],
      [new Uint8Array([0x1f, 0x00]), 'ERR_GZIP_TRAILING_DATA'],
      [new Uint8Array([0x41]), 'ERR_GZIP_TRAILING_DATA'],
      [member, 'no error'],
    ];
    for (const [tail, expected] of tails) {
      const data = concat(member, tail);
      expect(syncErrorCode(() => z.decompressSync(data)), `one-shot, tail ${[...tail.subarray(0, 3)]}`).toBe(expected);
      expect(await errorCode(() => pipeChunks(z.createDecompressStream(), data, () => 1)), `1-byte writes, tail ${[...tail.subarray(0, 3)]}`).toBe(expected);
      for (let split = member.length - 2; split < data.length; split++) {
        const sizes = [split, data.length - split];
        expect(await errorCode(() => pipeChunks(z.createDecompressStream(), data, (i) => sizes[i]!)), `split at ${split}`).toBe(expected);
      }
    }
    for (const format of ['zlib', 'deflate-raw'] as const) {
      const stream = z.compressSync('abc', { format });
      for (const tail of [new Uint8Array([0]), new Uint8Array([0x1f, 0x8b])]) {
        expect(await errorCode(() => pipeChunks(z.createDecompressStream({ format }), concat(stream, tail), () => 1))).toBe('ERR_GZIP_TRAILING_DATA');
      }
    }
  });

  it('empty chunks are accepted anywhere', async () => {
    const src = textBytes(50_000, 6);
    const writeWithGaps = async (stream: TransformStream<Uint8Array, Uint8Array>, data: Uint8Array) => {
      const parts: Uint8Array[] = [];
      const reading = (async () => {
        for await (const p of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(p);
      })();
      const w = stream.writable.getWriter();
      const empty = new Uint8Array(0);
      await w.write(empty);
      for (let i = 0; i < data.length; i += 7_000) {
        await w.write(data.subarray(i, i + 7_000));
        await w.write(empty);
      }
      await w.close();
      await reading;
      return concat(...parts);
    };
    for (const format of FORMATS) {
      const packed = await writeWithGaps(z.createCompressStream({ format }), src);
      expect(packed).toEqualBytes(z.compressSync(src, { format }));
      expect(await writeWithGaps(z.createDecompressStream({ format }), concat(packed, format === 'gzip' ? packed : new Uint8Array(0))))
        .toEqualBytes(format === 'gzip' ? concat(src, src) : src);
    }
  });

  it('decompress stream errors on input that ends partway through', async () => {
    for (const format of FORMATS) {
      const packed = z.compressSync(textBytes(100_000, 3), { format });
      expect(await errorCode(() => pipeChunks(z.createDecompressStream({ format }), packed.subarray(0, packed.length - 1)))).toBe('ERR_GZIP_TRUNCATED');
    }
  });

  it('decompress stream errors when no input arrives at all', async () => {
    for (const format of FORMATS) {
      expect(await errorCode(() => pipeChunks(z.createDecompressStream({ format }), new Uint8Array(0)))).toBe('ERR_GZIP_TRUNCATED');
    }
  });

  it('decompress stream enforces maxOutputSize across chunks', async () => {
    const packed = z.compressSync(new Uint8Array(5 << 20));
    expect(await errorCode(() => pipeChunks(z.createDecompressStream({ maxOutputSize: 1 << 20 }), packed, () => 10)))
      .toBe('ERR_GZIP_OUTPUT_LIMIT');
    expect((await pipeChunks(z.createDecompressStream({ maxOutputSize: 5 << 20 }), packed, () => 10)).length).toBe(5 << 20);
  });

  it('decompress stream errors on corrupt input', async () => {
    for (const format of ['gzip', 'zlib'] as const) {
      const packed = z.compressSync(textBytes(100_000, 4), { format });
      packed[packed.length >> 1]! ^= 0xff;
      expect(await errorCode(() => pipeChunks(z.createDecompressStream({ format }), packed))).toBe('ERR_GZIP_LIBRARY');
    }
  });

  it.each(['zlib', 'deflate-raw'] as const)('%s streams with a dictionary', async (format) => {
    const dictionary = textBytes(8_000, 5);
    const src = textBytes(50_000, 5);
    const packed = await pipeChunks(z.createCompressStream({ format, dictionary }), src);
    expect(z.decompressSync(packed, { format, dictionary })).toEqualBytes(src);
    expect(await pipeChunks(z.createDecompressStream({ format, dictionary }), packed, () => 100)).toEqualBytes(src);
  });

  it('cancelling a stream while a chunk is being processed is clean', async () => {
    const big = textBytes(8 << 20, 31);
    const packed = z.compressSync(big, 1);
    const cases: [TransformStream<Uint8Array, Uint8Array>, Uint8Array][] = [
      [z.createCompressStream(9), big],
      [z.createDecompressStream(), packed],
    ];
    for (const [stream, chunk] of cases) {
      // transform() only runs once the readable side has demand, so read first.
      const reader = stream.readable.getReader();
      const read = reader.read().catch(() => {});
      const pending = stream.writable.getWriter().write(chunk).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5)); // the push is now in flight
      await expect(reader.cancel('stop')).resolves.toBeUndefined();
      await Promise.all([read, pending]);
    }
    // The backend still works afterwards.
    expect(z.decompressSync(z.compressSync('after cancel'))).toEqualBytes(new TextEncoder().encode('after cancel'));
  });

  it('many concurrent async calls return the right results', async () => {
    const inputs = Array.from({ length: 64 }, (_, i) => textBytes(20_000 + i * 997, i));
    const formats = inputs.map((_, i) => FORMATS[i % 3]!);
    const packed = await Promise.all(inputs.map((src, i) => z.compress(src, { format: formats[i], level: i % 10 })));
    const outputs = await Promise.all(packed.map((p, i) => z.decompress(p, { format: formats[i] })));
    outputs.forEach((out, i) => expect(out).toEqualBytes(inputs[i]!));
  });
});

const formatArb = fc.constantFrom<Format>(...FORMATS);
const optionsArb = fc.record({
  format: formatArb,
  level: fc.integer({ min: 0, max: 9 }),
  memLevel: fc.integer({ min: 1, max: 9 }),
  windowBits: fc.integer({ min: 9, max: 15 }),
  strategy: fc.constantFrom('default', 'filtered', 'huffman-only', 'rle', 'fixed' as const),
});
// Mostly-compressible bytes, so matches (and long-distance ones) actually occur.
const dataArb = fc.uint8Array({ maxLength: 20_000 }).map((a) => a.map((b, i) => (i % 4 ? b & 0x0f : b)));

describe.each(backends)('%s backend: properties', (_name, z) => {
  it('decompress(compress(x)) === x for arbitrary bytes and options', () => {
    fc.assert(
      fc.property(dataArb, optionsArb, fc.option(fc.uint8Array({ minLength: 1, maxLength: 2_000 })), (src, o, dict) => {
        const dictionary = o.format === 'gzip' || dict === null ? undefined : dict;
        const packed = z.compressSync(src, { ...o, dictionary });
        expect(z.decompressSync(packed, { format: o.format, dictionary })).toEqualBytes(src);
      }),
      { numRuns: 300 },
    );
  });

  it('every proper prefix of a member or stream is ERR_GZIP_TRUNCATED', () => {
    fc.assert(
      fc.property(dataArb, optionsArb, fc.double({ min: 0, max: 1, noNaN: true }), (src, o, where) => {
        const packed = z.compressSync(src, o);
        const cut = Math.min(packed.length - 1, Math.floor(where * packed.length));
        expect(syncErrorCode(() => z.decompressSync(packed.subarray(0, cut), { format: o.format }))).toBe('ERR_GZIP_TRUNCATED');
      }),
      { numRuns: 300 },
    );
  });

  // Whatever follows a gzip member, the result is the original data or an error, never other
  // data. The rule, as a reference: all zeros pass; 1f alone or 1f 8b... starts another member
  // (here random, so it is cut short or corrupt); anything else is trailing data.
  it('bytes after a gzip member follow the trailing-data rule and never change the output', () => {
    const src = textBytes(3000, 41);
    const member = z.compressSync(src);
    const expected = (tail: Uint8Array) => {
      if (tail.every((b) => b === 0)) return /^no error$/;
      if (tail[0] === 0x1f && (tail.length === 1 || tail[1] === 0x8b)) return /^ERR_GZIP_(TRUNCATED|LIBRARY)$/;
      return /^ERR_GZIP_TRAILING_DATA$/;
    };
    const tailArb = fc.oneof(
      fc.uint8Array({ minLength: 1, maxLength: 64 }),
      fc.uint8Array({ maxLength: 64 }).map((t) => concat(new Uint8Array([0x1f, 0x8b]), t)),
      fc.uint8Array({ maxLength: 64 }).map((t) => concat(new Uint8Array(t.length % 5), t)),
      fc.integer({ min: 1, max: 64 }).map((n) => new Uint8Array(n)),
    );
    fc.assert(
      fc.property(tailArb, (tail) => {
        const data = concat(member, tail);
        expect(syncErrorCode(() => z.decompressSync(data))).toMatch(expected(tail));
        if (expected(tail).test('no error')) expect(z.decompressSync(data)).toEqualBytes(src);
      }),
      { numRuns: 500 },
    );
  });

  it('chunked streaming matches one-shot for arbitrary splits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200_000 }).map((a) => a.map((b, i) => (i % 4 ? b & 0x0f : b))),
        fc.array(fc.integer({ min: 1, max: 70_000 }), { minLength: 1, maxLength: 20 }),
        optionsArb.filter((o) => o.level > 0),
        async (src, sizes, o) => {
          const packed = await pipeChunks(z.createCompressStream(o), src, (i) => sizes[i % sizes.length]!);
          // Above level 0, deflate's output does not depend on how the input was split.
          expect(packed).toEqualBytes(z.compressSync(src, o));
          const out = await pipeChunks(z.createDecompressStream({ format: o.format }), packed, (i) => sizes[(i + 1) % sizes.length]!);
          expect(out).toEqualBytes(src);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('native and wasm agree', () => {
  const [[, native], [, wasm]] = backends;

  // Same C code, same zlib, and a fixed gzip header (OS 255): the bytes are identical, so output
  // does not depend on the runtime or the platform the native addon was built for.
  it('produce byte-identical output for every format and setting', () => {
    const src = concat(textBytes(150_000, 51), randomBytes(5_000, 52));
    for (const format of FORMATS) {
      for (const level of [0, 1, 6, 9]) {
        for (const [memLevel, windowBits] of [[8, 15], [1, 9], [9, 12]] as const) {
          for (const strategy of ['default', 'filtered', 'huffman-only', 'rle', 'fixed'] as const) {
            const o = { format, level, memLevel, windowBits, strategy };
            expect(wasm.compressSync(src, o), JSON.stringify(o)).toEqualBytes(native.compressSync(src, o));
          }
        }
      }
    }
  });

  it('each decodes the other’s output', async () => {
    for (const format of FORMATS) {
      const src = textBytes(300_000, 53);
      expect(wasm.decompressSync(native.compressSync(src, { format }), { format })).toEqualBytes(src);
      expect(native.decompressSync(wasm.compressSync(src, { format }), { format })).toEqualBytes(src);
      const streamed = await pipeChunks(native.createCompressStream({ format }), src, () => 50_000);
      expect(await pipeChunks(wasm.createDecompressStream({ format }), streamed, () => 1234)).toEqualBytes(src);
    }
  });

  it('report the same zlib version as the bundled source', () => {
    expect(native.ZLIB_VERSION).toBe(wasm.ZLIB_VERSION);
  });
});
