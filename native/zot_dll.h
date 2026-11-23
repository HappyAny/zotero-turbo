#ifndef ZOT_DLL_H
#define ZOT_DLL_H

#include <stdint.h>

#ifdef _WIN32
#define ZOT_EXPORT __declspec(dllexport)
#else
#define ZOT_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

ZOT_EXPORT const char *zot_dll_version(void);

// Process-wide refcounted singleton engine so multiple ChromeWorkers share doc/DL/bitmap caches safely.
ZOT_EXPORT void *zot_dll_engine_acquire(int store_mb, int pix_cache_mb, int bg_workers);
ZOT_EXPORT void  zot_dll_engine_release(void *eng);
ZOT_EXPORT void  zot_dll_engine_evict(void *eng);
ZOT_EXPORT void  zot_dll_engine_evict_path(void *eng, const char *path_utf8);
ZOT_EXPORT void  zot_dll_engine_trim(void *eng, int aggressive);
ZOT_EXPORT void  zot_dll_engine_abort(void *eng, int req_id);

// Per-ChromeWorker MuPDF cloned context (create once per worker thread, destroy on worker shutdown).
ZOT_EXPORT void *zot_dll_worker_create(void *eng);
ZOT_EXPORT void  zot_dll_worker_trim(void *worker);
ZOT_EXPORT void  zot_dll_worker_destroy(void *worker);

// Renders page directly into caller-allocated RGBA buffer (width * height * 4 bytes).
// out_stats[4] = { render_ms, cache_tier (0=cold, 1=dl, 2=pix), page_w, page_h }
// Returns: 0 = OK, 1 = Aborted, -1 = Error (err_buf populated).
ZOT_EXPORT int zot_dll_render_rgba(
    void *eng,
    void *worker,
    int req_id,
    const char *path_utf8,
    const char *password_utf8,
    int page_index,
    int width,
    int height,
    float m0, float m1, float m2, float m3, float m4, float m5,
    int include_annots,
    int aa_level,
    int theme_enabled,
    int bg_rgb,
    int fg_rgb,
    int invert_images,
    unsigned char *out_rgba,
    float *out_stats,
    char *err_buf,
    int err_cap
);

// Fast lock-free sidebar thumbnail renderer: computes exact rotated page aspect ratio directly
// from MuPDF bounds (bypassing PDF.js getPage!), shares Display List cache without touching
// main-page PIX cache or bg_queue.
// out_rgba must be at least target_w * max_h * 4 bytes.
// out_stats[4] = { render_ms, actual_w, actual_h, page_w / page_h }
ZOT_EXPORT int zot_dll_render_thumb_rgba(
    void *eng,
    void *worker,
    int req_id,
    const char *path_utf8,
    const char *password_utf8,
    int page_index,
    int target_w,
    int max_h,
    int aa_level,
    int theme_enabled,
    int bg_rgb,
    int fg_rgb,
    int invert_images,
    unsigned char *out_rgba,
    float *out_stats,
    char *err_buf,
    int err_cap
);

#ifdef __cplusplus
}
#endif

#endif
