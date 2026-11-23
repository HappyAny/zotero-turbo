/*
 * Zotero Turbo Native C Engine (MuPDF 1.28.0 + Parallel File Scanner)
 * Cross-platform: Windows x64 (MinGW/MSVC), macOS (arm64/x64), Linux (x64)
 * License: GNU AGPL-3.0 (matching upstream MuPDF)
 */

#include "zot_turbo.h"
#include "mupdf_render.h"
#include "mupdf/fitz.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <math.h>
#include <ctype.h>
#include <sys/stat.h>

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
  #include <process.h>
  #include <wchar.h>
  #include <malloc.h>
#else
  #include <pthread.h>
  #include <unistd.h>
  #ifdef __APPLE__
    #include <malloc/malloc.h>
  #elif defined(__GLIBC__)
    #include <malloc.h>
  #endif
#endif

#define ZOT_TURBO_VERSION "0.6.2"
#define MAX_CACHED_DOCS 2
#define MAX_FONT_TABLE  256

/* ---------- Cross-platform helpers ---------- */

static int get_cpu_count(void) {
#ifdef _WIN32
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    int n = (int)si.dwNumberOfProcessors;
    return n > 0 ? n : 4;
#else
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return n > 0 ? (int)n : 4;
#endif
}

static int get_file_stat_meta(const char *utf8_path, int64_t *out_size, int64_t *out_mtime) {
    if (!utf8_path || !*utf8_path) return -1;
#ifdef _WIN32
    int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, NULL, 0);
    if (wlen <= 0 || wlen > 32768) return -1;
    wchar_t *wpath = (wchar_t *)malloc((size_t)wlen * sizeof(wchar_t));
    if (!wpath) return -1;
    MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, wpath, wlen);
    WIN32_FILE_ATTRIBUTE_DATA fad;
    BOOL ok = GetFileAttributesExW(wpath, GetFileExInfoStandard, &fad);
    free(wpath);
    if (!ok) return -1;
    ULARGE_INTEGER sz, mt;
    sz.LowPart = fad.nFileSizeLow;
    sz.HighPart = fad.nFileSizeHigh;
    mt.LowPart = fad.ftLastWriteTime.dwLowDateTime;
    mt.HighPart = fad.ftLastWriteTime.dwHighDateTime;
    if (out_size) *out_size = (int64_t)sz.QuadPart;
    if (out_mtime) *out_mtime = (int64_t)mt.QuadPart;
    return 0;
#else
    struct stat st;
    if (stat(utf8_path, &st) != 0) return -1;
    if (out_size) *out_size = (int64_t)st.st_size;
    if (out_mtime) *out_mtime = (int64_t)st.st_mtime;
    return 0;
#endif
}

static FILE *fopen_utf8_rb(const char *utf8_path) {
    if (!utf8_path || !*utf8_path) return NULL;
#ifdef _WIN32
    int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, NULL, 0);
    if (wlen <= 0 || wlen > 32768) return NULL;
    wchar_t *wpath = (wchar_t *)malloc((size_t)wlen * sizeof(wchar_t));
    if (!wpath) return NULL;
    MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, wpath, wlen);
    FILE *fp = _wfopen(wpath, L"rb");
    free(wpath);
    return fp;
#else
    return fopen(utf8_path, "rb");
#endif
}

/* ---------- Dynamic String Buffer ---------- */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
    int oom;
} StrBuf;

static int sb_init(StrBuf *sb, size_t initial_cap) {
    if (initial_cap < 256) initial_cap = 256;
    sb->data = (char *)malloc(initial_cap);
    if (!sb->data) {
        sb->len = 0;
        sb->cap = 0;
        sb->oom = 1;
        return -1;
    }
    sb->data[0] = '\0';
    sb->len = 0;
    sb->cap = initial_cap;
    sb->oom = 0;
    return 0;
}

static int sb_reserve(StrBuf *sb, size_t extra) {
    if (sb->oom) return -1;
    if (sb->len + extra + 1 <= sb->cap) return 0;
    size_t new_cap = sb->cap ? sb->cap * 2 : 512;
    while (new_cap < sb->len + extra + 1) {
        if (new_cap > (size_t)1 << 30) {
            sb->oom = 1;
            return -1;
        }
        new_cap *= 2;
    }
    char *p = (char *)realloc(sb->data, new_cap);
    if (!p) {
        sb->oom = 1;
        return -1;
    }
    sb->data = p;
    sb->cap = new_cap;
    return 0;
}

static void sb_append_n(StrBuf *sb, const char *s, size_t n) {
    if (sb->oom || n == 0) return;
    if (sb_reserve(sb, n) != 0) return;
    memcpy(sb->data + sb->len, s, n);
    sb->len += n;
    sb->data[sb->len] = '\0';
}

static void sb_append_str(StrBuf *sb, const char *s) {
    if (!s) return;
    sb_append_n(sb, s, strlen(s));
}

static void sb_append_ch(StrBuf *sb, char c) {
    if (sb->oom) return;
    if (sb_reserve(sb, 1) != 0) return;
    sb->data[sb->len++] = c;
    sb->data[sb->len] = '\0';
}

