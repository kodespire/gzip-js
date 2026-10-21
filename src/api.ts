import {
  resolveCompressOptions,
  resolveDecompressOptions,
  toBytes,
  toInputBytes,
} from './options.js';
import {
  MODE_CONTINUE,
  MODE_END,
  type Backend,
  type BackendKind,
  type BackendProvider,
  type Bytes,
  type CompressOptions,
  type CStreamHandle,
  type DecompressOptions,
  type DStreamHandle,
  type WasmSource,
} from './types.js';

const EMPTY = new Uint8Array(0);

/**
 * True if `data` starts with a gzip member header: the magic bytes 1f 8b, compression method 8
 * (deflate) and no reserved flag bits, in a header at least 10 bytes long. Does not validate the rest.
 */
export function isGzip(data: Bytes): boolean {
  const b = toBytes(data, 'data');
  return b.length >= 10 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8 && (b[3]! & 0xe0) === 0;
}

export function createApi(provider: BackendProvider) {
  // Starts `call` with the caller's bytes as they are right now. A loaded backend is
  // called immediately, and every backend copies its inputs before returning. While
  // the backend is still loading, the inputs are copied first (new Uint8Array copies;
  // Buffer#slice would return a view), so changes made after the call are not seen.
  function withBackend<T>(
    inputs: (Uint8Array | null)[],
    call: (backend: Backend, inputs: (Uint8Array | null)[]) => Promise<T>,
  ): Promise<T> {
    const backend = provider.ready();
    if (backend) return call(backend, inputs);
    const copies = inputs.map((input) => input && new Uint8Array(input));
    return provider.get().then((loaded) => call(loaded, copies));
  }

  /** Compresses `data` into one gzip member (or zlib/raw stream). Strings are encoded as UTF-8. */
  async function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array> {
    const p = resolveCompressOptions(options, 'compress');
    return withBackend([toInputBytes(data), p.dictionary], (backend, [input, dictionary]) =>
      backend.compress(input!, { ...p, dictionary: dictionary! }));
  }

  /** Synchronous `compress`. In browsers and edge runtimes, call `await init()` first. */
  function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array {
    const p = resolveCompressOptions(options, 'compressSync');
    return provider.getSync().compressSync(toInputBytes(data), p);
  }

  /**
   * Decompresses `data`: every gzip member, or the one zlib/raw stream. Throws GzipError if the data
   * is corrupt, incomplete (ERR_GZIP_TRUNCATED), followed by other data (ERR_GZIP_TRAILING_DATA) or
   * would exceed `maxOutputSize` (ERR_GZIP_OUTPUT_LIMIT).
   */
  async function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array> {
    const p = resolveDecompressOptions(options, 'decompress');
    return withBackend([toBytes(data, 'data'), p.dictionary], (backend, [input, dictionary]) =>
      backend.decompress(input!, { ...p, dictionary: dictionary! }));
  }

  /** Synchronous `decompress`. In browsers and edge runtimes, call `await init()` first. */
  function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array {
    const p = resolveDecompressOptions(options, 'decompressSync');
    return provider.getSync().decompressSync(toBytes(data, 'data'), p);
  }

  /** A TransformStream that compresses its input into one gzip member (or zlib/raw stream). */
  function createCompressStream(options?: CompressOptions | number): TransformStream<Bytes, Uint8Array> {
    const p = resolveCompressOptions(options, 'createCompressStream');
    let handle: CStreamHandle | undefined;
    const close = () => {
      handle?.close();
      handle = undefined;
    };
    return new TransformStream<Bytes, Uint8Array>({
      start() {
        return withBackend([p.dictionary], async (backend, [dictionary]) => {
          handle = backend.createCStream({ ...p, dictionary: dictionary! });
        });
      },
      async transform(chunk, controller) {
        try {
          const out = await handle!.pushAsync(toBytes(chunk, 'chunk'), MODE_CONTINUE);
          if (out.length > 0) controller.enqueue(out);
        } catch (error) {
          close();
          throw error;
        }
      },
      async flush(controller) {
        try {
          const out = await handle!.pushAsync(EMPTY, MODE_END);
          if (out.length > 0) controller.enqueue(out);
        } finally {
          close();
        }
      },
      cancel: close,
    } as Transformer<Bytes, Uint8Array>);
  }

  /**
   * A TransformStream that decompresses. Errors if the input is corrupt, incomplete, followed by
   * other data, or exceeds `maxOutputSize` in total.
   */
  function createDecompressStream(options?: DecompressOptions): TransformStream<Bytes, Uint8Array> {
    const p = resolveDecompressOptions(options, 'createDecompressStream');
    let handle: DStreamHandle | undefined;
    const close = () => {
      handle?.close();
      handle = undefined;
    };
    return new TransformStream<Bytes, Uint8Array>({
      start() {
        return withBackend([p.dictionary], async (backend, [dictionary]) => {
          handle = backend.createDStream({ ...p, dictionary: dictionary! });
        });
      },
      async transform(chunk, controller) {
        try {
          const out = await handle!.pushAsync(toBytes(chunk, 'chunk'));
          if (out.length > 0) controller.enqueue(out);
        } catch (error) {
          close();
          throw error;
        }
      },
      flush() {
        try {
          handle!.finish();
        } finally {
          close();
        }
      },
      cancel: close,
    } as Transformer<Bytes, Uint8Array>);
  }

  /**
   * Loads the backend ahead of time. Required before synchronous calls in browsers and edge
   * runtimes. `source` overrides where the WebAssembly module is loaded from; it is ignored
   * when the native addon is in use.
   */
  async function init(source?: WasmSource): Promise<void> {
    await provider.init(source);
  }

  /** Which implementation is running: the native addon or WebAssembly. */
  function activeBackend(): BackendKind {
    return provider.kind();
  }

  return {
    compress,
    compressSync,
    decompress,
    decompressSync,
    createCompressStream,
    createDecompressStream,
    init,
    activeBackend,
  };
}
