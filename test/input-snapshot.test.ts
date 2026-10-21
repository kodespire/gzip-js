// Async calls must use the bytes as they were when the call was made, even if the
// caller changes its buffer before the promise settles. Regression: 0.1.0 awaited
// the backend before handing it the input, so a change made right after the call
// (on any call, not only while the WebAssembly module was loading) was compressed.
// The wasm backend is first used in this file by these tests, so the loading path
// is covered too.
import { describe, expect, it } from 'vitest';

import { backends, FORMATS, pipeChunks, textBytes } from './helpers.js';

describe.each(backends)('%s backend: async calls capture their input at call time', (_name, z) => {
  it.each(FORMATS)('compress (%s) ignores changes made to the input after the call', async (format) => {
    const original = textBytes(200_000, 41);
    const buf = Buffer.from(original);
    const pending = z.compress(buf, { format });
    buf.fill(0);
    expect(z.decompressSync(await pending, { format })).toEqualBytes(original);
  });

  it.each(FORMATS)('decompress (%s) ignores changes made to the input after the call', async (format) => {
    const original = textBytes(200_000, 42);
    const packed = Buffer.from(z.compressSync(original, { format }));
    const pending = z.decompress(packed, { format });
    packed.fill(0);
    expect(await pending).toEqualBytes(original);
  });

  it.each(['zlib', 'deflate-raw'] as const)('dictionaries (%s) are captured when the call or stream is made', async (format) => {
    // Compare compressed bytes: they show which dictionary deflate searched.
    const dictCopy = textBytes(8_000, 43);
    const src = new Uint8Array([...dictCopy.subarray(0, 4_000), ...textBytes(20_000, 44)]);
    const expected = z.compressSync(src, { format, dictionary: dictCopy });

    const dictionary = Buffer.from(dictCopy);
    const pending = z.compress(src, { format, dictionary });
    dictionary.fill(0);
    expect(await pending).toEqualBytes(expected);

    const inflateDictionary = Buffer.from(dictCopy);
    const unpacked = z.decompress(expected, { format, dictionary: inflateDictionary });
    inflateDictionary.fill(0);
    expect(await unpacked).toEqualBytes(src);

    const streamed = await pipeChunks(z.createCompressStream({ format, dictionary: dictCopy }), src);
    const streamDictionary = Buffer.from(dictCopy);
    const stream = z.createCompressStream({ format, dictionary: streamDictionary });
    streamDictionary.fill(0);
    expect(await pipeChunks(stream, src)).toEqualBytes(streamed);

    const dstreamDictionary = Buffer.from(dictCopy);
    const dstream = z.createDecompressStream({ format, dictionary: dstreamDictionary });
    dstreamDictionary.fill(0);
    expect(await pipeChunks(dstream, expected)).toEqualBytes(src);
  });
});
