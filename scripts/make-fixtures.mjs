// Regenerates test/fixtures with independent implementations: the system
// `gzip` command, and Python's zlib module for the zlib and raw formats.
// The fixtures are committed; rerun this only when changing them.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures');
mkdirSync(out, { recursive: true });

// Deterministic, compressible text.
function corpus(seed, words) {
  const vocab = 'the quick brown fox jumps over lazy dog gzip member deflate block window literal match offset huffman table stream buffer chunk'.split(' ');
  let x = seed >>> 0;
  const parts = [];
  for (let i = 0; i < words; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    parts.push(vocab[x % vocab.length]);
    if (x % 17 === 0) parts.push(`${x % 100000}\n`);
  }
  return Buffer.from(parts.join(' '));
}

const run = (cmd, args, input) => execFileSync(cmd, args, { input, maxBuffer: 1 << 30 });
const gzip = (args, input) => run('gzip', args, input);
// zlib.compressobj(level, DEFLATED, wbits, memLevel, strategy[, zdict]) over stdin; argv[1] is a JSON array.
const PY = `
import json, sys, zlib
level, wbits, mem, strategy, zdict = json.loads(sys.argv[1])
kw = {'zdict': open(zdict, 'rb').read()} if zdict else {}
c = zlib.compressobj(level, zlib.DEFLATED, wbits, mem, strategy, **kw)
sys.stdout.buffer.write(c.compress(sys.stdin.buffer.read()) + c.flush())
`;
const py = (params, input) => run('python3', ['-I', '-c', PY, JSON.stringify(params)], input);
const write = (name, data) => writeFileSync(join(out, name), data);

const text = corpus(1, 30000);
write('corpus.txt', text);

// --- gzip, from the system gzip command ---
// -n: no name or timestamp in the header, so regenerating gives the same bytes.
write('corpus.stdin.gz', gzip(['-c', '-n'], text));
write('corpus.1.gz', gzip(['-c', '-n', '-1'], text));
write('corpus.9.gz', gzip(['-c', '-n', '-9'], text));
// Files below get a fixed modification time for the same reason.
const mtime = new Date('2026-01-02T03:04:05Z');

const tmp = mkdtempSync(join(tmpdir(), 'gzip-js-fixtures-'));
try {
  // From a file: the header records the name and modification time (FNAME).
  const file = join(tmp, 'corpus.txt');
  writeFileSync(file, text);
  utimesSync(file, mtime, mtime);
  write('corpus.name.gz', gzip(['-c', file]));

  // Two members back to back, as `cat a.gz b.gz` produces.
  const half = text.length >> 1;
  write('corpus.multi.gz', Buffer.concat([gzip(['-c', '-n'], text.subarray(0, half)), gzip(['-c', '-n'], text.subarray(half))]));

  // A member holding zero bytes (unlike zero bytes of input, which is not gzip).
  const empty = join(tmp, 'empty');
  writeFileSync(empty, '');
  utimesSync(empty, mtime, mtime);
  write('empty.gz', gzip(['-c', empty]));

  // --- zlib and raw deflate, from Python's zlib ---
  write('corpus.zlib', py([9, 15, 8, 0, null], text));
  write('corpus.small-window.zlib', py([6, 9, 1, 0, null], text));
  write('corpus.raw', py([6, -15, 8, 0, null], text));
  write('corpus.rle.raw', py([6, -15, 8, 3, null], text));

  // Preset dictionary: small JSON records share most of their bytes.
  const records = Array.from({ length: 40 }, (_, i) =>
    JSON.stringify({ id: i, user: `user-${i % 37}`, status: ['active', 'idle', 'banned'][i % 3], score: (i * 7919) % 1000, tags: ['alpha', 'beta', String(i % 11)] }),
  );
  const dictionary = Buffer.from(records.join('\n'));
  const dictFile = join(tmp, 'dict');
  writeFileSync(dictFile, dictionary);
  const record = Buffer.from(JSON.stringify({ id: 123, user: 'user-12', status: 'idle', score: 937, tags: ['alpha', 'beta', '2'] }));
  write('dict.bin', dictionary);
  write('record.json', record);
  write('record.dict.zlib', py([9, 15, 8, 0, dictFile], record));
  write('record.dict.raw', py([9, -15, 8, 0, dictFile], record));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Apple gzip prints its version on stderr.
const v = spawnSync('gzip', ['--version'], { encoding: 'utf8' });
const gzipVersion = (v.stdout || v.stderr).split('\n')[0];
const pyVersion = run('python3', ['-I', '-c', 'import zlib; print(zlib.ZLIB_RUNTIME_VERSION)']).toString().trim();
console.log(`fixtures written to ${out} with ${gzipVersion} and Python zlib ${pyVersion}`);
