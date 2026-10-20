{
  "targets": [
    {
      "target_name": "gzip_js",
      "sources": [
        "csrc/addon.cc",
        "csrc/gjs.c",
        "<!@(node scripts/zlib-sources.cjs)"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NODE_ADDON_API_DISABLE_DEPRECATED",
        "Z_PREFIX",
        "ZLIB_CONST"
      ],
      "cflags": ["-O3", "-fvisibility=hidden"],
      "cflags_cc": ["-O3", "-fvisibility=hidden", "-std=c++17"],
      "xcode_settings": {
        "GCC_OPTIMIZATION_LEVEL": "3",
        "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 2,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
