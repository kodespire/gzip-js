// Self-test of @kodespire/gzip-js on a device or simulator. Each result is logged as
// one `GZIP_SELFTEST ...` line, which scripts/selftest.mjs reads from the device log,
// and the last line is `GZIP_SELFTEST DONE passed=N failed=M`.
import {
  activeBackend,
  compress,
  compressSync,
  createCompressStream,
  createDecompressStream,
  decompress,
  decompressSync,
  type CompressOptions,
  type Format,
  GzipError,
  init,
  isGzip,
  ZLIB_VERSION,
} from '@kodespire/gzip-js';
import { type TurboModule, TurboModuleRegistry } from 'react-native';

// @ts-ignore generated plain JS
import fixtureData, { references as referenceData } from './fixtures.generated';

declare const require: (id: string) => unknown;

type Log = (line: string) => void;

/** The one method of the native module this test calls directly. */
interface NativeVersion extends TurboModule {
  version(): string;
}
type Reference = [input: string, options: Omit<CompressOptions, 'dictionary'> & { dictionary?: true }, length: number, fnv: number];

const FORMATS: Format[] = ['gzip', 'zlib', 'deflate-raw'];
const references = referenceData as Reference[];

function fixture(name: string): Uint8Array {
  const binary = atob((fixtureData as Record<string, string>)[name]!);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Deterministic, moderately compressible bytes. */
function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'gzip ', 'member ', 'block ', '\n'];
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  let i = 0;
  while (i < length) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = words[(x & 0xff) % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return h;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert(actual instanceof Uint8Array, `${what}: not a Uint8Array`);
  assert(actual.length === expected.length, `${what}: length ${actual.length}, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${what}: differs at byte ${i}`);
  }
}

async function assertCode(run: () => unknown, code: string, what: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof GzipError, `${what}: threw ${String(error)}, expected a GzipError`);
    assert(error.code === code, `${what}: code ${error.code}, expected ${code}`);
    return;
  }
  throw new Error(`${what}: did not throw ${code}`);
}

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, chunks: Uint8Array[]): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parts.push(value);
    }
  })();
  const writing = (async () => {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  })();
  await Promise.all([reading, writing]);
  return concat(...parts);
}

function split(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  return chunks;
}

const bytes = (...values: number[]) => new Uint8Array(values);

