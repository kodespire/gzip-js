# React Native (iOS) build of the native binding: cpp/ over csrc/gjs.c and the
# bundled zlib sources, the same C code as the Node-API addon and the WebAssembly build.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
zlib = "deps/zlib"

Pod::Spec.new do |s|
  s.name         = "KodespireGzip"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/kodespire/gzip-js.git", :tag => "v#{s.version}" }

  # The same zlib files as scripts/zlib-sources.cjs (binding.gyp and the WebAssembly
  # build), not the iOS SDK's libz: every build must report and produce what
  # ZLIB_VERSION says.
  s.source_files = [
    "ios/*.{h,mm}",
    "cpp/*.{h,cpp}",
    "csrc/gjs.{h,c}",
    "#{zlib}/{adler32,crc32,deflate,inffast,inflate,inftrees,trees,zutil}.c",
    "#{zlib}/{crc32,deflate,gzguts,inffast,inffixed,inflate,inftrees,trees,zlib,zutil}.h",
  ]
  # Only the provider is public, so the bundled zlib.h never shadows the SDK's for
  # other pods. gjs.c includes it by relative path and zlib's own files use quotes,
  # so deps/zlib is not added to HEADER_SEARCH_PATHS.
  s.public_header_files = "ios/*.h"
  # npm leaves deps/zlib/zconf.h out of the package; zlib.h finds csrc/zconf.h on the
  # search path instead, which includes the identical template. Not in source_files:
  # its relative #include must resolve from csrc/, not from a symlink in Pods/Headers.
  s.preserve_paths = ["csrc/zconf.h", "#{zlib}/zconf.h.in"]

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp\" \"$(PODS_TARGET_SRCROOT)/csrc\"",
    # Same defines as binding.gyp and scripts/build-wasm.mjs. Z_PREFIX renames every
    # zlib symbol (z_deflate, ...), so it never clashes with the system libz.
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) Z_PREFIX ZLIB_CONST",
    "GCC_OPTIMIZATION_LEVEL" => "3",
    "GCC_SYMBOLS_PRIVATE_EXTERN" => "YES",
    # Xcode's defaults flag a few idioms in zlib's sources.
    "CLANG_WARN_COMMA" => "NO",
    "CLANG_WARN_UNREACHABLE_CODE" => "NO",
  }

  install_modules_dependencies(s)
end
