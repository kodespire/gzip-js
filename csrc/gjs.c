#include "gjs.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

/* By path, not "zlib.h": node-gyp puts Node's own (different) zlib.h on the
 * include path. The build defines Z_PREFIX, so every zlib symbol here is
 * z_*, and cannot clash with the zlib inside Node, Bun or Electron. */
#include "../deps/zlib/zlib.h"

/* Upper bound for the first allocation. Sizes derived from the input (the
 * gzip ISIZE field, deflateBound) are untrusted or pessimistic, so we never
 * allocate more than this up front; the buffer grows as real output arrives. */
#define GJS_INITIAL_CAP_LIMIT ((size_t)64 << 20)

/* Minimum spare output space per call into zlib. */
#define GJS_OUT_CHUNK ((size_t)64 << 10)

/* z_stream counts are 32-bit (uInt), so input and output are handed to zlib
 * in pieces of at most this much. */
#define GJS_MAX_CALL ((size_t)1 << 28)

/* Deflate never expands more than about 1032:1 (a 258-byte match in 2 bits),
 * which caps how much output a given input can claim. */
#define GJS_MAX_RATIO 1032

/* Pointer handed to zlib for empty input, so it never sees NULL. */
static const uint8_t gjs_empty = 0;

static int gjs_fail(int code, const char* message, const char** detail) {
  if (detail) *detail = message;
  return code;
}

/* Maps a zlib return code (not Z_OK/Z_STREAM_END) to a GJS_ERR_* code. */
static int gjs_lib_fail(int zret, const z_stream* z, const char** detail) {
  if (zret == Z_MEM_ERROR) return gjs_fail(GJS_ERR_NOMEM, "out of memory", detail);
  return gjs_fail(GJS_ERR_LIBRARY, z && z->msg ? z->msg : zError(zret), detail);
}

static size_t gjs_min(size_t a, size_t b) { return a < b ? a : b; }

void gjs_buf_free(gjs_buf* buf) {
  if (!buf) return;
  free(buf->data);
  buf->data = NULL;
  buf->size = 0;
  buf->cap = 0;
}

/* Ensures at least min_free bytes of spare capacity, growing by ~1.5x. */
static int gjs_buf_reserve(gjs_buf* buf, size_t min_free, const char** detail) {
  size_t need, cap;
  uint8_t* data;
  if (buf->cap - buf->size >= min_free) return GJS_OK;
  if (min_free > SIZE_MAX - buf->size) return gjs_fail(GJS_ERR_NOMEM, "out of memory", detail);
  need = buf->size + min_free;
  cap = buf->cap + buf->cap / 2;
  if (cap < buf->cap || cap < need) cap = need;
  data = (uint8_t*)realloc(buf->data, cap);
  if (!data && cap != need) {
    cap = need;
    data = (uint8_t*)realloc(buf->data, cap);
  }
  if (!data) return gjs_fail(GJS_ERR_NOMEM, "out of memory", detail);
  buf->data = data;
  buf->cap = cap;
  return GJS_OK;
}

static int gjs_check_dict(int format, size_t dict_size, const char** detail) {
  if (dict_size == 0) return GJS_OK;
  if (format == GJS_FORMAT_GZIP) {
    return gjs_fail(GJS_ERR_ARG, "the gzip format does not support a dictionary", detail);
  }
  if (dict_size > UINT_MAX) return gjs_fail(GJS_ERR_ARG, "dictionary too large", detail);
  return GJS_OK;
}

/* ---- compression --------------------------------------------------------- */

struct gjs_cstream {
  z_stream z;
  /* deflate keeps a pointer to this until it writes the header. */
  gz_header header;
  int initialized;
  int ended;
};

void gjs_cstream_free(gjs_cstream* stream) {
  if (!stream) return;
  if (stream->initialized) deflateEnd(&stream->z);
  free(stream);
}

