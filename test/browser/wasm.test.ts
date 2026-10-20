// Runs in real browsers (see vitest.browser.config.ts) against the built dist/.
import { describe, expect, it } from 'vitest';

import * as z from '../../dist/entry-wasm.js';

const text = (n: number) => new TextEncoder().encode('browser gzip test '.repeat(Math.ceil(n / 18))).subarray(0, n);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, data: Uint8Array, chunk: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  for (let i = 0; i < data.length; i += chunk) await writer.write(data.subarray(i, i + chunk));
  await writer.close();
  await reading;
  return concat(parts);
}

describe('gzip-js in the browser', () => {
  // Must run first: nothing has loaded the module yet.
  it('sync calls before init() throw ERR_GZIP_NOT_INITIALIZED', () => {
    expect(() => z.compressSync('x')).toThrow(expect.objectContaining({ code: 'ERR_GZIP_NOT_INITIALIZED' }));
  });

  it('async calls load the WebAssembly module on demand', async () => {
    const src = text(500_000);
    const member = await z.compress(src, 9);
    expect(member.length).toBeLessThan(5_000);
    expect(same(await z.decompress(member), src)).toBe(true);
    expect(z.activeBackend()).toBe('wasm');
  });

  it('sync calls work after init(), in every format', async () => {
    await z.init();
    const src = text(100_000);
    for (const format of ['gzip', 'zlib', 'deflate-raw'] as const) {
      expect(same(z.decompressSync(z.compressSync(src, { format }), { format }), src)).toBe(true);
    }
    expect(z.isGzip(z.compressSync(src))).toBe(true);
  });

  it('truncated input and trailing data are errors; members join and zero padding passes', async () => {
    const member = await z.compress(new Uint8Array(1_000_000));
    await expect(z.decompress(member.subarray(0, member.length - 3))).rejects.toMatchObject({ code: 'ERR_GZIP_TRUNCATED' });
    await expect(z.decompress(concat([member, new Uint8Array([0x41])]))).rejects.toMatchObject({ code: 'ERR_GZIP_TRAILING_DATA' });
    expect((await z.decompress(concat([member, member, new Uint8Array(8)]))).length).toBe(2_000_000);
  });

  it('maxOutputSize is enforced', async () => {
    const member = await z.compress(new Uint8Array(8 << 20));
    await expect(z.decompress(member, { maxOutputSize: 1 << 20 })).rejects.toMatchObject({ code: 'ERR_GZIP_OUTPUT_LIMIT' });
  });

  it('streams round-trip', async () => {
    const src = text(2_000_000);
    const member = await pipe(z.createCompressStream({ level: 5 }), src, 100_000);
    expect(same(await pipe(z.createDecompressStream(), member, 777), src)).toBe(true);
  });

  // The browser's own implementation, both ways. Single members only: browsers differ on
  // multi-member input and trailing bytes.
  it.each([
    ['gzip', 'gzip'],
    ['zlib', 'deflate'],
    ['deflate-raw', 'deflate-raw'],
  ] as const)('%s matches CompressionStream / DecompressionStream("%s")', async (format, name) => {
    const src = text(300_000);
    const theirs = await pipe(new CompressionStream(name) as TransformStream<Uint8Array, Uint8Array>, src, 65_536);
    expect(same(await z.decompress(theirs, { format }), src)).toBe(true);
    const ours = await z.compress(src, { format, level: 9 });
    expect(same(await pipe(new DecompressionStream(name) as TransformStream<Uint8Array, Uint8Array>, ours, 10_000), src)).toBe(true);
  });

  it('grows WebAssembly memory past 256 MiB and keeps working', async () => {
    const src = new Uint8Array(300 << 20);
    src[src.length - 1] = 7;
    const member = await z.compress(src, 1);
    const out = await z.decompress(member);
    expect(out.length).toBe(src.length);
    expect(out[out.length - 1]).toBe(7);
    expect(same(z.decompressSync(z.compressSync('still fine')), new TextEncoder().encode('still fine'))).toBe(true);
  });
});
