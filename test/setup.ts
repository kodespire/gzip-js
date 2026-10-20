// toEqualBytes: byte-array equality via Buffer.compare. Vitest's toEqual walks
// typed arrays element by element (about 2 s per MiB), which dominated the run.
// Accepts any ArrayBuffer or view on either side, so a Buffer fixture compares
// with a Uint8Array result.
import { expect } from 'vitest';

function asBytes(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const hex = (v: number | undefined) => (v === undefined ? 'end of data' : `0x${v.toString(16).padStart(2, '0')}`);

expect.extend({
  toEqualBytes(received: unknown, expected: unknown) {
    const a = asBytes(received);
    const b = asBytes(expected);
    if (!a || !b) {
      return { pass: false, message: () => `expected two byte arrays, got ${typeof received} and ${typeof expected}` };
    }
    const pass = Buffer.compare(a, b) === 0;
    return {
      pass,
      message: () => {
        if (pass) return `expected the ${a.length} bytes to differ`;
        const at = firstDifference(a, b);
        return `expected ${b.length} bytes, got ${a.length}; first difference at offset ${at}: got ${hex(a[at])}, expected ${hex(b[at])}`;
      },
    };
  },
});

declare module 'vitest' {
  interface Matchers<T = any> {
    toEqualBytes(expected: ArrayBuffer | ArrayBufferView): T;
  }
}