int gjs_cstream_create(int format, int level, int window_bits, int mem_level,
                       int strategy, const uint8_t* dict, size_t dict_size,
                       gjs_cstream** stream, const char** detail) {
  gjs_cstream* s;
  int wbits, r, rc;

  *stream = NULL;
  switch (format) {
    case GJS_FORMAT_GZIP: wbits = window_bits + 16; break;
    case GJS_FORMAT_ZLIB: wbits = window_bits; break;
    case GJS_FORMAT_RAW: wbits = -window_bits; break;
    default: return gjs_fail(GJS_ERR_ARG, "invalid format", detail);
  }
  if (level < 0 || level > 9) return gjs_fail(GJS_ERR_ARG, "compression level out of range", detail);
  if (window_bits < 9 || window_bits > 15) return gjs_fail(GJS_ERR_ARG, "windowBits out of range", detail);
  if (mem_level < 1 || mem_level > 9) return gjs_fail(GJS_ERR_ARG, "memLevel out of range", detail);
  if (strategy < Z_DEFAULT_STRATEGY || strategy > Z_FIXED) return gjs_fail(GJS_ERR_ARG, "invalid strategy", detail);
  rc = gjs_check_dict(format, dict_size, detail);
  if (rc != GJS_OK) return rc;

  s = (gjs_cstream*)calloc(1, sizeof(*s));
  if (!s) return gjs_fail(GJS_ERR_NOMEM, "out of memory", detail);
  r = deflateInit2(&s->z, level, Z_DEFLATED, wbits, mem_level, strategy);
  if (r != Z_OK) {
    free(s);
    return r == Z_STREAM_ERROR ? gjs_fail(GJS_ERR_ARG, "invalid compression parameters", detail)
                               : gjs_lib_fail(r, NULL, detail);
  }
  s->initialized = 1;
  if (format == GJS_FORMAT_GZIP) {
    /* No name, comment or MTIME, and OS 255 ("unknown"): without this zlib
     * writes the build platform's OS code, and output would differ between
     * macOS, Linux, Windows and WebAssembly. */
    s->header.os = 255;
    r = deflateSetHeader(&s->z, &s->header);
  } else if (dict_size > 0) {
    r = deflateSetDictionary(&s->z, dict, (uInt)dict_size); /* copies dict */
  }
  if (r != Z_OK) {
    rc = gjs_lib_fail(r, &s->z, detail);
    gjs_cstream_free(s);
    return rc;
  }
  *stream = s;
  return GJS_OK;
}

int gjs_cstream_push(gjs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, gjs_buf* out, const char** detail) {
  z_stream* z;
  size_t pos = 0;
  int flush, rc;

  if (!stream) return gjs_fail(GJS_ERR_ARG, "stream is closed", detail);
  if (stream->ended) return gjs_fail(GJS_ERR_ARG, "stream has already ended", detail);
  switch (mode) {
    case GJS_MODE_CONTINUE: flush = Z_NO_FLUSH; break;
    case GJS_MODE_FLUSH: flush = Z_SYNC_FLUSH; break;
    case GJS_MODE_END: flush = Z_FINISH; break;
    default: return gjs_fail(GJS_ERR_ARG, "invalid stream mode", detail);
  }
  z = &stream->z;

  for (;;) {
    size_t in_now, out_now;
    int f, r;
    rc = gjs_buf_reserve(out, GJS_OUT_CHUNK, detail);
    if (rc != GJS_OK) return rc;
    in_now = gjs_min(src_size - pos, GJS_MAX_CALL);
    out_now = gjs_min(out->cap - out->size, GJS_MAX_CALL);
    /* Flush or finish only with the last piece of input. */
    f = pos + in_now == src_size ? flush : Z_NO_FLUSH;
    z->next_in = src_size ? src + pos : &gjs_empty;
    z->avail_in = (uInt)in_now;
    z->next_out = out->data + out->size;
    z->avail_out = (uInt)out_now;

    r = deflate(z, f);
    pos += in_now - z->avail_in;
    out->size += out_now - z->avail_out;
    if (r == Z_STREAM_END) {
      stream->ended = 1;
      break;
    }
    if (r != Z_OK && r != Z_BUF_ERROR) return gjs_lib_fail(r, z, detail);
    /* Z_FINISH: loop until Z_STREAM_END. Otherwise done once all input is
     * consumed and zlib had output space left, i.e. nothing is pending. */
    if (f != Z_FINISH && pos == src_size && z->avail_out > 0) break;
  }
  return GJS_OK;
}

