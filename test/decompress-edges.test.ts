// The decompression loop is where gzip bindings usually go wrong: output that
// fills a buffer exactly, multi-member files, bytes after the end, and input
// that ends partway through. Every case runs on both backends and, where it
// applies, in all three formats.
import { describe, expect, it } from 'vitest';

import {
  backends,
  concat,
  errorCode,
  FORMATS,
  gzipMember,
  randomBytes,
  syncError,
  syncErrorCode,
  textBytes,
} from './helpers.js';

// Sizes around zlib's 32 KiB window and 64 KiB stored-block limit, and the
// binding's 64 KiB output step and 1.5x growth.
const BOUNDARY_SIZES = [
  0, 1, 2, 32767, 32768, 32769, 65535, 65536, 65537, 98303, 98304, 98305, 131071, 131072, 131073,
  147456, 196607, 196608, 196609, 262143, 262144, 262145, 1 << 20, (1 << 20) + 1,
];

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);

describe.each(backends)('%s backend: decompression edge cases', (name, z) => {
  it('reports the expected backend', () => {
    expect(z.activeBackend()).toBe(name);
  });

  describe.each(FORMATS)('%s', (format) => {
    it.each(BOUNDARY_SIZES)('%i bytes', async (size) => {
      const src = textBytes(size, size + 1);
      const packed = z.compressSync(src, { format });
      expect(z.decompressSync(packed, { format })).toEqualBytes(src);
      expect(await z.decompress(packed, { format })).toEqualBytes(src);
      // A limit equal to the exact size must pass; one byte less must not.
      expect(z.decompressSync(packed, { format, maxOutputSize: size })).toEqualBytes(src);
      if (size > 0) {
        expect(syncErrorCode(() => z.decompressSync(packed, { format, maxOutputSize: size - 1 }))).toBe('ERR_GZIP_OUTPUT_LIMIT');
      }
    });
  });

  it.each([65534, 65535, 65536, 131070, 131071, 131072, 196605])('level 0 (stored blocks), %i incompressible bytes', (size) => {
    const src = randomBytes(size, size);
    for (const format of FORMATS) {
      const packed = z.compressSync(src, { format, level: 0 });
      expect(packed.length).toBeGreaterThan(size);
      expect(z.decompressSync(packed, { format })).toEqualBytes(src);
      expect(z.decompressSync(packed, { format, maxOutputSize: size })).toEqualBytes(src);
    }
  });

  it('highly compressible input: 64 MiB of zeros from about 64 KB', async () => {
    const src = new Uint8Array(64 << 20);
    const packed = await z.compress(src, 9);
    expect(packed.length).toBeLessThan(70_000);
    const out = await z.decompress(packed);
    expect(out.length).toBe(src.length);
    expect(out.every((b) => b === 0)).toBe(true);
  });

  // zlib counts bytes in 32 bits, so the binding hands it at most 256 MiB per call: this input
  // and its output each take two calls.
  it('input and output larger than one zlib call (256 MiB)', async () => {
    const src = new Uint8Array(300 << 20);
    src[0] = 1;
    src[src.length - 1] = 7;
    const packed = await z.compress(src, 1);
    const out = await z.decompress(packed, { maxOutputSize: src.length });
    expect(out.length).toBe(src.length);
    expect([out[0], out[1], out[out.length - 2], out[out.length - 1]]).toEqual([1, 0, 0, 7]);
  });

  it('a member or stream holding zero bytes decodes to nothing', () => {
    for (const format of FORMATS) {
      expect(z.decompressSync(z.compressSync(new Uint8Array(0), { format }), { format })).toEqualBytes(new Uint8Array(0));
    }
  });

  it('multi-member gzip decodes to the concatenation, as gunzip does', () => {
    const a = textBytes(100_000, 1);
    const b = randomBytes(70_000, 2);
    const c = new Uint8Array(0);
    const joined = concat(z.compressSync(a), z.compressSync(b, { level: 1 }), z.compressSync(c), z.compressSync(a, 0));
    expect(z.decompressSync(joined)).toEqualBytes(concat(a, b, c, a));
  });

  it('a last member much smaller than the rest (its ISIZE understates the total)', async () => {
    const big = textBytes(3 << 20, 5);
    const data = concat(z.compressSync(big), z.compressSync('x'));
    expect(await z.decompress(data)).toEqualBytes(concat(big, ascii('x')));
  });

  it('members with every optional header field (FTEXT, FEXTRA, FNAME, FCOMMENT, FHCRC)', () => {
    const content = textBytes(5000, 3);
    const deflated = z.compressSync(content, { format: 'deflate-raw' });
    const extra = concat(ascii('AB'), bytes(3, 0), ascii('xyz'));
    const headers = [
      {},
      { text: true },
      { extra },
      { name: 'file.txt' },
      { comment: 'a comment' },
      { headerCrc: true },
      { text: true, extra, name: 'n', comment: 'c', headerCrc: true, mtime: 1_700_000_000, os: 3 },
    ];
    for (const h of headers) expect(z.decompressSync(gzipMember(deflated, content, h)), JSON.stringify(h)).toEqualBytes(content);
    // FHCRC is checked: flip a bit of the header CRC (after the 10-byte header and "x\0").
    const bad = gzipMember(deflated, content, { name: 'x', headerCrc: true });
    bad[12]! ^= 1;
    expect(syncError(() => z.decompressSync(bad))).toMatchObject({ code: 'ERR_GZIP_LIBRARY', message: 'zlib: header crc mismatch' });
  });

  it('zero padding after the last member is ignored, as gzip -d, node:zlib and Python do', () => {
    const src = textBytes(10_000, 4);
    const member = z.compressSync(src);
    for (const n of [1, 2, 7, 512, 10_000]) expect(z.decompressSync(concat(member, new Uint8Array(n)))).toEqualBytes(src);
    expect(z.decompressSync(concat(member, member, new Uint8Array(3)))).toEqualBytes(concat(src, src));
  });
});

