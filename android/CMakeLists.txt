# The C++ TurboModule, added to the app's native build by autolinking
# (react-native.config.js). Same sources and defines as binding.gyp.
cmake_minimum_required(VERSION 3.13)
project(kodespire_gzip C CXX)

set(ROOT ${CMAKE_CURRENT_LIST_DIR}/..)
# The same zlib files as scripts/zlib-sources.cjs, not the NDK's libz: every build
# must report and produce what ZLIB_VERSION says.
set(ZLIB ${ROOT}/deps/zlib)
set(ZLIB_SOURCES
  ${ZLIB}/adler32.c ${ZLIB}/crc32.c ${ZLIB}/deflate.c ${ZLIB}/inffast.c
  ${ZLIB}/inflate.c ${ZLIB}/inftrees.c ${ZLIB}/trees.c ${ZLIB}/zutil.c)

add_library(kodespire_gzip STATIC
  ${ROOT}/cpp/KodespireGzipModule.cpp
  ${ROOT}/csrc/gjs.c
  ${ZLIB_SOURCES})

# deps/zlib is on no include path: gjs.c includes zlib.h by relative path and zlib's
# own files use quotes, so the bundled zlib.h never reaches the app's other code.
target_include_directories(kodespire_gzip
  PUBLIC ${ROOT}/cpp
  PRIVATE ${ROOT}/csrc)
# Z_PREFIX renames every zlib symbol (z_deflate, ...), so it never clashes with the system libz.
target_compile_definitions(kodespire_gzip PRIVATE Z_PREFIX ZLIB_CONST)
# -O3 in debug builds too: zlib at -O0 is several times slower.
target_compile_options(kodespire_gzip PRIVATE -O3 -fvisibility=hidden)
set_target_properties(kodespire_gzip PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)

target_link_libraries(kodespire_gzip ReactAndroid::jsi ReactAndroid::reactnative)