int gjs_compress(const uint8_t* src, size_t src_size, int format, int level,
                 int window_bits, int mem_level, int strategy,
                 const uint8_t* dict, size_t dict_size, gjs_buf* out,
                 const char** detail) {
  gjs_cstream* s;
  size_t bound;
  int rc = gjs_cstream_create(format, level, window_bits, mem_level, strategy, dict, dict_size,
                              &s, detail);
  if (rc != GJS_OK) return rc;
  /* With room for deflateBound() the whole input compresses in one call. */
  bound = deflateBound_z(&s->z, src_size);
  rc = gjs_buf_reserve(out, gjs_min(bound, GJS_INITIAL_CAP_LIMIT), detail);
  if (rc == GJS_OK) rc = gjs_cstream_push(s, src, src_size, GJS_MODE_END, out, detail);
  gjs_cstream_free(s);
  return rc;
}

/* ---- decompression ------------------------------------------------------- */

enum {
  GJS_IN_STREAM = 0, /* inside a member or stream (or before the first one) */
  GJS_BETWEEN = 1,   /* a member or stream just ended */
  GJS_PADDING = 2    /* gzip: zero bytes after the last member */
};

struct gjs_dstream {
  z_stream z;
  int initialized;
  int format;
  int phase;
  /* gzip: a 0x1f arrived as the last byte of a push, right after a member.
   * The next push decides whether it starts another member. */
  int magic_held;
  int seen_input;
  size_t max_output;
  size_t total_out;
  /* zlib format: kept until the stream asks for it (Z_NEED_DICT). */
  uint8_t* dict;
  size_t dict_size;
};

void gjs_dstream_free(gjs_dstream* stream) {
  if (!stream) return;
  if (stream->initialized) inflateEnd(&stream->z);
  free(stream->dict);
  free(stream);
}

int gjs_dstream_create(int format, const uint8_t* dict, size_t dict_size,
                       size_t max_output, gjs_dstream** stream,
                       const char** detail) {
  gjs_dstream* s;
  int wbits, r, rc;

  *stream = NULL;
  switch (format) {
    case GJS_FORMAT_GZIP: wbits = 15 + 16; break;
    case GJS_FORMAT_ZLIB: wbits = 15; break;
    case GJS_FORMAT_RAW: wbits = -15; break;
    default: return gjs_fail(GJS_ERR_ARG, "invalid format", detail);
  }
  rc = gjs_check_dict(format, dict_size, detail);
  if (rc != GJS_OK) return rc;

  s = (gjs_dstream*)calloc(1, sizeof(*s));
  if (!s) return gjs_fail(GJS_ERR_NOMEM, "out of memory", detail);
  s->format = format;
  s->max_output = max_output;
  r = inflateInit2(&s->z, wbits);
  if (r != Z_OK) {
    free(s);
    return gjs_lib_fail(r, NULL, detail);
  }
  s->initialized = 1;
  if (dict_size > 0 && format == GJS_FORMAT_RAW) {
    r = inflateSetDictionary(&s->z, dict, (uInt)dict_size); /* copies dict */
    if (r != Z_OK) {
      rc = gjs_lib_fail(r, &s->z, detail);
      gjs_dstream_free(s);
      return rc;
    }
  } else if (dict_size > 0) {
    s->dict = (uint8_t*)malloc(dict_size);
    if (!s->dict) {
      gjs_dstream_free(s);
      return gjs_fail(GJS_ERR_NOMEM, "out of memory", detail);
    }
    memcpy(s->dict, dict, dict_size);
    s->dict_size = dict_size;
  }
  *stream = s;
  return GJS_OK;
}