describe.each(backends)('%s backend: truncated input', (_name, z) => {
  it('empty input is an error in every format, as with gunzip', async () => {
    for (const format of FORMATS) {
      expect(syncErrorCode(() => z.decompressSync(new Uint8Array(0), { format }))).toBe('ERR_GZIP_TRUNCATED');
      expect(await errorCode(() => z.decompress(new Uint8Array(0), { format }))).toBe('ERR_GZIP_TRUNCATED');
    }
  });

  it.each(FORMATS)('%s: every proper prefix is rejected as truncated', (format) => {
    const src = textBytes(3000, 9);
    for (const level of [0, 1, 6, 9]) {
      const packed = z.compressSync(src, { format, level });
      for (let cut = 0; cut < packed.length; cut++) {
        const code = syncErrorCode(() => z.decompressSync(packed.subarray(0, cut), { format }));
        expect(code, `cut at ${cut}/${packed.length}, level ${level}`).toBe('ERR_GZIP_TRUNCATED');
      }
      expect(z.decompressSync(packed, { format })).toEqualBytes(src);
    }
  });

  it('a two-member file cut anywhere except the member boundary is truncated', () => {
    const first = z.compressSync(textBytes(700, 1));
    const data = concat(first, z.compressSync(textBytes(900, 2)));
    for (let cut = 0; cut < data.length; cut++) {
      // Cut exactly at the end of the first member, the input is a valid one-member file.
      const expected = cut === first.length ? 'no error' : 'ERR_GZIP_TRUNCATED';
      expect(syncErrorCode(() => z.decompressSync(data.subarray(0, cut))), `cut at ${cut}`).toBe(expected);
    }
  });

  it('truncating a large member is rejected (sampled offsets)', async () => {
    const src = textBytes(3 << 20, 10);
    for (const format of FORMATS) {
      const packed = await z.compress(src, { format });
      for (const cut of [1, 2, 9, 10, 11, packed.length >> 2, packed.length >> 1, packed.length - 8, packed.length - 4, packed.length - 1]) {
        expect(await errorCode(() => z.decompress(packed.subarray(0, cut), { format })), `${format} cut at ${cut}`).toBe('ERR_GZIP_TRUNCATED');
      }
    }
  });

  it('regression: 1 MB of zeros with the last 3 bytes cut is an error, not partial output', async () => {
    for (const format of FORMATS) {
      const packed = await z.compress(new Uint8Array(1_000_000), { format });
      expect(await errorCode(() => z.decompress(packed.subarray(0, packed.length - 3), { format }))).toBe('ERR_GZIP_TRUNCATED');
    }
  });
});

