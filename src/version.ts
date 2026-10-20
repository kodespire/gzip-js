// Must match deps/zlib (checked by test/version.test.ts).
/** Version of the bundled zlib library, the same for the native and WebAssembly builds. */
export const ZLIB_VERSION = '1.3.2';
/** Lowest compression level: 0 stores the data without compressing it. */
export const MIN_LEVEL = 0;
/** Highest-ratio compression level. */
export const MAX_LEVEL = 9;
/** Level used when none is given. */
export const DEFAULT_LEVEL = 6;