/* Starts decoding another gzip member; feeds it a held 0x1f if there is one. */
static int gjs_next_member(gjs_dstream* s, const char** detail) {
  int r = inflateReset(&s->z);
  if (r != Z_OK) return gjs_lib_fail(r, &s->z, detail);
  s->phase = GJS_IN_STREAM;
  if (s->magic_held) {
    static const uint8_t magic0 = 0x1f;
    uint8_t sink;
    s->magic_held = 0;
    s->z.next_in = &magic0;
    s->z.avail_in = 1;
    s->z.next_out = &sink;
    s->z.avail_out = 0;
    r = inflate(&s->z, Z_NO_FLUSH);
    if (r != Z_OK || s->z.avail_in != 0) return gjs_lib_fail(r == Z_OK ? Z_DATA_ERROR : r, &s->z, detail);
  }
  return GJS_OK;
}

static int gjs_trailing(const gjs_dstream* s, const char** detail) {
  switch (s->format) {
    case GJS_FORMAT_GZIP:
      return gjs_fail(GJS_ERR_TRAILING,
                      s->phase == GJS_PADDING ? "unexpected data after the zero padding that follows the last gzip member"
                                              : "unexpected data after the last gzip member",
                      detail);
    case GJS_FORMAT_ZLIB:
      return gjs_fail(GJS_ERR_TRAILING, "unexpected data after the end of the zlib stream", detail);
    default:
      return gjs_fail(GJS_ERR_TRAILING, "unexpected data after the end of the deflate stream", detail);
  }
}

int gjs_dstream_push(gjs_dstream* stream, const uint8_t* src, size_t src_size,
                     gjs_buf* out, const char** detail) {
  gjs_dstream* s = stream;
  z_stream* z;
  size_t pos = 0;
  int rc;

  if (!s) return gjs_fail(GJS_ERR_ARG, "stream is closed", detail);
  z = &s->z;
  if (src_size) s->seen_input = 1;

  for (;;) {
    size_t in_now, out_now, allowed, used, made;
    int r;

    if (s->phase != GJS_IN_STREAM) {
      /* After a complete member or stream. gzip allows another member
       * (1f 8b) or zero padding up to the end; nothing else is accepted. */
      if (pos == src_size) break;
      if (s->format != GJS_FORMAT_GZIP) return gjs_trailing(s, detail);
      if (s->phase == GJS_PADDING) {
        while (pos < src_size && src[pos] == 0) pos++;
        if (pos < src_size) return gjs_trailing(s, detail);
        break;
      }
      if (s->magic_held) {
        if (src[pos] != 0x8b) return gjs_trailing(s, detail);
      } else if (src[pos] == 0) {
        s->phase = GJS_PADDING;
        continue;
      } else if (src[pos] != 0x1f) {
        return gjs_trailing(s, detail);
      } else if (pos + 1 == src_size) {
        s->magic_held = 1;
        pos++;
        break;
      } else if (src[pos + 1] != 0x8b) {
        return gjs_trailing(s, detail);
      }
      rc = gjs_next_member(s, detail);
      if (rc != GJS_OK) return rc;
    }

    if (out->size == out->cap) {
      rc = gjs_buf_reserve(out, GJS_OUT_CHUNK, detail);
      if (rc != GJS_OK) return rc;
    }
    /* Never let zlib write more than one byte past the limit: that byte is
     * how we detect "too big" without decoding the rest. */
    allowed = s->max_output - s->total_out;
    if (allowed < SIZE_MAX) allowed += 1;

    in_now = gjs_min(src_size - pos, GJS_MAX_CALL);
    out_now = gjs_min(gjs_min(out->cap - out->size, allowed), GJS_MAX_CALL);
    z->next_in = src_size ? src + pos : &gjs_empty;
    z->avail_in = (uInt)in_now;
    z->next_out = out->data + out->size;
    z->avail_out = (uInt)out_now;

    r = inflate(z, Z_NO_FLUSH);
    used = in_now - z->avail_in;
    made = out_now - z->avail_out;
    pos += used;
    out->size += made;
    s->total_out += made;
    if (s->total_out > s->max_output) {
      return gjs_fail(GJS_ERR_OUTPUT_LIMIT, "decompressed size exceeds maxOutputSize", detail);
    }

    if (r == Z_STREAM_END) {
      s->phase = GJS_BETWEEN;
      continue;
    }
    if (r == Z_NEED_DICT) {
      if (!s->dict) return gjs_fail(GJS_ERR_LIBRARY, "the zlib stream needs a dictionary", detail);
      r = inflateSetDictionary(z, s->dict, (uInt)s->dict_size);
      if (r == Z_DATA_ERROR) return gjs_fail(GJS_ERR_LIBRARY, "incorrect dictionary", detail);
      if (r != Z_OK) return gjs_lib_fail(r, z, detail);
      continue;
    }
    if (r != Z_OK && r != Z_BUF_ERROR) return gjs_lib_fail(r, z, detail);

    if (pos == src_size) {
      /* All input consumed. If zlib still had output space, it wrote all it
       * could and is waiting for input; if the output filled up exactly,
       * loop to drain it. */
      if (z->avail_out > 0) break;
    } else if (used == 0 && made == 0) {
      return gjs_fail(GJS_ERR_LIBRARY, "zlib decoder made no progress", detail);
    }
  }
  return GJS_OK;
}