describe.each(backends)('%s backend: corrupt input', (_name, z) => {
  const src = textBytes(200_000, 11);

  // A corrupted byte must never produce wrong output. It is usually an error; rarely the change
  // is harmless (say, a match distance that points at identical bytes) and the output is the
  // original, which the checksum then confirms.
  function flips(packed: Uint8Array, format: 'gzip' | 'zlib' | 'deflate-raw', from: number) {
    const outcomes = { error: 0, original: 0, different: 0 };
    const step = Math.max(1, Math.floor((packed.length - from) / 80));
    const offsets = new Set<number>();
    for (let i = from; i < packed.length; i += step) offsets.add(i);
    for (let i = Math.max(from, packed.length - 8); i < packed.length; i++) offsets.add(i);
    for (const i of offsets) {
      const bad = packed.slice();
      bad[i]! ^= 0x5a;
      try {
        const out = z.decompressSync(bad, { format });
        if (out.length === src.length && out.every((b, k) => b === src[k])) outcomes.original++;
        else outcomes.different++;
      } catch (error) {
        expect((error as { code?: string }).code, `flip at ${i}`).toMatch(/^ERR_GZIP_(LIBRARY|TRUNCATED|TRAILING_DATA)$/);
        outcomes.error++;
      }
    }
    return outcomes;
  }

  it('gzip: corruption after the header is detected by CRC-32 and the length', () => {
    // Bytes 4-9 (MTIME, XFL, OS) are informational: no check covers them.
    const outcomes = flips(z.compressSync(src), 'gzip', 10);
    expect(outcomes.different).toBe(0);
    expect(outcomes.error).toBeGreaterThan(70);
  });

  it('zlib: corruption anywhere is detected by the header check and Adler-32', () => {
    const outcomes = flips(z.compressSync(src, { format: 'zlib' }), 'zlib', 0);
    expect(outcomes.different).toBe(0);
    expect(outcomes.error).toBeGreaterThan(70);
  });

  it('deflate-raw has no checksum: corruption can decode to different bytes without an error', () => {
    const outcomes = flips(z.compressSync(src, { format: 'deflate-raw' }), 'deflate-raw', 0);
    expect(outcomes.error + outcomes.original + outcomes.different).toBeGreaterThan(80);
  });

  it('a CRC-32 mismatch, a length mismatch and an Adler-32 mismatch each throw', () => {
    const member = z.compressSync(src);
    const crc = member.slice();
    crc[crc.length - 8]! ^= 1;
    expect(syncError(() => z.decompressSync(crc))).toMatchObject({ code: 'ERR_GZIP_LIBRARY', message: 'zlib: incorrect data check' });
    const isize = member.slice();
    isize[isize.length - 4]! ^= 1;
    expect(syncError(() => z.decompressSync(isize))).toMatchObject({ code: 'ERR_GZIP_LIBRARY', message: 'zlib: incorrect length check' });
    const zlib = z.compressSync(src, { format: 'zlib' });
    zlib[zlib.length - 1]! ^= 1;
    expect(syncError(() => z.decompressSync(zlib, { format: 'zlib' }))).toMatchObject({ code: 'ERR_GZIP_LIBRARY', message: 'zlib: incorrect data check' });
  });

  it('a bad CRC in a later member fails the whole input, not just that member', () => {
    const second = z.compressSync('second');
    second[second.length - 8]! ^= 1;
    expect(syncErrorCode(() => z.decompressSync(concat(z.compressSync(src), second)))).toBe('ERR_GZIP_LIBRARY');
  });

  it('data in another format, or no format at all, is rejected', () => {
    const text = ascii('definitely not compressed data');
    expect(syncError(() => z.decompressSync(text))).toMatchObject({ code: 'ERR_GZIP_LIBRARY', message: 'zlib: incorrect header check' });
    expect(syncErrorCode(() => z.decompressSync(text, { format: 'zlib' }))).toBe('ERR_GZIP_LIBRARY');
    expect(syncErrorCode(() => z.decompressSync(z.compressSync(src), { format: 'zlib' }))).toBe('ERR_GZIP_LIBRARY');
    expect(syncErrorCode(() => z.decompressSync(z.compressSync(src, { format: 'zlib' })))).toBe('ERR_GZIP_LIBRARY');
    // Only zero bytes: padding needs a member before it.
    expect(syncErrorCode(() => z.decompressSync(new Uint8Array(100)))).toBe('ERR_GZIP_LIBRARY');
  });
});

