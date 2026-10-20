// Prints the zlib C sources that both builds compile, one per line.
// Used by binding.gyp (via <!@(...)) and scripts/build-wasm.mjs.
// The gz*.c files (gzopen and friends: file I/O), compress.c, uncompr.c and
// infback.c are not needed: csrc/gjs.c drives deflate and inflate directly.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const NAMES = ['adler32.c', 'crc32.c', 'deflate.c', 'inffast.c', 'inflate.c', 'inftrees.c', 'trees.c', 'zutil.c'];

function sources() {
  return NAMES.map((name) => {
    const rel = path.posix.join('deps/zlib', name);
    if (!fs.existsSync(path.join(root, rel))) {
      throw new Error(`${rel} is missing. Run: git submodule update --init`);
    }
    return rel;
  });
}

module.exports = { sources };

if (require.main === module) {
  process.stdout.write(sources().join('\n') + '\n');
}
