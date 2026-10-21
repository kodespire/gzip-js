// What `npm pack` publishes. React Native apps compile the native module from the
// package, so it must carry the podspec, android/, cpp/ and every C source those
// builds compile, and nothing else of the repo (the example app, build output).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const { sources } = createRequire(import.meta.url)('../scripts/zlib-sources.cjs') as { sources(): string[] };

const npm = (args: string[], cwd = root) =>
  execFileSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });

const [pack] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'])) as [
  { files: { path: string; size: number }[] },
];
const files = pack.files.map((f) => f.path.replaceAll('\\', '/'));

// The zlib headers the compiled sources include (zutil.c includes gzguts.h).
const ZLIB_HEADERS = ['crc32.h', 'deflate.h', 'gzguts.h', 'inffast.h', 'inffixed.h', 'inflate.h', 'inftrees.h', 'trees.h', 'zlib.h', 'zutil.h'];

describe('npm package contents', () => {
  it('includes the React Native build', () => {
    for (const file of [
      'KodespireGzip.podspec',
      'react-native.config.js',
      'ios/KodespireGzipModuleProvider.h',
      'ios/KodespireGzipModuleProvider.mm',
      'cpp/KodespireGzipModule.h',
      'cpp/KodespireGzipModule.cpp',
      'android/build.gradle',
      'android/CMakeLists.txt',
      'android/src/main/java/com/kodespire/gzip/KodespireGzipPackage.java',
      'codegen/NativeKodespireGzip.ts',
      'csrc/gjs.c',
      'csrc/gjs.h',
      'csrc/zconf.h',
      'deps/zlib/LICENSE',
      'dist/entry-react-native.js',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('includes every zlib source and header the native builds compile', () => {
    for (const source of sources()) expect(files).toContain(source);
    for (const header of ZLIB_HEADERS) expect(files).toContain(`deps/zlib/${header}`);
    // zlib's .gitignore lists zconf.h, and npm honours it even for files named in
    // "files". csrc/zconf.h includes zconf.h.in instead, which must be the same file.
    expect(files).not.toContain('deps/zlib/zconf.h');
    expect(files).toContain('deps/zlib/zconf.h.in');
    const zconf = readFileSync(join(root, 'deps', 'zlib', 'zconf.h'));
    expect(Buffer.compare(readFileSync(join(root, 'deps', 'zlib', 'zconf.h.in')), zconf)).toBe(0);
  });

  // Not on Windows: React Native's iOS and Android builds use clang on macOS and Linux,
  // and a MinGW cc there prints -H paths in another form.
  const noCc = process.platform === 'win32' || spawnSync('cc', ['--version']).status !== 0;
  it('the native sources compile as packed', { skip: noCc }, () => {
    // The C files exactly as an app receives them (no deps/zlib/zconf.h), with the
    // include path and defines of the podspec and android/CMakeLists.txt.
    const dir = mkdtempSync(join(tmpdir(), 'gzip-js-pack-'));
    try {
      const [{ filename }] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', dir])) as [
        { filename: string },
      ];
      execFileSync('tar', ['-xzf', filename], { cwd: dir });
      const pkg = join(dir, 'package');
      const c = files.filter((f) => /^(csrc|deps\/zlib)\/[^/]+\.c$/.test(f));
      expect(c.sort()).toEqual(['csrc/gjs.c', ...sources()].sort());
      for (const source of c) {
        // -H lists every header opened. The SDK and NDK ship a zconf.h of their own
        // zlib, which a missing csrc/ include path would pick up without an error.
        const r = spawnSync('cc', ['-fsyntax-only', '-H', '-Werror=implicit-function-declaration', '-DZ_PREFIX', '-DZLIB_CONST', '-Icsrc', source], {
          cwd: pkg,
          encoding: 'utf8',
        });
        expect(r.status, `${source}: ${r.stderr}`).toBe(0);
        const headers = r.stderr.split('\n').filter((line) => line.startsWith('.')).map((line) => line.replace(/^\.+ /, ''));
        const zconf = headers.filter((h) => /zconf\.h(\.in)?$/.test(h));
        expect(zconf.length, source).toBeGreaterThan(0);
        for (const h of zconf) expect(h, source).toMatch(/^(csrc\/zconf\.h|csrc\/\.\.\/deps\/zlib\/zconf\.h\.in)$/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves out the rest of the repo', () => {
    for (const file of files) {
      expect(file).not.toMatch(/^(example|test|scripts|src|out|build|\.github)\//);
      expect(file).not.toMatch(/^android\/(build|\.cxx|\.gradle)\//);
      // Only deflate and inflate are compiled: no gz* file functions, no examples.
      expect(file).not.toMatch(/^deps\/zlib\/(gz\w*|compress|uncompr|infback)\.c$/);
      expect(file).not.toMatch(/^deps\/zlib\/[^/]+\//);
    }
    expect(files).not.toContain('binding.gyp');
    expect(files).not.toContain('csrc/addon.cc');
  });

  it('accepts any react-native version as a peer', () => {
    // npm treats "*" as always satisfied. A range such as ">=0.84" made zstd-js 0.2.0
    // installs fail (ERESOLVE) next to older or prerelease React Native, even for web-only use.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.peerDependencies).toEqual({ 'react-native': '*' });
    expect(pkg.peerDependenciesMeta).toEqual({ 'react-native': { optional: true } });
  });

  it('keeps the React Native sources small', () => {
    // Everything except the JavaScript build and the Node prebuilds, unpacked.
    const native = pack.files.filter((f) => !/^(dist|prebuilds)\//.test(f.path.replaceAll('\\', '/')));
    const bytes = native.reduce((n, f) => n + f.size, 0);
    // About 1.1 MB, half of it zlib's CRC-32 tables (crc32.h).
    expect(bytes).toBeLessThan(1.5e6);
  });
});