int gjs_dstream_finish(gjs_dstream* stream, const char** detail) {
  if (!stream) return gjs_fail(GJS_ERR_ARG, "stream is closed", detail);
  if (stream->phase == GJS_IN_STREAM || stream->magic_held) {
    if (!stream->seen_input) return gjs_fail(GJS_ERR_TRUNCATED, "input is empty", detail);
    switch (stream->format) {
      case GJS_FORMAT_GZIP:
        return gjs_fail(GJS_ERR_TRUNCATED, "gzip input ended before the end of a member", detail);
      case GJS_FORMAT_ZLIB:
        return gjs_fail(GJS_ERR_TRUNCATED, "zlib input ended before the end of the stream", detail);
      default:
        return gjs_fail(GJS_ERR_TRUNCATED, "deflate input ended before the end of the stream", detail);
    }
  }
  return GJS_OK;
}

int gjs_decompress(const uint8_t* src, size_t src_size, int format,
                   const uint8_t* dict, size_t dict_size, size_t max_output,
                   gjs_buf* out, const char** detail) {
  gjs_dstream* s;
  size_t hint, ratio;
  int rc;

  rc = gjs_dstream_create(format, dict, dict_size, max_output, &s, detail);
  if (rc != GJS_OK) return rc;

  /* Size the first allocation from the last member's ISIZE (exact for a
   * well-formed single member), otherwise from the input size. Capped,
   * because ISIZE is untrusted: never more than deflate's maximum ratio
   * allows for this input, and never more than GJS_INITIAL_CAP_LIMIT. */
  if (format == GJS_FORMAT_GZIP && src_size >= 18) {
    const uint8_t* t = src + src_size - 4;
    hint = (size_t)t[0] | (size_t)t[1] << 8 | (size_t)t[2] << 16 | (size_t)t[3] << 24;
  } else {
    hint = src_size > GJS_INITIAL_CAP_LIMIT / 4 ? GJS_INITIAL_CAP_LIMIT : src_size * 4;
    if (hint < GJS_OUT_CHUNK) hint = GJS_OUT_CHUNK;
  }
  ratio = src_size > GJS_INITIAL_CAP_LIMIT / GJS_MAX_RATIO ? GJS_INITIAL_CAP_LIMIT : src_size * GJS_MAX_RATIO;
  hint = gjs_min(gjs_min(hint, ratio), GJS_INITIAL_CAP_LIMIT);
  if (max_output < SIZE_MAX && hint > max_output + 1) hint = max_output + 1;
  if (hint > 0 && gjs_buf_reserve(out, hint, detail) != GJS_OK) {
    /* Not fatal: start small and let real output drive growth. */
    if (detail) *detail = NULL;
  }

  rc = gjs_dstream_push(s, src, src_size, out, detail);
  if (rc == GJS_OK) rc = gjs_dstream_finish(s, detail);
  gjs_dstream_free(s);
  return rc;
}

const char* gjs_version(void) { return zlibVersion(); }