const tests: [name: string, run: (log: Log) => Promise<void>][] = [
  ['native backend with the bundled zlib', async (log) => {
    await init();
    assert(activeBackend() === 'native', `activeBackend() is ${activeBackend()}`);
    // zlibVersion() of the linked library. iOS and Android ship a system libz with
    // another version, so this fails if the module linked that instead.
    const native = TurboModuleRegistry.get<NativeVersion>('KodespireGzip');
    assert(native, 'the KodespireGzip module is not registered');
    assert(native.version() === ZLIB_VERSION, `native zlib ${native.version()}, expected ${ZLIB_VERSION}`);
    log(`info zlib ${native.version()}`);
  }],

  ['round trip, every format', async () => {
    const data = textBytes(1 << 20);
    for (const format of FORMATS) {
      for (const options of [{ format }, { format, level: 1 }, { format, level: 9, strategy: 'filtered' as const }, { format, level: 0 }]) {
        const what = JSON.stringify(options);
        const packed = await compress(data, options);
        assert(isGzip(packed) === (format === 'gzip'), `${what}: isGzip`);
        assertBytes(await decompress(packed, { format }), data, `async, ${what}`);
        assertBytes(decompressSync(compressSync(data, options), { format }), data, `sync, ${what}`);
      }
      const text = 'héllo € 😀 '.repeat(100);
      assertBytes(decompressSync(compressSync(text, { format }), { format }), new TextEncoder().encode(text), `${format}: string input`);
      assertBytes(await decompress(await compress(new Uint8Array(0), { format }), { format }), new Uint8Array(0), `${format}: empty input`);
      // A view into a larger buffer: only the viewed bytes are compressed.
      const view = new Uint8Array(data.buffer, 1000, 5000);
      assertBytes(await decompress(await compress(view, { format }), { format }), data.subarray(1000, 6000), `${format}: subarray input`);
    }
    assert(compressSync(new Uint8Array(0)).length === 20, 'an empty gzip member is not 20 bytes');
  }],

  ['data from gzip and Python', async () => {
    const corpus = fixture('corpus.txt');
    assertBytes(await decompress(fixture('corpus.9.gz')), corpus, 'corpus.9.gz (gzip -9)');
    assertBytes(decompressSync(fixture('corpus.name.gz')), corpus, 'corpus.name.gz (FNAME header)');
    assertBytes(await decompress(fixture('corpus.zlib'), { format: 'zlib' }), corpus, 'corpus.zlib');
    assertBytes(decompressSync(fixture('corpus.small-window.zlib'), { format: 'zlib' }), corpus, 'corpus.small-window.zlib');
    assertBytes(await decompress(fixture('corpus.raw'), { format: 'deflate-raw' }), corpus, 'corpus.raw');
    assertBytes(decompressSync(fixture('empty.gz')), new Uint8Array(0), 'empty.gz');
  }],

  ['multi-member gzip', async () => {
    const corpus = fixture('corpus.txt');
    assertBytes(await decompress(fixture('corpus.multi.gz')), corpus, 'corpus.multi.gz (two members from gzip)');
    const a = textBytes(50_000, 2);
    const b = textBytes(30_000, 3);
    const joined = concat(compressSync(a), compressSync(new Uint8Array(0)), await compress(b, 9));
    assertBytes(decompressSync(joined), concat(a, b), 'three members, one empty');
    assertBytes(await decompress(concat(joined, new Uint8Array(512))), concat(a, b), 'zero padding after the last member');
    await assertCode(() => decompress(joined, { maxOutputSize: a.length + b.length - 1 }), 'ERR_GZIP_OUTPUT_LIMIT', 'maxOutputSize counts all members');
  }],

  ['trailing data', async () => {
    const data = textBytes(20_000, 4);
    const member = compressSync(data);
    const cases: [what: string, input: Uint8Array, code: string][] = [
      ['gzip, then text', concat(member, new TextEncoder().encode('GARBAGE')), 'ERR_GZIP_TRAILING_DATA'],
      ['gzip, then zeros and other data', concat(member, bytes(0, 0, 0x41)), 'ERR_GZIP_TRAILING_DATA'],
      ['gzip, then zeros and another member', concat(member, bytes(0, 0), member), 'ERR_GZIP_TRAILING_DATA'],
      ['gzip, then 1f (start of a member)', concat(member, bytes(0x1f)), 'ERR_GZIP_TRUNCATED'],
      ['gzip, then 1f 8b (start of a member)', concat(member, bytes(0x1f, 0x8b)), 'ERR_GZIP_TRUNCATED'],
      ['gzip, then 1f 00', concat(member, bytes(0x1f, 0)), 'ERR_GZIP_TRAILING_DATA'],
    ];
    for (const format of ['zlib', 'deflate-raw'] as const) {
      const stream = compressSync(data, { format });
      cases.push([`${format}, then a zero byte`, concat(stream, bytes(0)), 'ERR_GZIP_TRAILING_DATA']);
      cases.push([`${format}, then another stream`, concat(stream, stream), 'ERR_GZIP_TRAILING_DATA']);
    }
    for (const [what, input, code] of cases) {
      const format: Format = what.startsWith('zlib') ? 'zlib' : what.startsWith('deflate-raw') ? 'deflate-raw' : 'gzip';
      await assertCode(() => decompress(input, { format }), code, `${what}, async`);
      await assertCode(() => decompressSync(input, { format }), code, `${what}, sync`);
    }
  }],

  ['truncated and corrupt input', async () => {
    for (const format of FORMATS) {
      const packed = compressSync(textBytes(100_000, 5), { format });
      for (const end of [1, 2, packed.length >> 1, packed.length - 1]) {
        const cut = packed.subarray(0, end);
        await assertCode(() => decompress(cut, { format }), 'ERR_GZIP_TRUNCATED', `${format}: decompress, ${end} bytes`);
        await assertCode(() => decompressSync(cut, { format }), 'ERR_GZIP_TRUNCATED', `${format}: decompressSync, ${end} bytes`);
      }
      await assertCode(() => decompress(new Uint8Array(0), { format }), 'ERR_GZIP_TRUNCATED', `${format}: empty input`);
    }
    const gz = compressSync(textBytes(100_000, 6));
    const badCrc = gz.slice();
    badCrc[badCrc.length - 6] ^= 0xff;
    await assertCode(() => decompress(badCrc), 'ERR_GZIP_LIBRARY', 'gzip with a wrong CRC-32');
    const zl = compressSync(textBytes(100_000, 6), { format: 'zlib' });
    const badAdler = zl.slice();
    badAdler[badAdler.length - 1] ^= 0xff;
    await assertCode(() => decompressSync(badAdler, { format: 'zlib' }), 'ERR_GZIP_LIBRARY', 'zlib with a wrong Adler-32');
    await assertCode(() => decompress(zl), 'ERR_GZIP_LIBRARY', 'zlib data read as gzip');
  }],

  ['maxOutputSize', async () => {
    const data = textBytes(200_000, 7);
    for (const format of FORMATS) {
      const packed = await compress(data, { format });
      await assertCode(() => decompress(packed, { format, maxOutputSize: data.length - 1 }), 'ERR_GZIP_OUTPUT_LIMIT', `${format}: async, one byte short`);
      await assertCode(() => decompressSync(packed, { format, maxOutputSize: 0 }), 'ERR_GZIP_OUTPUT_LIMIT', `${format}: sync, limit 0`);
      assertBytes(await decompress(packed, { format, maxOutputSize: data.length }), data, `${format}: exact limit`);
    }
    await assertCode(() => decompress(new Uint8Array(0), { maxOutputSize: 10 }), 'ERR_GZIP_TRUNCATED', 'empty input with a limit');
  }],

  ['async work runs off the JS thread', async (log) => {
    // Grow the input until one async compress takes long enough to measure, then
    // check the JS thread kept running timers the whole time.
    let size = 4 << 20;
    for (;;) {
      const data = textBytes(size);
      let last = performance.now();
      let maxGap = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
      }, 10);
      const start = performance.now();
      const packed = await compress(data, 9);
      const elapsed = performance.now() - start;
      clearInterval(timer);
      if (elapsed < 400 && size < 64 << 20) {
        size *= 2;
        continue;
      }
      assertBytes(decompressSync(packed), data, 'output');
      log(`info compress(${size >> 20} MiB, 9): ${elapsed.toFixed(0)} ms, ${ticks} timer ticks, longest JS stall ${maxGap.toFixed(0)} ms`);
      assert(ticks >= 10, `only ${ticks} timer ticks in ${elapsed.toFixed(0)} ms`);
      assert(maxGap < elapsed / 2, `JS thread stalled for ${maxGap.toFixed(0)} ms of ${elapsed.toFixed(0)} ms`);
      break;
    }
    // Several jobs at once, and inputs captured at call time.
    const inputs = [1, 2, 3, 4].map((seed) => textBytes(500_000, seed));
    const expected = inputs.map((input) => input.slice());
    const pending = inputs.map((input, i) => compress(input, { format: FORMATS[i % 3], level: 6 }));
    for (const input of inputs) input.fill(0);
    const outputs = await Promise.all(pending);
    for (let i = 0; i < outputs.length; i++) {
      assertBytes(decompressSync(outputs[i]!, { format: FORMATS[i % 3] }), expected[i]!, `job ${i}`);
    }
  }],

  ['dictionary', async () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    assertBytes(await decompress(fixture('record.dict.zlib'), { format: 'zlib', dictionary }), record, 'zlib from Python');
    assertBytes(decompressSync(fixture('record.dict.raw'), { format: 'deflate-raw', dictionary }), record, 'raw from Python');
    for (const format of ['zlib', 'deflate-raw'] as const) {
      const packed = await compress(record, { format, dictionary, level: 9 });
      assertBytes(decompressSync(packed, { format, dictionary }), record, `${format}: round trip`);
      assert(packed.length < compressSync(record, { format, level: 9 }).length, `${format}: dictionary did not shrink the output`);
    }
    await assertCode(() => decompress(fixture('record.dict.zlib'), { format: 'zlib' }), 'ERR_GZIP_LIBRARY', 'zlib without the dictionary');
    let threw = false;
    try {
      compressSync(record, { dictionary });
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, 'a dictionary with format gzip did not throw a TypeError');
  }],

  ['options are checked', async () => {
    const throwsTypeError = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof TypeError || error instanceof RangeError;
      }
      return false;
    };
    assert(throwsTypeError(() => compressSync(new Uint8Array(1), { compressionLevel: 3 } as never)), 'an unknown option');
    assert(throwsTypeError(() => compressSync(new Uint8Array(1), { level: 10 })), 'level 10');
    assert(throwsTypeError(() => compressSync(new Uint8Array(1), { format: 'brotli' as never })), 'an unknown format');
    assert(throwsTypeError(() => decompressSync(new Uint8Array(1), { maxOutputSize: -1 })), 'a negative maxOutputSize');
  }],

  ['streams', async (log) => {
    if (typeof TransformStream === 'undefined') {
      let message = '';
      try {
        createCompressStream();
      } catch (error) {
        message = String(error);
      }
      assert(/TransformStream/.test(message), `without a TransformStream: ${message || 'no error'}`);
      require('web-streams-polyfill/polyfill');
      log('info no global TransformStream: using web-streams-polyfill');
    }
    const data = textBytes(1 << 20, 8);
    for (const format of FORMATS) {
      const packed = await pipe(createCompressStream({ format, level: 5 }), split(data, 65_536));
      assertBytes(packed, compressSync(data, { format, level: 5 }), `${format}: stream equals one-shot`);
      assertBytes(await pipe(createDecompressStream({ format }), split(packed, 7_000)), data, `${format}: decompress stream`);
      await assertCode(() => pipe(createDecompressStream({ format }), [packed.subarray(0, packed.length - 3)]), 'ERR_GZIP_TRUNCATED', `${format}: truncated stream`);
      await assertCode(() => pipe(createDecompressStream({ format, maxOutputSize: 1000 }), [packed]), 'ERR_GZIP_OUTPUT_LIMIT', `${format}: stream over maxOutputSize`);
    }
    const multi = fixture('corpus.multi.gz');
    assertBytes(await pipe(createDecompressStream(), split(multi, 1_000)), fixture('corpus.txt'), 'multi-member stream');
    const member = compressSync(data.subarray(0, 10_000));
    await assertCode(() => pipe(createDecompressStream(), [member, bytes(0, 0, 0x41)]), 'ERR_GZIP_TRAILING_DATA', 'stream with trailing data');
    await assertCode(() => pipe(createDecompressStream(), [member, bytes(0x1f)]), 'ERR_GZIP_TRUNCATED', 'stream ending in 1f');
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    const dictPacked = await pipe(createCompressStream({ format: 'zlib', dictionary }), [record]);
    assertBytes(decompressSync(dictPacked, { format: 'zlib', dictionary }), record, 'dictionary stream');
  }],

  ['same bytes as WebAssembly', async (log) => {
    // prepare.mjs compressed the same inputs with the package's gzip.wasm.
    let streamed = 0;
    for (const [input, refOptions, length, hash] of references) {
      const data = input === 'empty' ? new Uint8Array(0) : fixture(input);
      const options: CompressOptions = { ...refOptions, dictionary: refOptions.dictionary ? fixture('dict.bin') : undefined };
      const what = `${input} ${JSON.stringify(refOptions)}`;
      const sync = compressSync(data, options);
      assert(sync.length === length && fnv1a(sync) === hash, `${what}: sync output differs from WebAssembly (${sync.length} bytes, expected ${length})`);
      const packed = await compress(data, options);
      assert(packed.length === length && fnv1a(packed) === hash, `${what}: async output differs from WebAssembly`);
      // Streams give the same bytes at levels 1-9; at level 0 stored blocks follow the chunks.
      // (The streams test above installed a TransformStream if there was none.)
      if (options.level !== 0) {
        const out = await pipe(createCompressStream(options), split(data, 10_000));
        assert(out.length === length && fnv1a(out) === hash, `${what}: stream output differs from WebAssembly`);
        streamed++;
      }
    }
    assert(references.length >= 35 && streamed >= 30, `only ${references.length} references, ${streamed} streamed`);
    log(`info ${references.length} outputs match gzip.wasm (${streamed} also streamed)`);
  }],

  ['speed', async (log) => {
    const data = textBytes(8 << 20);
    let start = performance.now();
    const packed = compressSync(data);
    const compressMs = performance.now() - start;
    start = performance.now();
    decompressSync(packed);
    const decompressMs = performance.now() - start;
    const mbps = (ms: number) => (data.length / 1e6 / (ms / 1000)).toFixed(0);
    log(`info level 6, 8 MiB: compress ${mbps(compressMs)} MB/s, decompress ${mbps(decompressMs)} MB/s, ratio ${(data.length / packed.length).toFixed(2)}`);
  }],
];

export async function runSelfTest(log: Log): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  for (const [name, run] of tests) {
    const start = performance.now();
    try {
      await run(log);
      passed++;
      log(`ok ${name} (${(performance.now() - start).toFixed(0)} ms)`);
    } catch (error) {
      failed++;
      log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`DONE passed=${passed} failed=${failed}`);
  return failed === 0;
}