describe.each(backends)('%s backend: bytes after the end', (_name, z) => {
  const content = textBytes(2000, 5);
  const member = z.compressSync(content);

  // gzip: another member (1f 8b ...) or zero padding to the very end; anything else is an error.
  // An unfinished member at the end (even just its first byte) is truncation.
  it.each([
    ['zero padding', bytes(0, 0, 0, 0), 'no error'],
    ['zeros, then other data', bytes(0, 0, 0x41), 'ERR_GZIP_TRAILING_DATA'],
    ['zeros, then another member', concat(bytes(0, 0), member), 'ERR_GZIP_TRAILING_DATA'],
    ['text', ascii('GARBAGE'), 'ERR_GZIP_TRAILING_DATA'],
    ['a newline', bytes(0x0a), 'ERR_GZIP_TRAILING_DATA'],
    ['1f alone (the start of a member)', bytes(0x1f), 'ERR_GZIP_TRUNCATED'],
    ['1f 8b (the start of a member)', bytes(0x1f, 0x8b), 'ERR_GZIP_TRUNCATED'],
    ['part of a member header', bytes(0x1f, 0x8b, 8, 0, 0, 0), 'ERR_GZIP_TRUNCATED'],
    ['1f, then not 8b', bytes(0x1f, 0), 'ERR_GZIP_TRAILING_DATA'],
    ['a member header with a bad method', bytes(0x1f, 0x8b, 7, 0, 0, 0, 0, 0, 0, 0, 3, 0), 'ERR_GZIP_LIBRARY'],
  ])('gzip followed by %s', async (_label, tail, expected) => {
    const data = concat(member, tail);
    expect(syncErrorCode(() => z.decompressSync(data))).toBe(expected);
    expect(await errorCode(() => z.decompress(data))).toBe(expected);
    if (expected === 'no error') expect(z.decompressSync(data)).toEqualBytes(content);
  });

  it.each(['zlib', 'deflate-raw'] as const)('%s: any byte after the stream is an error, zero included', (format) => {
    const stream = z.compressSync(content, { format });
    for (const tail of [bytes(0), bytes(0, 0, 0, 0), ascii('GARBAGE'), stream]) {
      const error = syncError(() => z.decompressSync(concat(stream, tail), { format }));
      expect(error.code).toBe('ERR_GZIP_TRAILING_DATA');
      expect(error.message).toMatch(/after the end of the (zlib|deflate) stream/);
    }
  });
});

describe.each(backends)('%s backend: maxOutputSize', (_name, z) => {
  it('stops a decompression bomb early', async () => {
    // 1 GiB of zeros, compressed by streaming 16 MiB chunks.
    const zeros = new Uint8Array(16 << 20);
    const parts: Uint8Array[] = [];
    const stream = z.createCompressStream(9);
    const writer = stream.writable.getWriter();
    const reading = (async () => {
      for await (const p of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(p);
    })();
    for (let i = 0; i < 64; i++) await writer.write(zeros);
    await writer.close();
    await reading;
    const bomb = concat(...parts);
    expect(bomb.length).toBeLessThan(1_100_000);

    const started = performance.now();
    expect(await errorCode(() => z.decompress(bomb, { maxOutputSize: 10 << 20 }))).toBe('ERR_GZIP_OUTPUT_LIMIT');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('maxOutputSize: 0 accepts only empty output', () => {
    for (const format of FORMATS) {
      expect(z.decompressSync(z.compressSync(new Uint8Array(0), { format }), { format, maxOutputSize: 0 })).toEqualBytes(new Uint8Array(0));
      expect(syncErrorCode(() => z.decompressSync(z.compressSync('x', { format }), { format, maxOutputSize: 0 }))).toBe('ERR_GZIP_OUTPUT_LIMIT');
    }
  });

  it('counts across members', () => {
    const member = z.compressSync(new Uint8Array(1000));
    const data = concat(member, member, member);
    expect(z.decompressSync(data, { maxOutputSize: 3000 }).length).toBe(3000);
    expect(syncErrorCode(() => z.decompressSync(data, { maxOutputSize: 2999 }))).toBe('ERR_GZIP_OUTPUT_LIMIT');
  });
});
