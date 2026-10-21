/*
 * zlib.h includes "zconf.h", which npm leaves out of the package: zlib's own
 * .gitignore lists it (zlib's configure regenerates it), and npm honours that
 * even for files named in package.json "files". The React Native builds have
 * csrc/ on their include path, so they find this file instead, and it is
 * zlib's unmodified template. zconf.h.in and zconf.h are identical in a zlib
 * checkout (checked by test/package-files.test.ts). Builds from a git checkout
 * find deps/zlib/zconf.h next to zlib.h first.
 */
#include "../deps/zlib/zconf.h.in"
