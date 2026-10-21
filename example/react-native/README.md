# gzip-js React Native example

A bare React Native app (Hermes, New Architecture) that runs a self-test of
`@kodespire/gzip-js` on launch: round trips in all three formats, output
byte-identical to the package's WebAssembly build, data from `gzip` and Python,
multi-member gzip, trailing data, truncated and corrupt input, `maxOutputSize`,
async work off the JS thread, dictionaries and streams. It also checks that the
module runs the bundled zlib, not the system libz. See `selftest/run.ts`.
CI runs it on an iOS simulator and an Android emulator
(`.github/workflows/react-native.yml`).

`npm install` here replaces the `file:../..` link with the package exactly as
`npm pack` would publish it (`scripts/prepare.mjs`), so build the package first:

```sh
# in the repo root
npm run build:wasm && npm run build:ts

# here
npm install
(cd ios && bundle install && bundle exec pod install)
npm run selftest:ios       # boots a simulator if none is running (IOS_SIMULATOR picks one)
npm run selftest:android   # needs ANDROID_HOME and a running emulator or device
```

`scripts/selftest.mjs` builds a Release app, installs and launches it, and
prints the `GZIP_SELFTEST` lines from the device log. It exits non-zero if any
test fails. Run `npm install` again after changing the package.
