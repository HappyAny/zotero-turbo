#ifndef ZOT_TURBO_H
#define ZOT_TURBO_H

#include <stdint.h>
#include <stddef.h>

#ifdef _WIN32
  #define ZOT_TURBO_API __declspec(dllexport)
#else
  #define ZOT_TURBO_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ZotTurboEngine ZotTurboEngine;

/* Create / destroy / trim engine instance (each ChromeWorker owns one, thread-safe per-instance). */
ZOT_TURBO_API ZotTurboEngine *zot_turbo_engine_create(int store_mb);
ZOT_TURBO_API void zot_turbo_engine_destroy(ZotTurboEngine *eng);
ZOT_TURBO_API void zot_turbo_engine_trim(ZotTurboEngine *eng, int aggressive);
ZOT_TURBO_API void zot_turbo_engine_evict_path(ZotTurboEngine *eng, const char *utf8_path);

/* Free a heap buffer returned by zot_turbo_* functions. */
ZOT_TURBO_API void zot_turbo_free_buf(void *ptr);

/* Extract PDF fulltext using MuPDF fz_stext_page.
 * - max_pages <= 0 means all pages.
 * - Returns heap-allocated NUL-terminated UTF-8 string (free via zot_turbo_free_buf), or NULL on error.
 * - Writes byte length (excluding NUL), extracted page count, and total page count to out params.
 * - Error codes written to *out_err: 0=OK, -1=bad arg, -2=open failed, -3=needs password, -4=OOM/render err.
 */
ZOT_TURBO_API char *zot_turbo_pdf_fulltext(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int max_pages,
    int *out_len,
    int *out_extracted_pages,
    int *out_total_pages,
    int *out_err
);

/* Extract single-page Zotero-compatible getPageData JSON:
 *   { "partial": true, "viewBox": [x0,y0,x1,y1], "chars": [...], "overlays": [...] }
 * - page_index is 0-based.
 * - Returns heap-allocated NUL-terminated UTF-8 JSON string (free via zot_turbo_free_buf), or NULL on error.
 */
ZOT_TURBO_API char *zot_turbo_pdf_page_data(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int page_index,
    int *out_len,
    int *out_err
);

/* Instant (<1ms) check whether a PDF contains any embedded annotations.
 * Returns: 1 = has annotations, 0 = no annotations, -2 = open failed, -3 = needs password.
 */
ZOT_TURBO_API int zot_turbo_pdf_has_annots(
    ZotTurboEngine *eng,
    const char *utf8_path
);

/* Multi-threaded parallel file substring scanner for Zotero.FullText.findTextInItems.
 * - paths_blob: NUL-or-newline separated list of UTF-8 file paths (`\n` separated).
 * - needle_utf8: search substring (UTF-8).
 * - flags: bit 0 = case_sensitive (0 = case-insensitive ASCII + exact UTF-8, 1 = case-sensitive),
 *          bit 1 = normalize_whitespace (collapse consecutive whitespace runs to single space).
 * - max_bytes_per_file: cap bytes read per file (<=0 means 500000).
 * - num_threads: worker thread count (<=0 means auto up to 8).
 * - Returns heap-allocated JSON array of matched 0-based file indices, e.g. "[0,5,19]" (free via zot_turbo_free_buf).
 */
ZOT_TURBO_API char *zot_turbo_scan_files(
    const char *paths_newline_sep,
    const char *needle_utf8,
    int flags,
    int max_bytes_per_file,
    int num_threads,
    int *out_len,
    int *out_scanned_count,
    int *out_err
);

/* Extract PDF outline/bookmarks tree in Zotero getOutline2() JSON format.
 * Returns heap-allocated JSON string (free via zot_turbo_free_buf), or NULL.
 * *out_err: 0=OK, 1=no embedded outline (caller should fallback), -2=open failed, -3=needs password.
 */
ZOT_TURBO_API char *zot_turbo_pdf_outline(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int *out_len,
    int *out_err
);

/* Extract PDF recognizer data (metadata + first max_pages word/line boxes) matching
 * Zotero.PDFWorker.getRecognizerData() JSON format.
 * max_pages <= 0 defaults to 5.
 * Returns heap-allocated JSON string (free via zot_turbo_free_buf), or NULL on error.
 */
ZOT_TURBO_API char *zot_turbo_pdf_recognizer_data(
    ZotTurboEngine *eng,
    const char *utf8_path,
    int max_pages,
    int *out_len,
    int *out_err
);

/* Return freed C heap blocks to OS (_heapmin/HeapCompact/malloc_trim) and optionally trim Windows Working Set. */
ZOT_TURBO_API void zot_turbo_os_trim_memory(int trim_working_set);

/* Get basic library version string (static, do NOT free). */
ZOT_TURBO_API const char *zot_turbo_version(void);

#ifdef __cplusplus
}
#endif

#endif /* ZOT_TURBO_H */