static void sb_append_utf8(StrBuf *sb, int cp) {
    char tmp[4];
    size_t n = 0;
    if (cp == 0) return;
    if (cp < 0 || cp > 0x10FFFF) cp = 0xFFFD;
    if (cp < 0x80) {
        tmp[0] = (char)cp;
        n = 1;
    } else if (cp < 0x800) {
        tmp[0] = (char)(0xC0 | (cp >> 6));
        tmp[1] = (char)(0x80 | (cp & 0x3F));
        n = 2;
    } else if (cp < 0x10000) {
        tmp[0] = (char)(0xE0 | (cp >> 12));
        tmp[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        tmp[2] = (char)(0x80 | (cp & 0x3F));
        n = 3;
    } else {
        tmp[0] = (char)(0xF0 | (cp >> 18));
        tmp[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
        tmp[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
        tmp[3] = (char)(0x80 | (cp & 0x3F));
        n = 4;
    }
    sb_append_n(sb, tmp, n);
}

static void sb_append_fmt(StrBuf *sb, const char *fmt, ...) {
    if (sb->oom) return;
    char stack_buf[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(stack_buf, sizeof(stack_buf), fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if ((size_t)n < sizeof(stack_buf)) {
        sb_append_n(sb, stack_buf, (size_t)n);
        return;
    }
    if (sb_reserve(sb, (size_t)n) != 0) return;
    va_start(ap, fmt);
    vsnprintf(sb->data + sb->len, (size_t)n + 1, fmt, ap);
    va_end(ap);
    sb->len += (size_t)n;
}

static void sb_append_json_str(StrBuf *sb, const char *s) {
    sb_append_ch(sb, '"');
    if (s) {
        for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
            unsigned char c = *p;
            if (c == '"') sb_append_n(sb, "\\\"", 2);
            else if (c == '\\') sb_append_n(sb, "\\\\", 2);
            else if (c == '\b') sb_append_n(sb, "\\b", 2);
            else if (c == '\f') sb_append_n(sb, "\\f", 2);
            else if (c == '\n') sb_append_n(sb, "\\n", 2);
            else if (c == '\r') sb_append_n(sb, "\\r", 2);
            else if (c == '\t') sb_append_n(sb, "\\t", 2);
            else if (c < 0x20) sb_append_fmt(sb, "\\u%04x", (unsigned)c);
            else sb_append_ch(sb, (char)c);
        }
    }
    sb_append_ch(sb, '"');
}

static void sb_free(StrBuf *sb) {
    free(sb->data);
    sb->data = NULL;
    sb->len = 0;
    sb->cap = 0;
}

/* ---------- MuPDF Document LRU Cache inside Engine ---------- */

typedef struct {
    char *path;
    int64_t file_size;
    int64_t file_mtime;
    fz_document *doc;
    int page_count;
    uint64_t last_used;
} CachedDoc;

struct ZotTurboEngine {
    fz_context *ctx;
    void *locks;
    int store_mb;
    uint64_t tick;
    CachedDoc docs[MAX_CACHED_DOCS];
};

static void drop_cached_slot(ZotTurboEngine *eng, int idx) {
    CachedDoc *slot = &eng->docs[idx];
    if (slot->doc) {
        fz_drop_document(eng->ctx, slot->doc);
        slot->doc = NULL;
    }
    free(slot->path);
    slot->path = NULL;
    slot->file_size = 0;
    slot->file_mtime = 0;
    slot->page_count = 0;
    slot->last_used = 0;
}

static fz_document *get_or_open_doc(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int *out_page_count,
    int *out_err
) {
    if (out_err) *out_err = 0;
    if (!eng || !eng->ctx || !utf8_path || !*utf8_path) {
        if (out_err) *out_err = -1;
        return NULL;
    }

    int64_t fsize = 0, fmtime = 0;
    if (get_file_stat_meta(utf8_path, &fsize, &fmtime) != 0) {
        if (out_err) *out_err = -2;
        return NULL;
    }

    /* Check LRU cache */
    for (int i = 0; i < MAX_CACHED_DOCS; ++i) {
        CachedDoc *slot = &eng->docs[i];
        if (slot->doc && slot->path && strcmp(slot->path, utf8_path) == 0) {
            if (slot->file_size == fsize && slot->file_mtime == fmtime) {
                slot->last_used = ++eng->tick;
                if (out_page_count) *out_page_count = slot->page_count;
                return slot->doc;
            }
            /* File changed on disk: drop stale handle */
            drop_cached_slot(eng, i);
            break;
        }
    }

    /* Find free or oldest LRU slot */
    int target = 0;
    uint64_t oldest = UINT64_MAX;
    for (int i = 0; i < MAX_CACHED_DOCS; ++i) {
        if (!eng->docs[i].doc) {
            target = i;
            break;
        }
        if (eng->docs[i].last_used < oldest) {
            oldest = eng->docs[i].last_used;
            target = i;
        }
    }
    if (eng->docs[target].doc) {
        drop_cached_slot(eng, target);
    }

    fz_context *ctx = eng->ctx;
    fz_document *doc = NULL;
    int pages = 0;
    int needs_pw = 0;
    int failed = 0;

    fz_var(doc);
    fz_try(ctx) {
        doc = fz_open_document(ctx, utf8_path);
        if (fz_needs_password(ctx, doc)) {
            /* Try empty password (some PDFs have owner-only permissions password) */
            if (!fz_authenticate_password(ctx, doc, "")) {
                needs_pw = 1;
            }
        }
        if (!needs_pw) {
            pages = fz_count_pages(ctx, doc);
        }
    }
    fz_catch(ctx) {
        failed = 1;
    }

    if (failed || needs_pw || !doc) {
        if (doc) fz_drop_document(ctx, doc);
        if (out_err) *out_err = needs_pw ? -3 : -2;
        return NULL;
    }

    size_t plen = strlen(utf8_path);
    char *pcopy = (char *)malloc(plen + 1);
    if (!pcopy) {
        fz_drop_document(ctx, doc);
        if (out_err) *out_err = -4;
        return NULL;
    }
    memcpy(pcopy, utf8_path, plen + 1);

    CachedDoc *slot = &eng->docs[target];
    slot->path = pcopy;
    slot->file_size = fsize;
    slot->file_mtime = fmtime;
    slot->doc = doc;
    slot->page_count = pages;
    slot->last_used = ++eng->tick;

    if (out_page_count) *out_page_count = pages;
    return doc;
}

/* ---------- Public Engine Lifecycle ---------- */

ZOT_TURBO_API const char *zot_turbo_version(void) {
    return ZOT_TURBO_VERSION;
}

ZOT_TURBO_API void zot_turbo_free_buf(void *ptr) {
    free(ptr);
}

ZOT_TURBO_API ZotTurboEngine *zot_turbo_engine_create(int store_mb) {
    if (store_mb < 8) store_mb = 8;
    if (store_mb > 512) store_mb = 512;
    ZotTurboEngine *eng = (ZotTurboEngine *)calloc(1, sizeof(ZotTurboEngine));
    if (!eng) return NULL;
    size_t max_store = (size_t)store_mb * 1024ULL * 1024ULL;
    eng->ctx = zot_new_base_context(max_store, &eng->locks);
    if (!eng->ctx) {
        free(eng);
        return NULL;
    }
    eng->store_mb = store_mb;
    return eng;
}

ZOT_TURBO_API void zot_turbo_engine_destroy(ZotTurboEngine *eng) {
    if (!eng) return;
    for (int i = 0; i < MAX_CACHED_DOCS; ++i) {
        drop_cached_slot(eng, i);
    }
    if (eng->ctx || eng->locks) {
        zot_drop_base_context(eng->ctx, eng->locks);
        eng->ctx = NULL;
        eng->locks = NULL;
    }
    free(eng);
}

ZOT_TURBO_API void zot_turbo_os_trim_memory(int trim_working_set) {
#ifdef _WIN32
    _heapmin();
    HANDLE hHeap = GetProcessHeap();
    if (hHeap) {
        HeapCompact(hHeap, 0);
    }
    if (trim_working_set) {
        SetProcessWorkingSetSize(GetCurrentProcess(), (SIZE_T)-1, (SIZE_T)-1);
    }
#elif defined(__APPLE__)
    (void)trim_working_set;
    malloc_zone_pressure_relief(NULL, 0);
#elif defined(__GLIBC__)
    (void)trim_working_set;
    malloc_trim(0);
#else
    (void)trim_working_set;
#endif
}

ZOT_TURBO_API void zot_turbo_engine_trim(ZotTurboEngine *eng, int aggressive) {
    if (!eng || !eng->ctx) return;
    if (aggressive) {
        for (int i = 0; i < MAX_CACHED_DOCS; ++i) {
            drop_cached_slot(eng, i);
        }
        fz_empty_store(eng->ctx);
        zot_turbo_os_trim_memory(0);
    } else {
        fz_shrink_store(eng->ctx, 50);
    }
}

ZOT_TURBO_API void zot_turbo_engine_evict_path(ZotTurboEngine *eng, const char *utf8_path) {
    if (!eng || !utf8_path) return;
    for (int i = 0; i < MAX_CACHED_DOCS; ++i) {
        if (eng->docs[i].path && strcmp(eng->docs[i].path, utf8_path) == 0) {
            drop_cached_slot(eng, i);
        }
    }
}

/* ---------- Character Classification Helpers ---------- */

static int is_cjk_cp(int c) {
    return (c >= 0x4E00 && c <= 0x9FFF) ||
           (c >= 0x3400 && c <= 0x4DBF) ||
           (c >= 0x3040 && c <= 0x30FF) ||
           (c >= 0xAC00 && c <= 0xD7AF) ||
           (c >= 0xF900 && c <= 0xFAFF) ||
           (c >= 0x20000 && c <= 0x2A6DF);
}

static int is_hyphen_cp(int c) {
    return c == '-' || c == 0x00AD || c == 0x2010 || c == 0x2011;
}

static int is_space_cp(int c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == 0x00A0 ||
           c == 0x2000 || c == 0x2001 || c == 0x2002 || c == 0x2003 ||
           c == 0x2004 || c == 0x2005 || c == 0x2006 || c == 0x2007 ||
           c == 0x2008 || c == 0x2009 || c == 0x200A || c == 0x3000;
}

static int is_ignorable_ctrl(int c) {
    return (c >= 0x00 && c <= 0x1F) || (c >= 0x7F && c <= 0x9F) || c == 0xFEFF;
}

/* ---------- 1. Fast PDF Full-Text Extraction ---------- */

ZOT_TURBO_API char *zot_turbo_pdf_fulltext(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int max_pages,
    int *out_len,
    int *out_extracted_pages,
    int *out_total_pages,
    int *out_err
) {
    if (out_len) *out_len = 0;
    if (out_extracted_pages) *out_extracted_pages = 0;
    if (out_total_pages) *out_total_pages = 0;
    if (out_err) *out_err = 0;

    int total_pages = 0;
    int err = 0;
    fz_document *doc = get_or_open_doc(eng, utf8_path, &total_pages, &err);
    if (!doc) {
        if (out_err) *out_err = err ? err : -2;
        return NULL;
    }

    int pages_to_extract = total_pages;
    if (max_pages > 0 && max_pages < pages_to_extract) {
        pages_to_extract = max_pages;
    }

    StrBuf sb;
    if (sb_init(&sb, (size_t)(pages_to_extract > 0 ? pages_to_extract : 1) * 2048ULL) != 0) {
        if (out_err) *out_err = -4;
        return NULL;
    }

    fz_context *ctx = eng->ctx;
    fz_stext_options opts;
    fz_init_stext_options(ctx, &opts);
    opts.flags = FZ_STEXT_CLIP | FZ_STEXT_DEHYPHENATE;

    for (int p = 0; p < pages_to_extract && !sb.oom; ++p) {
        fz_page *page = NULL;
        fz_stext_page *stext = NULL;
        fz_var(page);
        fz_var(stext);

        fz_try(ctx) {
            page = fz_load_page(ctx, doc, p);
            stext = fz_new_stext_page_from_page(ctx, page, &opts);

            for (fz_stext_block *blk = stext->first_block; blk; blk = blk->next) {
                if (blk->type != FZ_STEXT_BLOCK_TEXT) continue;
                int wrote_block = 0;
                for (fz_stext_line *line = blk->u.t.first_line; line; line = line->next) {
                    int last_cp = 0;
                    int wrote_line = 0;
                    for (fz_stext_char *ch = line->first_char; ch; ch = ch->next) {
                        int cp = ch->c;
                        if (cp == 0 || is_ignorable_ctrl(cp)) continue;
                        if (cp == 0x00AD && ch->next == NULL) {
                            /* Soft hyphen at line end: omit for clean word joining */
                            last_cp = 0x00AD;
                            continue;
                        }
                        if (is_space_cp(cp)) {
                            if (wrote_line && last_cp != ' ') {
                                sb_append_ch(&sb, ' ');
                                last_cp = ' ';
                            }
                            continue;
                        }
                        sb_append_utf8(&sb, cp);
                        last_cp = cp;
                        wrote_line = 1;
                        wrote_block = 1;
                    }
                    if (wrote_line && line->next) {
                        /* Join lines inside paragraph with space unless dehyphenated or CJK */
                        if (last_cp != 0x00AD && last_cp != ' ' && !is_cjk_cp(last_cp)) {
                            sb_append_ch(&sb, ' ');
                        }
                    }
                }
                if (wrote_block) {
                    sb_append_ch(&sb, '\n');
                }
            }
        }
        fz_always(ctx) {
            if (stext) fz_drop_stext_page(ctx, stext);
            if (page) fz_drop_page(ctx, page);
        }
        fz_catch(ctx) {
            /* Skip corrupt page rather than aborting whole document */
        }

        sb_append_n(&sb, "\n\n", 2);
        if (p != pages_to_extract - 1) {
            sb_append_ch(&sb, '\f');
        }

        /* Keep store memory bounded on huge textbooks */
        if ((p & 31) == 31) {
            fz_empty_store(ctx);
        }
    }

    if (sb.oom) {
        sb_free(&sb);
        if (out_err) *out_err = -4;
        return NULL;
    }

    if (out_len) *out_len = (int)sb.len;
    if (out_extracted_pages) *out_extracted_pages = pages_to_extract;
    if (out_total_pages) *out_total_pages = total_pages;
    if (out_err) *out_err = 0;
    return sb.data;
}

/* ---------- 2. Single-Page Structured Chars + Links (for Reader getPageData) ---------- */

typedef struct {
    int cp;
    float x0, y0, x1, y1;
    float lx0, ly0, lx1, ly1;
    float size;
    int font_idx;
    int flags;
    int rot;
} FlatChar;

typedef struct {
    const char *names[MAX_FONT_TABLE];
    int count;
} FontTable;

static int font_table_intern(FontTable *ft, const char *name) {
    if (!name || !*name) name = "";
    for (int i = 0; i < ft->count; ++i) {
        if (strcmp(ft->names[i], name) == 0) return i;
    }
    if (ft->count < MAX_FONT_TABLE) {
        ft->names[ft->count] = name;
        return ft->count++;
    }
    return 0;
}

static int line_dir_to_rotation(fz_point dir, uint8_t wmode) {
    if (wmode != 0) return 270;
    float ax = fabsf(dir.x);
    float ay = fabsf(dir.y);
    if (ax >= ay) {
        return dir.x >= 0.0f ? 0 : 180;
    } else {
        /* In MuPDF top-down coords, upward text has dir.y < 0 (PDF rotation 90) */
        return dir.y < 0.0f ? 90 : 270;
    }
}

ZOT_TURBO_API char *zot_turbo_pdf_page_data(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int page_index,
    int *out_len,
    int *out_err
) {
    if (out_len) *out_len = 0;
    if (out_err) *out_err = 0;

    int total_pages = 0;
    int err = 0;
    fz_document *doc = get_or_open_doc(eng, utf8_path, &total_pages, &err);
    if (!doc) {
        if (out_err) *out_err = err ? err : -2;
        return NULL;
    }
    if (page_index < 0 || page_index >= total_pages) {
        if (out_err) *out_err = -1;
        return NULL;
    }

    fz_context *ctx = eng->ctx;
    fz_page *page = NULL;
    fz_stext_page *stext = NULL;
    fz_link *links = NULL;
    fz_rect page_box = fz_empty_rect;

    FlatChar *chars = NULL;
    int char_count = 0;
    int char_cap = 0;
    FontTable ftab;
    memset(&ftab, 0, sizeof(ftab));

    StrBuf sb;
    if (sb_init(&sb, 32768) != 0) {
        if (out_err) *out_err = -4;
        return NULL;
    }

    int failed = 0;
    fz_var(page);
    fz_var(stext);
    fz_var(links);

    fz_try(ctx) {
        page = fz_load_page(ctx, doc, page_index);
        page_box = fz_bound_page(ctx, page);

        fz_stext_options opts;
        fz_init_stext_options(ctx, &opts);
        opts.flags = FZ_STEXT_CLIP;
        stext = fz_new_stext_page_from_page(ctx, page, &opts);
        links = fz_load_links(ctx, page);

        /* Collect structured chars */
        char_cap = 2048;
        chars = (FlatChar *)malloc((size_t)char_cap * sizeof(FlatChar));
        if (!chars) fz_throw(ctx, FZ_ERROR_SYSTEM, "OOM");

        for (fz_stext_block *blk = stext->first_block; blk; blk = blk->next) {
            if (blk->type != FZ_STEXT_BLOCK_TEXT) continue;
            int block_start_idx = char_count;

            for (fz_stext_line *line = blk->u.t.first_line; line; line = line->next) {
                int rot = line_dir_to_rotation(line->dir, line->wmode);
                int line_start_idx = char_count;
                fz_rect lbox = line->bbox;
                int pending_space = 0;

                for (fz_stext_char *ch = line->first_char; ch; ch = ch->next) {
                    int cp = ch->c;
                    if (cp == 0 || is_ignorable_ctrl(cp)) continue;
                    if (is_space_cp(cp)) {
                        pending_space = 1;
                        continue;
                    }
                    if (ch->size <= 0.0f) continue;

                    if (pending_space && char_count > line_start_idx) {
                        chars[char_count - 1].flags |= (4 | 8); /* spaceAfter | wordBreakAfter */
                    }
                    pending_space = 0;

                    if (char_count >= char_cap) {
                        int new_cap = char_cap * 2;
                        FlatChar *nc = (FlatChar *)realloc(chars, (size_t)new_cap * sizeof(FlatChar));
                        if (!nc) fz_throw(ctx, FZ_ERROR_SYSTEM, "OOM");
                        chars = nc;
                        char_cap = new_cap;
                    }

                    fz_rect r = fz_rect_from_quad(ch->quad);
                    const char *fname = ch->font ? fz_font_name(ctx, ch->font) : "";
                    int fidx = font_table_intern(&ftab, fname);
                    int fl = 0;
                    if ((ch->flags & FZ_STEXT_BOLD) || (ch->font && fz_font_is_bold(ctx, ch->font))) {
                        fl |= 1;
                    }
                    if (ch->font && fz_font_is_italic(ctx, ch->font)) {
                        fl |= 2;
                    }
                    if (is_cjk_cp(cp)) {
                        fl |= 8; /* wordBreakAfter on CJK chars */
                    }

                    /* Detect implicit word gap between adjacent non-space chars if gap > 0.28 * size */
                    if (char_count > line_start_idx && rot == 0) {
                        FlatChar *prev = &chars[char_count - 1];
                        float gap = r.x0 - prev->x1;
                        if (gap > ch->size * 0.28f && !is_cjk_cp(prev->cp) && !is_cjk_cp(cp)) {
                            prev->flags |= (4 | 8);
                        }
                    }

                    FlatChar *fc = &chars[char_count++];
                    fc->cp = cp;
                    fc->x0 = r.x0;
                    fc->y0 = r.y0;
                    fc->x1 = r.x1;
                    fc->y1 = r.y1;
                    fc->lx0 = lbox.x0;
                    fc->ly0 = lbox.y0;
                    fc->lx1 = lbox.x1;
                    fc->ly1 = lbox.y1;
                    fc->size = ch->size;
                    fc->font_idx = fidx;
                    fc->flags = fl;
                    fc->rot = rot;
                }

                if (char_count > line_start_idx) {
                    /* Compute tight line rect across actual emitted chars */
                    float minx = chars[line_start_idx].x0;
                    float miny = chars[line_start_idx].y0;
                    float maxx = chars[line_start_idx].x1;
                    float maxy = chars[line_start_idx].y1;
                    for (int i = line_start_idx + 1; i < char_count; ++i) {
                        if (chars[i].x0 < minx) minx = chars[i].x0;
                        if (chars[i].y0 < miny) miny = chars[i].y0;
                        if (chars[i].x1 > maxx) maxx = chars[i].x1;
                        if (chars[i].y1 > maxy) maxy = chars[i].y1;
                    }
                    for (int i = line_start_idx; i < char_count; ++i) {
                        if (rot == 90 || rot == 270) {
                            chars[i].lx0 = minx;
                            chars[i].lx1 = maxx;
                            chars[i].ly0 = chars[i].y0;
                            chars[i].ly1 = chars[i].y1;
                        } else {
                            chars[i].lx0 = chars[i].x0;
                            chars[i].lx1 = chars[i].x1;
                            chars[i].ly0 = miny;
                            chars[i].ly1 = maxy;
                        }
                    }
                    FlatChar *last = &chars[char_count - 1];
                    last->flags |= (16 | 8); /* lineBreakAfter | wordBreakAfter */
                    if (is_hyphen_cp(last->cp)) {
                        last->flags |= 64; /* ignorable trailing hyphen */
                    }
                }
            }

            if (char_count > block_start_idx) {
                chars[char_count - 1].flags |= 32; /* paragraphBreakAfter */
            }
        }

        /* Serialize compact JSON: {"b":[...],"f":[...],"c":[...],"l":[...]} */
        sb_append_fmt(&sb, "{\"b\":[%.2f,%.2f,%.2f,%.2f],\"f\":[",
                      page_box.x0, page_box.y0, page_box.x1, page_box.y1);
        for (int i = 0; i < ftab.count; ++i) {
            if (i > 0) sb_append_ch(&sb, ',');
            sb_append_json_str(&sb, ftab.names[i]);
        }
        sb_append_str(&sb, "],\"c\":[");
        for (int i = 0; i < char_count && !sb.oom; ++i) {
            const FlatChar *fc = &chars[i];
            if (i > 0) sb_append_ch(&sb, ',');
            sb_append_fmt(&sb, "[%d,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%d,%d,%d]",
                          fc->cp,
                          fc->x0, fc->y0, fc->x1, fc->y1,
                          fc->lx0, fc->ly0, fc->lx1, fc->ly1,
                          fc->size, fc->font_idx, fc->flags, fc->rot);
        }
        sb_append_str(&sb, "],\"l\":[");
        int link_i = 0;
        for (fz_link *lnk = links; lnk && !sb.oom; lnk = lnk->next) {
            if (!lnk->uri || !*lnk->uri) continue;
            int is_ext = fz_is_external_link(ctx, lnk->uri) ? 1 : 0;
            int dest_page = -1;
            float dx = 0.0f, dy = 0.0f;
            if (!is_ext) {
                fz_location loc = fz_resolve_link(ctx, doc, lnk->uri, &dx, &dy);
                if (loc.page >= 0) {
                    dest_page = fz_page_number_from_location(ctx, doc, loc);
                }
            }
            if (link_i++ > 0) sb_append_ch(&sb, ',');
            sb_append_fmt(&sb, "[%d,%.2f,%.2f,%.2f,%.2f,",
                          is_ext, lnk->rect.x0, lnk->rect.y0, lnk->rect.x1, lnk->rect.y1);
            sb_append_json_str(&sb, is_ext ? lnk->uri : "");
            sb_append_fmt(&sb, ",%d,%.2f,%.2f]", dest_page, dx, dy);
        }
        sb_append_str(&sb, "]}");
    }
    fz_always(ctx) {
        if (links) fz_drop_link(ctx, links);
        if (stext) fz_drop_stext_page(ctx, stext);
        if (page) fz_drop_page(ctx, page);
        free(chars);
    }
    fz_catch(ctx) {
        failed = 1;
    }

    if (failed || sb.oom) {
        sb_free(&sb);
        if (out_err) *out_err = -4;
        return NULL;
    }

    if (out_len) *out_len = (int)sb.len;
    if (out_err) *out_err = 0;
    return sb.data;
}

/* ---------- 3. Fast PDF Annotation Presence Check ---------- */

ZOT_TURBO_API int zot_turbo_pdf_has_annots(ZotTurboEngine *eng, const char *utf8_path) {
    int total_pages = 0;
    int err = 0;
    fz_document *doc = get_or_open_doc(eng, utf8_path, &total_pages, &err);
    if (!doc) return err ? err : -2;

    fz_context *ctx = eng->ctx;
    int found = 0;
    for (int p = 0; p < total_pages && !found; ++p) {
        fz_page *page = NULL;
        fz_device *dev = NULL;
        fz_rect bbox = fz_empty_rect;
        fz_var(page);
        fz_var(dev);
        fz_try(ctx) {
            page = fz_load_page(ctx, doc, p);
            dev = fz_new_bbox_device(ctx, &bbox);
            fz_run_page_annots(ctx, page, dev, fz_identity, NULL);
            fz_close_device(ctx, dev);
            if (!fz_is_empty_rect(bbox)) {
                found = 1;
            }
        }
        fz_always(ctx) {
            if (dev) fz_drop_device(ctx, dev);
            if (page) fz_drop_page(ctx, page);
        }
        fz_catch(ctx) {
            /* Ignore page error */
        }
    }
    return found;
}

/* ---------- 4. Multi-Threaded Parallel File Substring Scanner ---------- */

static inline unsigned char ascii_tolower(unsigned char c) {
    return (c >= 'A' && c <= 'Z') ? (unsigned char)(c + 32) : c;
}

/* Fast Boyer-Moore-Horspool substring search (case-sensitive or ASCII-case-insensitive) */
static int bmh_contains(
    const unsigned char *hay,
    size_t hay_len,
    const unsigned char *needle,
    size_t nlen,
    int case_sensitive,
    const size_t skip[256]
) {
    if (nlen == 0) return 1;
    if (hay_len < nlen) return 0;

    size_t i = 0;
    size_t last = nlen - 1;
    unsigned char nlast = case_sensitive ? needle[last] : ascii_tolower(needle[last]);

    if (case_sensitive) {
        while (i <= hay_len - nlen) {
            unsigned char c = hay[i + last];
            if (c == nlast) {
                if (last == 0 || memcmp(hay + i, needle, last) == 0) {
                    return 1;
                }
            }
            i += skip[c];
        }
    } else {
        while (i <= hay_len - nlen) {
            unsigned char c = ascii_tolower(hay[i + last]);
            if (c == nlast) {
                size_t j = last;
                while (j > 0 && ascii_tolower(hay[i + j - 1]) == needle[j - 1]) {
                    --j;
                }
                if (j == 0) return 1;
            }
            i += skip[c];
        }
    }
    return 0;
}

/* Collapse consecutive ASCII whitespace into single ' ' in-place */
static size_t normalize_ws_inplace(unsigned char *buf, size_t len) {
    size_t w = 0;
    int in_ws = 0;
    for (size_t r = 0; r < len; ++r) {
        unsigned char c = buf[r];
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v') {
            if (!in_ws && w > 0) {
                buf[w++] = ' ';
                in_ws = 1;
            }
        } else {
            buf[w++] = c;
            in_ws = 0;
        }
    }
    if (w > 0 && buf[w - 1] == ' ') --w;
    return w;
}

typedef struct {
    const char **paths;
    int count;
    unsigned char *matched;
    const unsigned char *needle;
    size_t needle_len;
    size_t skip[256];
    int case_sensitive;
    int norm_ws;
    size_t max_bytes;
#ifdef _WIN32
    volatile LONG next_idx;
    volatile LONG scanned;
#else
    int next_idx;
    int scanned;
#endif
} ScanJob;

static void scan_worker_run(ScanJob *job) {
    unsigned char *buf = (unsigned char *)malloc(job->max_bytes + 1);
    if (!buf) return;

    for (;;) {
#ifdef _WIN32
        int idx = (int)InterlockedIncrement(&job->next_idx) - 1;
#else
        int idx = __atomic_fetch_add(&job->next_idx, 1, __ATOMIC_RELAXED);
#endif
        if (idx >= job->count) break;

        const char *path = job->paths[idx];
        if (!path || !*path) continue;

        FILE *fp = fopen_utf8_rb(path);
        if (!fp) continue;

        size_t nread = fread(buf, 1, job->max_bytes, fp);
        fclose(fp);

#ifdef _WIN32
        InterlockedIncrement(&job->scanned);
#else
        __atomic_fetch_add(&job->scanned, 1, __ATOMIC_RELAXED);
#endif

        if (nread == 0) continue;
        if (job->norm_ws) {
            nread = normalize_ws_inplace(buf, nread);
        }
        if (bmh_contains(buf, nread, job->needle, job->needle_len, job->case_sensitive, job->skip)) {
            job->matched[idx] = 1;
        }
    }

    free(buf);
}

#ifdef _WIN32
static unsigned __stdcall scan_thread_win(void *arg) {
    scan_worker_run((ScanJob *)arg);
    return 0;
}
#else
static void *scan_thread_posix(void *arg) {
    scan_worker_run((ScanJob *)arg);
    return NULL;
}
#endif

ZOT_TURBO_API char *zot_turbo_scan_files(
    const char *paths_newline_sep,
    const char *needle_utf8,
    int flags,
    int max_bytes_per_file,
    int num_threads,
    int *out_len,
    int *out_scanned_count,
    int *out_err
) {
    if (out_len) *out_len = 0;
    if (out_scanned_count) *out_scanned_count = 0;
    if (out_err) *out_err = 0;

    if (!paths_newline_sep || !needle_utf8) {
        if (out_err) *out_err = -1;
        return NULL;
    }

    int case_sensitive = (flags & 1) ? 1 : 0;
    int norm_ws = (flags & 2) ? 1 : 0;
    size_t max_bytes = max_bytes_per_file > 0 ? (size_t)max_bytes_per_file : 500000ULL;
    if (max_bytes > 16ULL * 1024ULL * 1024ULL) max_bytes = 16ULL * 1024ULL * 1024ULL;

    /* Copy & split paths by '\n' */
    size_t plist_len = strlen(paths_newline_sep);
    char *plist_copy = (char *)malloc(plist_len + 1);
    if (!plist_copy) {
        if (out_err) *out_err = -4;
        return NULL;
    }
    memcpy(plist_copy, paths_newline_sep, plist_len + 1);

    int cap = 64, count = 0;
    const char **paths = (const char **)malloc((size_t)cap * sizeof(char *));
    if (!paths) {
        free(plist_copy);
        if (out_err) *out_err = -4;
        return NULL;
    }

    char *p = plist_copy;
    while (*p) {
        char *line = p;
        char *nl = strchr(p, '\n');
        if (nl) {
            *nl = '\0';
            if (nl > line && nl[-1] == '\r') nl[-1] = '\0';
            p = nl + 1;
        } else {
            size_t rem = strlen(line);
            if (rem > 0 && line[rem - 1] == '\r') line[rem - 1] = '\0';
            p = line + strlen(line);
        }
        if (count >= cap) {
            cap *= 2;
            const char **np = (const char **)realloc(paths, (size_t)cap * sizeof(char *));
            if (!np) {
                free(paths);
                free(plist_copy);
                if (out_err) *out_err = -4;
                return NULL;
            }
            paths = np;
        }
        paths[count++] = line;
    }

    if (count == 0) {
        free(paths);
        free(plist_copy);
        char *empty = (char *)malloc(3);
        if (!empty) {
            if (out_err) *out_err = -4;
            return NULL;
        }
        memcpy(empty, "[]", 3);
        if (out_len) *out_len = 2;
        return empty;
    }

    /* Prepare needle */
    size_t nlen = strlen(needle_utf8);
    unsigned char *needle_buf = (unsigned char *)malloc(nlen + 1);
    if (!needle_buf) {
        free(paths);
        free(plist_copy);
        if (out_err) *out_err = -4;
        return NULL;
    }
    memcpy(needle_buf, needle_utf8, nlen + 1);
    if (norm_ws) {
        nlen = normalize_ws_inplace(needle_buf, nlen);
    }
    if (!case_sensitive) {
        for (size_t i = 0; i < nlen; ++i) {
            needle_buf[i] = ascii_tolower(needle_buf[i]);
        }
    }

    unsigned char *matched = (unsigned char *)calloc((size_t)count, 1);
    if (!matched) {
        free(needle_buf);
        free(paths);
        free(plist_copy);
        if (out_err) *out_err = -4;
        return NULL;
    }

    ScanJob job;
    memset(&job, 0, sizeof(job));
    job.paths = paths;
    job.count = count;
    job.matched = matched;
    job.needle = needle_buf;
    job.needle_len = nlen;
    job.case_sensitive = case_sensitive;
    job.norm_ws = norm_ws;
    job.max_bytes = max_bytes;

    /* Build BMH skip table */
    for (int i = 0; i < 256; ++i) job.skip[i] = nlen > 0 ? nlen : 1;
    if (nlen > 1) {
        for (size_t i = 0; i < nlen - 1; ++i) {
            job.skip[needle_buf[i]] = nlen - 1 - i;
        }
    }

    int threads = num_threads > 0 ? num_threads : get_cpu_count();
    if (threads > 8) threads = 8;
    if (threads > count) threads = count;
    if (count < 8) threads = 1; /* Avoid thread spawn overhead for tiny batches */

    if (threads <= 1) {
        scan_worker_run(&job);
    } else {
#ifdef _WIN32
        HANDLE th[8];
        int spawned = 0;
        for (int t = 0; t < threads - 1; ++t) {
            uintptr_t h = _beginthreadex(NULL, 0, scan_thread_win, &job, 0, NULL);
            if (h) th[spawned++] = (HANDLE)h;
        }
        scan_worker_run(&job);
        if (spawned > 0) {
            WaitForMultipleObjects((DWORD)spawned, th, TRUE, INFINITE);
            for (int t = 0; t < spawned; ++t) CloseHandle(th[t]);
        }
#else
        pthread_t th[8];
        int spawned = 0;
        for (int t = 0; t < threads - 1; ++t) {
            if (pthread_create(&th[spawned], NULL, scan_thread_posix, &job) == 0) {
                ++spawned;
            }
        }
        scan_worker_run(&job);
        for (int t = 0; t < spawned; ++t) {
            pthread_join(th[t], NULL);
        }
#endif
    }

    StrBuf sb;
    if (sb_init(&sb, 256) != 0) {
        free(matched);
        free(needle_buf);
        free(paths);
        free(plist_copy);
        if (out_err) *out_err = -4;
        return NULL;
    }

    sb_append_ch(&sb, '[');
    int first = 1;
    for (int i = 0; i < count; ++i) {
        if (matched[i]) {
            if (!first) sb_append_ch(&sb, ',');
            sb_append_fmt(&sb, "%d", i);
            first = 0;
        }
    }
    sb_append_ch(&sb, ']');

    int scanned_total = (int)job.scanned;

    free(matched);
    free(needle_buf);
    free(paths);
    free(plist_copy);

    if (sb.oom) {
        sb_free(&sb);
        if (out_err) *out_err = -4;
        return NULL;
    }

    if (out_len) *out_len = (int)sb.len;
    if (out_scanned_count) *out_scanned_count = scanned_total;
    if (out_err) *out_err = 0;
    return sb.data;
}

/* ---------- 5. Fast PDF Embedded Outline (for Reader getOutline2) ---------- */

typedef struct {
    fz_context *ctx;
    fz_document *doc;
    int total_pages;
    float *page_heights; /* lazily cached page heights for PDF bottom-up y conversion */
} OutlineSerCtx;

static float outline_get_page_height(OutlineSerCtx *oc, int page_idx) {
    if (page_idx < 0 || page_idx >= oc->total_pages) return 792.0f;
    if (oc->page_heights[page_idx] > 0.0f) return oc->page_heights[page_idx];
    float h = 792.0f;
    fz_page *pg = NULL;
    fz_var(pg);
    fz_try(oc->ctx) {
        pg = fz_load_page(oc->ctx, oc->doc, page_idx);
        fz_rect r = fz_bound_page(oc->ctx, pg);
        if (r.y1 > r.y0) h = r.y1 - r.y0;
    }
    fz_always(oc->ctx) {
        if (pg) fz_drop_page(oc->ctx, pg);
    }
    fz_catch(oc->ctx) {
        h = 792.0f;
    }
    oc->page_heights[page_idx] = h;
    return h;
}

static void serialize_outline_list(OutlineSerCtx *oc, StrBuf *sb, fz_outline *node, int depth) {
    sb_append_ch(sb, '[');
    int first = 1;
    for (fz_outline *cur = node; cur && !sb->oom; cur = cur->next) {
        if (!first) sb_append_ch(sb, ',');
        first = 0;

        sb_append_str(sb, "{\"title\":");
        sb_append_json_str(sb, cur->title ? cur->title : "");
        sb_append_str(sb, ",\"items\":");
        if (cur->down && depth < 16) {
            serialize_outline_list(oc, sb, cur->down, depth + 1);
        } else {
            sb_append_str(sb, "[]");
        }

        if (cur->uri && *cur->uri && fz_is_external_link(oc->ctx, cur->uri)) {
            sb_append_str(sb, ",\"url\":");
            sb_append_json_str(sb, cur->uri);
        } else {
            int pnum = -1;
            float x = cur->x;
            float y = cur->y;
            if (cur->page.page >= 0) {
                pnum = fz_page_number_from_location(oc->ctx, oc->doc, cur->page);
            } else if (cur->uri && *cur->uri) {
                fz_try(oc->ctx) {
                    fz_location loc = fz_resolve_link(oc->ctx, oc->doc, cur->uri, &x, &y);
                    if (loc.page >= 0) {
                        pnum = fz_page_number_from_location(oc->ctx, oc->doc, loc);
                    }
                }
                fz_catch(oc->ctx) {
                    pnum = -1;
                }
            }
            if (pnum >= 0 && pnum < oc->total_pages) {
                float ph = outline_get_page_height(oc, pnum);
                float px = isfinite(x) ? x : 0.0f;
                float py = isfinite(y) ? (ph - y) : ph;
                if (px < 0.0f) px = 0.0f;
                if (py < 0.0f) py = 0.0f;
                if (py > ph) py = ph;
                sb_append_fmt(sb, ",\"location\":{\"position\":{\"pageIndex\":%d,\"rects\":[[%.2f,%.2f,%.2f,%.2f]]}}",
                              pnum, px, py, px, py);
            }
        }
        sb_append_ch(sb, '}');
    }
    sb_append_ch(sb, ']');
}

ZOT_TURBO_API char *zot_turbo_pdf_outline(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int *out_len,
    int *out_err
) {
    if (out_len) *out_len = 0;
    if (out_err) *out_err = 0;

    int total_pages = 0;
    int err = 0;
    fz_document *doc = get_or_open_doc(eng, utf8_path, &total_pages, &err);
    if (!doc) {
        if (out_err) *out_err = err ? err : -2;
        return NULL;
    }

    fz_context *ctx = eng->ctx;
    fz_outline *root = NULL;
    fz_var(root);
    fz_try(ctx) {
        root = fz_load_outline(ctx, doc);
    }
    fz_catch(ctx) {
        root = NULL;
    }

    if (!root) {
        if (out_err) *out_err = 1; /* No embedded outline: caller can run heuristic extraction */
        return NULL;
    }

    /* Match Zotero's getExistingOutline unwrap rule:
     * if top-level has 1 item and it has > 1 children, promote children. */
    fz_outline *emit_root = root;
    if (root->next == NULL && root->down != NULL && root->down->next != NULL) {
        emit_root = root->down;
    }

    float *page_heights = (float *)calloc((size_t)(total_pages > 0 ? total_pages : 1), sizeof(float));
    if (!page_heights) {
        fz_drop_outline(ctx, root);
        if (out_err) *out_err = -4;
        return NULL;
    }

    StrBuf sb;
    if (sb_init(&sb, 4096) != 0) {
        free(page_heights);
        fz_drop_outline(ctx, root);
        if (out_err) *out_err = -4;
        return NULL;
    }

    OutlineSerCtx oc;
    oc.ctx = ctx;
    oc.doc = doc;
    oc.total_pages = total_pages;
    oc.page_heights = page_heights;

    serialize_outline_list(&oc, &sb, emit_root, 0);

    free(page_heights);
    fz_drop_outline(ctx, root);

    if (sb.oom) {
        sb_free(&sb);
        if (out_err) *out_err = -4;
        return NULL;
    }

    if (out_len) *out_len = (int)sb.len;
    if (out_err) *out_err = 0;
    return sb.data;
}

/* ---------- 6. Fast PDF Recognizer Data (for Zotero.PDFWorker.getRecognizerData) ---------- */

static void append_meta_field(fz_context *ctx, fz_document *doc, StrBuf *sb, int *first, const char *fz_key, const char *json_key) {
    char val[1024];
    val[0] = '\0';
    int n = fz_lookup_metadata(ctx, doc, fz_key, val, sizeof(val));
    if (n > 0 && val[0] != '\0') {
        if (!*first) sb_append_ch(sb, ',');
        *first = 0;
        sb_append_json_str(sb, json_key);
        sb_append_ch(sb, ':');
        sb_append_json_str(sb, val);
    }
}

static void emit_recognizer_word(
    StrBuf *sb,
    int *first_word,
    float x0, float y0, float x1, float y1,
    float font_size,
    int space_after,
    float baseline,
    int bold,
    int italic,
    int font_idx,
    const char *word_utf8
) {
    if (!word_utf8 || !*word_utf8) return;
    if (!*first_word) sb_append_ch(sb, ',');
    *first_word = 0;
    sb_append_fmt(sb, "[%.4f,%.4f,%.4f,%.4f,%.4f,%d,%.4f,0,0,%d,%d,0,%d,",
                  x0, y0, x1, y1, font_size, space_after ? 1 : 0, baseline, bold ? 1 : 0, italic ? 1 : 0, font_idx);
    sb_append_json_str(sb, word_utf8);
    sb_append_ch(sb, ']');
}

ZOT_TURBO_API char *zot_turbo_pdf_recognizer_data(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int max_pages,
    int *out_len,
    int *out_err
) {
    if (out_len) *out_len = 0;
    if (out_err) *out_err = 0;

    int total_pages = 0;
    int err = 0;
    fz_document *doc = get_or_open_doc(eng, utf8_path, &total_pages, &err);
    if (!doc) {
        if (out_err) *out_err = err ? err : -2;
        return NULL;
    }

    int pages_n = max_pages > 0 ? max_pages : 5;
    if (pages_n > total_pages) pages_n = total_pages;

    StrBuf sb;
    if (sb_init(&sb, 32768) != 0) {
        if (out_err) *out_err = -4;
        return NULL;
    }

    fz_context *ctx = eng->ctx;

    /* Emit metadata + totalPages */
    sb_append_str(&sb, "{\"metadata\":{");
    int first_meta = 1;
    append_meta_field(ctx, doc, &sb, &first_meta, FZ_META_INFO_TITLE, "Title");
    append_meta_field(ctx, doc, &sb, &first_meta, FZ_META_INFO_AUTHOR, "Author");
    append_meta_field(ctx, doc, &sb, &first_meta, FZ_META_INFO_SUBJECT, "Subject");
    append_meta_field(ctx, doc, &sb, &first_meta, FZ_META_INFO_KEYWORDS, "Keywords");
    append_meta_field(ctx, doc, &sb, &first_meta, FZ_META_INFO_CREATOR, "Creator");
    append_meta_field(ctx, doc, &sb, &first_meta, FZ_META_INFO_PRODUCER, "Producer");
    append_meta_field(ctx, doc, &sb, &first_meta, FZ_META_INFO_CREATIONDATE, "CreationDate");
    append_meta_field(ctx, doc, &sb, &first_meta, FZ_META_INFO_MODIFICATIONDATE, "ModDate");
    sb_append_fmt(&sb, "},\"totalPages\":%d,\"pages\":[", total_pages);

    fz_stext_options opts;
    fz_init_stext_options(ctx, &opts);
    opts.flags = FZ_STEXT_CLIP;

    StrBuf wbuf;
    if (sb_init(&wbuf, 256) != 0) {
        sb_free(&sb);
        if (out_err) *out_err = -4;
        return NULL;
    }

    for (int p = 0; p < pages_n && !sb.oom; ++p) {
        if (p > 0) sb_append_ch(&sb, ',');
        fz_page *page = NULL;
        fz_stext_page *stext = NULL;
        fz_var(page);
        fz_var(stext);

        fz_try(ctx) {
            page = fz_load_page(ctx, doc, p);
            fz_rect pbox = fz_bound_page(ctx, page);
            float pw = pbox.x1 - pbox.x0;
            float ph = pbox.y1 - pbox.y0;
            stext = fz_new_stext_page_from_page(ctx, page, &opts);

            FontTable ftab;
            memset(&ftab, 0, sizeof(ftab));

            sb_append_fmt(&sb, "[%.4f,%.4f,[[[[0,0,0,0,[", pw, ph);
            int first_line = 1;

            for (fz_stext_block *blk = stext->first_block; blk && !sb.oom; blk = blk->next) {
                if (blk->type != FZ_STEXT_BLOCK_TEXT) continue;
                for (fz_stext_line *line = blk->u.t.first_line; line && !sb.oom; line = line->next) {
                    int line_opened = 0;
                    int first_word = 1;

                    wbuf.len = 0;
                    wbuf.data[0] = '\0';
                    float wx0 = 0, wy0 = 0, wx1 = 0, wy1 = 0;
                    float wsize = 0, wbase = 0;
                    int wbold = 0, witalic = 0, wfidx = 0;
                    int has_word = 0;

                    for (fz_stext_char *ch = line->first_char; ch; ch = ch->next) {
                        int cp = ch->c;
                        if (cp == 0 || is_ignorable_ctrl(cp)) continue;
                        if (is_space_cp(cp)) {
                            if (has_word) {
                                if (!line_opened) {
                                    if (!first_line) sb_append_ch(&sb, ',');
                                    first_line = 0;
                                    sb_append_str(&sb, "[[");
                                    line_opened = 1;
                                }
                                emit_recognizer_word(&sb, &first_word, wx0, wy0, wx1, wy1, wsize, 1, wbase, wbold, witalic, wfidx, wbuf.data);
                                wbuf.len = 0;
                                wbuf.data[0] = '\0';
                                has_word = 0;
                            }
                            continue;
                        }
                        if (ch->size <= 0.0f) continue;

                        fz_rect r = fz_rect_from_quad(ch->quad);
                        /* Break word on wide horizontal gap (> 0.30 * fontSize) */
                        if (has_word && (r.x0 - wx1) > ch->size * 0.30f) {
                            if (!line_opened) {
                                if (!first_line) sb_append_ch(&sb, ',');
                                first_line = 0;
                                sb_append_str(&sb, "[[");
                                line_opened = 1;
                            }
                            emit_recognizer_word(&sb, &first_word, wx0, wy0, wx1, wy1, wsize, 1, wbase, wbold, witalic, wfidx, wbuf.data);
                            wbuf.len = 0;
                            wbuf.data[0] = '\0';
                            has_word = 0;
                        }

                        if (!has_word) {
                            wx0 = r.x0; wy0 = r.y0; wx1 = r.x1; wy1 = r.y1;
                            wsize = ch->size;
                            wbase = ch->origin.y;
                            wbold = ((ch->flags & FZ_STEXT_BOLD) || (ch->font && fz_font_is_bold(ctx, ch->font))) ? 1 : 0;
                            witalic = (ch->font && fz_font_is_italic(ctx, ch->font)) ? 1 : 0;
                            wfidx = font_table_intern(&ftab, ch->font ? fz_font_name(ctx, ch->font) : "");
                            has_word = 1;
                        } else {
                            if (r.x0 < wx0) wx0 = r.x0;
                            if (r.y0 < wy0) wy0 = r.y0;
                            if (r.x1 > wx1) wx1 = r.x1;
                            if (r.y1 > wy1) wy1 = r.y1;
                        }
                        sb_append_utf8(&wbuf, cp);

                        /* CJK characters act as individual word tokens */
                        if (is_cjk_cp(cp)) {
                            if (!line_opened) {
                                if (!first_line) sb_append_ch(&sb, ',');
                                first_line = 0;
                                sb_append_str(&sb, "[[");
                                line_opened = 1;
                            }
                            emit_recognizer_word(&sb, &first_word, wx0, wy0, wx1, wy1, wsize, 0, wbase, wbold, witalic, wfidx, wbuf.data);
                            wbuf.len = 0;
                            wbuf.data[0] = '\0';
                            has_word = 0;
                        }
                    }

                    if (has_word) {
                        if (!line_opened) {
                            if (!first_line) sb_append_ch(&sb, ',');
                            first_line = 0;
                            sb_append_str(&sb, "[[");
                            line_opened = 1;
                        }
                        emit_recognizer_word(&sb, &first_word, wx0, wy0, wx1, wy1, wsize, 0, wbase, wbold, witalic, wfidx, wbuf.data);
                    }
                    if (line_opened) {
                        sb_append_str(&sb, "]]");
                    }
                }
            }
            sb_append_str(&sb, "]]]]]]]");
        }
        fz_always(ctx) {
            if (stext) fz_drop_stext_page(ctx, stext);
            if (page) fz_drop_page(ctx, page);
        }
        fz_catch(ctx) {
            sb_append_str(&sb, "[612,792,[[[[0,0,0,0,[]]]]]]");
        }
    }

    sb_free(&wbuf);
    sb_append_str(&sb, "]}");

    if (sb.oom) {
        sb_free(&sb);
        if (out_err) *out_err = -4;
        return NULL;
    }

    if (out_len) *out_len = (int)sb.len;
    if (out_err) *out_err = 0;
    return sb.data;
}
