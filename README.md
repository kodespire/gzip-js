# gzip-js

[![CI](https://github.com/kodespire/gzip-js/actions/workflows/ci.yml/badge.svg)](https://github.com/kodespire/gzip-js/actions/workflows/ci.yml)

Gzip, zlib and raw deflate for Node.js, Bun, Deno, browsers and edge runtimes, with one API everywhere.

- **The official library.** Compiled from zlib v1.3.2 ([madler/zlib](https://github.com/madler/zlib)), pinned as a git submodule. A weekly job opens a PR when upstream releases.
- **Native where possible, WebAssembly everywhere else.** Node.js and Bun use a Node-API addon. Browsers, Deno and Workers use WebAssembly built from the same C code. If no prebuilt binary matches your platform, the package switches to WebAssembly on its own.
- **Same bytes everywhere.** Both builds produce identical output for the same input and options, on every platform.
- **No install scripts.** Prebuilt binaries ship inside the package. `npm install` never downloads or compiles anything.
- **Never returns partial data.** Cut-off input, corrupt input, unexpected bytes after the end and output over your size limit all throw. They never return what was decoded so far.

Part of the [compression-js](https://github.com/kodespire/compression-js) family.

```sh
npm install @kodespire/gzip-js
```

## Usage

```js
import { compress, decompress } from '@kodespire/gzip-js';

const packed = await compress(data, { level: 9 }); // or compress(data, 9)
const unpacked = await decompress(packed, { maxOutputSize: 64 * 1024 * 1024 });
```

`data` can be a `Uint8Array`, a Node `Buffer`, an `ArrayBuffer`, any typed array or `DataView`, or a string (encoded as UTF-8). Results are always plain `Uint8Array`s.

### Formats

Pass `format` to both `compress` and `decompress`. The default is `'gzip'`.

| `format` | Container | Written by | Integrity check |
| --- | --- | --- | --- |
| `'gzip'` | [RFC 1952](https://www.rfc-editor.org/rfc/rfc1952) | `gzip`, `CompressionStream('gzip')`, HTTP `Content-Encoding: gzip` | CRC-32 and length of each member |
| `'zlib'` | [RFC 1950](https://www.rfc-editor.org/rfc/rfc1950) | `CompressionStream('deflate')`, HTTP `Content-Encoding: deflate`, PNG | Adler-32 |
| `'deflate-raw'` | [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951) | `CompressionStream('deflate-raw')`, zip entries | none |

```js
const zlibbed = await compress(data, { format: 'zlib' });
const raw = await decompress(entryBytes, { format: 'deflate-raw' });
```

The data is never sniffed: decompressing with the wrong `format` throws `ERR_GZIP_LIBRARY`. Use `isGzip(data)` to check for a gzip header first.

### Streams

`createCompressStream()` and `createDecompressStream()` return standard [`TransformStream`](https://developer.mozilla.org/docs/Web/API/TransformStream)s, which work in every runtime:

```js
const response = await fetch(url);
const body = response.body.pipeThrough(createDecompressStream());
```

In Node.js, wrap them with `Duplex.fromWeb` to use them in a pipeline:

```js
import { createReadStream, createWriteStream } from 'node:fs';
import { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCompressStream } from '@kodespire/gzip-js';

await pipeline(
  createReadStream('data.json'),
  Duplex.fromWeb(createCompressStream({ level: 9 })),
  createWriteStream('data.json.gz'),
);
```

A decompress stream follows the same rules as `decompress` (below), and errors when they are broken.

### Synchronous calls

`compressSync` and `decompressSync` behave like their async versions.

- **Node.js and Bun:** they work right away.
- **Browsers, Deno and Workers:** the WebAssembly module loads asynchronously, so call `await init()` once first.

The async functions load the module on demand.

```js
import { init, compressSync } from '@kodespire/gzip-js';

await init();
const packed = compressSync('hello');
```

### Untrusted input

A megabyte of gzip can expand to a gigabyte. Always pass `maxOutputSize` when decompressing data you don't control. Decoding stops as soon as the limit is crossed:

```js
try {
  await decompress(upload, { maxOutputSize: 10 * 1024 * 1024 });
} catch (error) {
  if (error.code === 'ERR_GZIP_OUTPUT_LIMIT') rejectUpload();
}
```

### Dictionaries

The zlib and raw formats can use a preset dictionary: bytes likely to appear in the data. It helps most with small, similar payloads such as JSON records. The same dictionary is needed to decompress. The gzip format has no way to use one, so `dictionary` with `format: 'gzip'` throws.

```js
const packed = await compress(record, { format: 'zlib', dictionary });
const unpacked = await decompress(packed, { format: 'zlib', dictionary });
```

## Decoding rules

**gzip**
- **Every member is decoded**, and the results are joined in order, as `gunzip` does. `cat a.gz b.gz` decompresses to the contents of `a` followed by `b`.
- **Each member is checked**: its CRC-32 and length (ISIZE) must match the decoded data, and its header CRC must match when the header has one (FHCRC).
- **Zero padding after the last member is ignored.** Tape and block devices pad files with zeros, and `gzip -d`, node:zlib and Python accept that.
- **Any other byte after the last member is an error**, `ERR_GZIP_TRAILING_DATA`. This includes zeros followed by anything else, even another member: padding must run to the end of the input.
- **A partial member at the end is truncation.** If what follows a member starts like another one (`1f`, or `1f 8b`) but stops early, that is `ERR_GZIP_TRUNCATED`. Starting like a member but corrupt is `ERR_GZIP_LIBRARY`.

**zlib and raw deflate**
- **The input must be exactly one stream.** Any byte after its end is `ERR_GZIP_TRAILING_DATA`, zero bytes included. Neither format defines concatenation or padding.
- **zlib checks the Adler-32** of the decoded data, and the dictionary's when one is used.
- **Raw deflate has no checksum.** Corrupt input, or a missing or wrong dictionary, can decode to wrong bytes without an error, and only an invalid deflate stream is caught. Use gzip or zlib when integrity matters.

**Every format**
- **Empty input, or input that ends partway through a member or stream, is `ERR_GZIP_TRUNCATED`.** Compressing empty input gives a valid member (20 bytes of gzip), and that decompresses back to empty.
- **`maxOutputSize` counts the total**, across all members.
- **One case can't be detected:** input cut exactly at the end of a gzip member, or inside the zero padding, is valid input. Joined members are valid gzip, so nothing marks the end as missing. Use one member per message, or record the length yourself, if that matters.

**Why strict about trailing bytes.** Bytes after the data usually mean the input was assembled wrongly, or is not what you think it is. Decoders disagree on what to do with them:

| Decoder | Zeros after the last member | Other bytes after it |
| --- | --- | --- |
| GNU `gzip -d` (Linux) | ignored (a warning only with `-v`) | warning "trailing garbage ignored", exit status 2 |
| Apple `gzip -d` (macOS) | warning "trailing garbage ignored", exit status 2 | the same warning, exit status 2 |
| node:zlib `gunzipSync` | ignored, along with everything after the first zero | error |
| Python `gzip.decompress` | ignored; members after the zeros are decoded | error |
| **gzip-js** | ignored | **error**, also after zeros |

Every one of them treats garbage after the data as a problem, either an error or a warning with a failing exit status. Only zero padding is commonly accepted. gzip-js accepts exactly that, and only up to the end of the input.

## API

| Function | Description |
| --- | --- |
| `compress(data, options?)` | Compresses into one gzip member (or one zlib/raw stream). Returns `Promise<Uint8Array>`. |
| `decompress(data, options?)` | Decompresses, following the rules above. Returns `Promise<Uint8Array>`. |
| `compressSync` / `decompressSync` | Synchronous versions (see above). |
| `createCompressStream(options?)` | `TransformStream` that compresses its input into one member (or stream). |
| `createDecompressStream(options?)` | `TransformStream` that decompresses. Errors on cut-off, corrupt, trailing or oversized input. |
| `isGzip(data)` | `true` if `data` starts with a gzip member header (`1f 8b`, deflate, no reserved flags). Does not check the rest. |
| `init(source?)` | Loads the backend. `source` can be a URL, `Response`, bytes or `WebAssembly.Module` for `gzip.wasm`. |
| `activeBackend()` | `'native'` or `'wasm'`. |
| `ZLIB_VERSION`, `MIN_LEVEL`, `MAX_LEVEL`, `DEFAULT_LEVEL` | `'1.3.2'`, `0`, `9`, `6`. |

**Compress options**

| Option | Default | |
| --- | --- | --- |
| `format` | `'gzip'` | `'gzip'`, `'zlib'` or `'deflate-raw'`. |
| `level` | `6` | `0` (no compression, stored blocks) to `9` (smallest). A number in place of the options object sets just the level. |
| `memLevel` | `8` | `1` (least memory, slowest) to `9` (fastest). |
| `windowBits` | `15` | `9` (512-byte window) to `15` (32 KiB): how far back deflate looks for matches. |
| `strategy` | `'default'` | `'default'`, `'filtered'` (filtered or predicted data), `'huffman-only'` (no matching), `'rle'` (matches at distance 1 only; good for PNG data) or `'fixed'` (no dynamic Huffman codes). |
| `dictionary` | none | Preset dictionary. `'zlib'` and `'deflate-raw'` only. |

**Decompress options**

| Option | Default | |
| --- | --- | --- |
| `format` | `'gzip'` | The format of `data`. |
| `maxOutputSize` | `Infinity` | Throw `ERR_GZIP_OUTPUT_LIMIT` rather than produce more bytes than this. |
| `dictionary` | none | Dictionary the data was compressed with. `'zlib'` and `'deflate-raw'` only. |

Decompression always accepts any window size up to 32 KiB, so there is no `windowBits` option for it.

An unknown option name throws a `TypeError`. A typo like `{ compressionLevel: 9 }` fails loudly instead of quietly compressing at level 6.

**Errors** are `GzipError` instances, each with a `code`:

| Code | Meaning |
| --- | --- |
| `ERR_GZIP_TRUNCATED` | The input ended partway through a member or stream, or was empty. |
| `ERR_GZIP_TRAILING_DATA` | Something other than zero padding follows the last gzip member, or anything follows a zlib or raw stream. |
| `ERR_GZIP_OUTPUT_LIMIT` | The output would exceed `maxOutputSize`. |
| `ERR_GZIP_LIBRARY` | zlib rejected the data: wrong format, corrupt input, CRC-32/length/Adler-32 mismatch, missing or wrong dictionary. The message is zlib's, for example `zlib: incorrect data check`. |
| `ERR_GZIP_NOT_INITIALIZED` | A sync function was called in a browser or Worker before `await init()`. |
| `ERR_GZIP_OUT_OF_MEMORY`, `ERR_GZIP_INVALID_ARGUMENT` | As named. |

## Behaviour details

- **Output doesn't depend on the runtime.** gzip members get a fixed header: no file name or comment, MTIME 0, and OS 255 ("unknown"). Without that, zlib writes the build platform's OS code, and output would differ between macOS, Linux, Windows and WebAssembly. The native and WebAssembly builds produce the same bytes, which the tests check across formats, levels and strategies.
- **Streaming gives the same bytes as one-shot compression,** however the input is split, at levels 1 to 9. At level 0 the stored blocks follow the chunks you write; the data decompresses the same either way.
- **The async functions use separate threads only on the native addon**, which runs them on Node's thread pool. The WebAssembly backend runs on the calling thread, so for large inputs in a browser, call it from a Web Worker.
- **Forcing WebAssembly:** set `GZIP_JS_BACKEND=wasm` in Node.js, or import `@kodespire/gzip-js/wasm` in any runtime.
- **Your process's own zlib is untouched.** The bundled copy is compiled with its symbols renamed (`Z_PREFIX`), so it never clashes with the zlib inside Node.js, Bun or Electron.

## Runtimes

| Runtime | Backend | Tested in CI |
| --- | --- | --- |
| Node.js 22.12+, 24, 26 | native | Linux x64/arm64, macOS, Windows |
| Bun | native | Linux |
| Deno 2 | WebAssembly | Linux |
| Chromium, Firefox, WebKit | WebAssembly | Playwright, through Vite |
| Cloudflare Workers (`workerd` condition) | WebAssembly | `wrangler dev` (workerd) |

Prebuilt native binaries cover:
- macOS arm64 and x64
- Linux x64 and arm64 (glibc 2.28+ and musl)
- Windows x64 and arm64

Bundlers that understand `new URL('./gzip.wasm', import.meta.url)`, such as Vite, webpack 5 and Parcel, pick up the WebAssembly file automatically. For anything else, serve `@kodespire/gzip-js/gzip.wasm` yourself and pass its URL to `init()`.

## Development

```sh
git clone --recursive https://github.com/kodespire/gzip-js
npm install
npm run build:native   # Node-API addon (needs Python 3 and a C/C++ compiler)
npm run build:wasm     # gzip.wasm (needs Emscripten; see .emsdk-version)
npm run build:ts       # dist/
npm test
BROWSERS=chromium npx vitest run -c vitest.browser.config.ts
```

All compression logic is in `csrc/gjs.c`, which both builds share. `csrc/addon.cc` (Node-API) and `src/wasm-backend.ts` (WebAssembly) only move bytes in and out. zlib's own `.c` files are compiled directly; there is no configure or CMake step. The tests run every case against both backends. They also check output against independent implementations, in both directions:
- the system `gzip` command
- Python's `zlib` module, for the zlib and raw formats
- node:zlib, and `CompressionStream` / `DecompressionStream`, in Node.js and in each browser

They also cover input cut at every byte, corruption, trailing data at every split point, and property-based round trips with random options.

## License

MIT. The bundled zlib library is under the zlib license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
