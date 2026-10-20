// Smoke test for an installed copy of the package, runnable under Node, Bun and Deno:
//   EXPECT_BACKEND=native node smoke.mjs
//   EXPECT_BACKEND=native bun smoke.mjs
//   EXPECT_BACKEND=wasm deno run -A --node-modules-dir=manual smoke.mjs
// Copy it next to a node_modules that has @kodespire/gzip-js installed.
import * as z from '@kodespire/gzip-js';

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  globalThis.process?.exit?.(1);
  globalThis.Deno?.exit?.(1);
  throw new Error(message);
};
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const codeOf = async (fn) => {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return error.code;
  }
};

const runtime = globalThis.Deno ? `deno ${Deno.version.deno}` : globalThis.Bun ? `bun ${Bun.version}` : `node ${process.version}`;
const src = new TextEncoder().encode('smoke test '.repeat(50_000));

const member = await z.compress(src, { level: 9 });
if (!z.isGzip(member)) fail('isGzip');
if (!equal(await z.decompress(member), src)) fail('async round trip');
await z.init();
for (const format of ['gzip', 'zlib', 'deflate-raw']) {
  if (!equal(z.decompressSync(z.compressSync(src, { format }), { format }), src)) fail(`sync round trip (${format})`);
}

// Multi-member input joins, as gunzip does.
const joined = new Uint8Array([...z.compressSync('abc'), ...z.compressSync('def')]);
if (new TextDecoder().decode(z.decompressSync(joined)) !== 'abcdef') fail('multi-member');

let code = await codeOf(() => z.decompress(member.subarray(0, member.length - 3)));
if (code !== 'ERR_GZIP_TRUNCATED') fail(`truncated input gave ${code}`);
code = await codeOf(() => z.decompress(new Uint8Array([...member, 0x41])));
if (code !== 'ERR_GZIP_TRAILING_DATA') fail(`trailing data gave ${code}`);

// The runtime's own CompressionStream output decodes, and ours decodes there.
if (typeof CompressionStream === 'function') {
  const theirs = await new Response(new Blob([src]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  if (!equal(await z.decompress(theirs), src)) fail('decoding CompressionStream output');
  const back = await new Response(new Blob([member]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if (!equal(new Uint8Array(back), src)) fail('DecompressionStream decoding our output');
}

const streamed = await new Response(new Blob([src]).stream().pipeThrough(z.createCompressStream()).pipeThrough(z.createDecompressStream())).arrayBuffer();
if (!equal(new Uint8Array(streamed), src)) fail('stream round trip');

const backend = z.activeBackend();
const expected = globalThis.process?.env?.EXPECT_BACKEND ?? globalThis.Deno?.env.get('EXPECT_BACKEND');
if (expected && backend !== expected) fail(`backend is ${backend}, expected ${expected}`);

console.log(`ok: ${runtime}, backend=${backend}, zlib ${z.ZLIB_VERSION}, ${src.length} -> ${member.length} bytes`);
