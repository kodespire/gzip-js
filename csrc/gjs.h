/*
 * gjs: the C layer shared by the Node-API addon and the WebAssembly build.
 *
 * Every compress/decompress loop lives here, once. Both bindings are thin
 * wrappers that move bytes in and out, so a fix or a test here covers both.
 *
 * Conventions:
 *   - Functions return GJS_OK (0) or a GJS_ERR_* code.
 *   - On error, *detail (when non-NULL) points to a static, NUL-terminated
 *     message. It is never freed and is safe to read from any thread.
 *   - Output is appended to a caller-owned gjs_buf, which the caller frees
 *     with gjs_buf_free (also on error).
 */
#ifndef GJS_H
#define GJS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  GJS_OK = 0,
  GJS_ERR_LIBRARY = 1,      /* zlib rejected the data; detail is its message */
  GJS_ERR_TRUNCATED = 2,    /* input ended before the end of a member or stream (or was empty) */
  GJS_ERR_OUTPUT_LIMIT = 3, /* decompressed size would exceed max_output */
  GJS_ERR_NOMEM = 4,        /* allocation failed */
  GJS_ERR_ARG = 5,          /* invalid argument */
  GJS_ERR_TRAILING = 6      /* bytes after the last gzip member or after the zlib/raw stream */
};

enum { GJS_FORMAT_GZIP = 0, GJS_FORMAT_ZLIB = 1, GJS_FORMAT_RAW = 2 };

enum { GJS_MODE_CONTINUE = 0, GJS_MODE_FLUSH = 1, GJS_MODE_END = 2 };

typedef struct gjs_buf {
  uint8_t* data;
  size_t size;
  size_t cap;
} gjs_buf;

void gjs_buf_free(gjs_buf* buf);

/*
 * Compression parameters, as passed to deflateInit2():
 *   level 0-9, window_bits 9-15 (the format is added to it here),
 *   mem_level 1-9, strategy Z_DEFAULT_STRATEGY (0) to Z_FIXED (4).
 * A dictionary is accepted for GJS_FORMAT_ZLIB and GJS_FORMAT_RAW only.
 * gzip members get a fixed header (no name, MTIME 0, OS 255) so the output
 * is the same on every platform.
 */
int gjs_compress(const uint8_t* src, size_t src_size, int format, int level,
                 int window_bits, int mem_level, int strategy,
                 const uint8_t* dict, size_t dict_size, gjs_buf* out,
                 const char** detail);

/*
 * One-shot decompression. gzip: every member, concatenated; only zero bytes
 * may follow the last one. zlib and raw: exactly one stream, nothing after
 * it. Fails with GJS_ERR_TRUNCATED unless src ends after a complete member
 * (or stream). max_output = SIZE_MAX means no limit.
 */
int gjs_decompress(const uint8_t* src, size_t src_size, int format,
                   const uint8_t* dict, size_t dict_size, size_t max_output,
                   gjs_buf* out, const char** detail);

typedef struct gjs_cstream gjs_cstream;
typedef struct gjs_dstream gjs_dstream;

int gjs_cstream_create(int format, int level, int window_bits, int mem_level,
                       int strategy, const uint8_t* dict, size_t dict_size,
                       gjs_cstream** stream, const char** detail);
/* mode: GJS_MODE_CONTINUE, GJS_MODE_FLUSH (sync flush) or GJS_MODE_END (end of member/stream). */
int gjs_cstream_push(gjs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, gjs_buf* out, const char** detail);
void gjs_cstream_free(gjs_cstream* stream);

int gjs_dstream_create(int format, const uint8_t* dict, size_t dict_size,
                       size_t max_output, gjs_dstream** stream,
                       const char** detail);
/* Decodes all of src. Returns only once every byte decodable so far is in out. */
int gjs_dstream_push(gjs_dstream* stream, const uint8_t* src, size_t src_size,
                     gjs_buf* out, const char** detail);
/* Call at end of input: fails with GJS_ERR_TRUNCATED if a member or stream is unfinished. */
int gjs_dstream_finish(gjs_dstream* stream, const char** detail);
void gjs_dstream_free(gjs_dstream* stream);

/* zlibVersion() of the linked library (not the header it was compiled against). */
const char* gjs_version(void);

#ifdef __cplusplus
}
#endif

#endif /* GJS_H */
