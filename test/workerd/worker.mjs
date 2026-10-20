// Cloudflare Workers smoke test: resolves the package through the "workerd"
// export condition, which imports gzip.wasm statically. Run with run.mjs.
import * as z from '@kodespire/gzip-js';

export default {
  async fetch() {
    const result = {};
    try {
      const src = new TextEncoder().encode('workerd '.repeat(20_000));
      const member = await z.compress(src, 9);
      result.roundTrip = (await z.decompress(member)).length === src.length;
      await z.init();
      result.sync = ['gzip', 'zlib', 'deflate-raw'].every(
        (format) => z.decompressSync(z.compressSync('abc', { format }), { format }).length === 3,
      );
      try {
        await z.decompress(member.subarray(0, member.length - 3));
        result.truncated = 'no error';
      } catch (error) {
        result.truncated = error.code;
      }
      const body = new Response(src).body.pipeThrough(z.createCompressStream()).pipeThrough(z.createDecompressStream());
      result.stream = (await new Response(body).arrayBuffer()).byteLength === src.length;
      // The runtime's own gzip, both ways.
      const theirs = await new Response(new Response(src).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      const back = await new Response(new Response(member).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      result.interop = (await z.decompress(theirs)).length === src.length && back.byteLength === src.length;
      result.backend = z.activeBackend();
      result.version = z.ZLIB_VERSION;
    } catch (error) {
      result.error = String(error?.stack ?? error);
    }
    return Response.json(result);
  },
};
