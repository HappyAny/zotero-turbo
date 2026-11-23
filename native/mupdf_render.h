#ifndef ZOTERO_MUPDF_RENDER_H
#define ZOTERO_MUPDF_RENDER_H

#include <mupdf/fitz.h>
#include <stdint.h>

typedef struct {
    float x0, y0, x1, y1;
} ZotRect;

typedef struct {
    int enabled;
    unsigned char bg[3];
    unsigned char fg[3];
    int invert_images;
} ZotTheme;

// Base context with Win32 SRWLOCK / pthread locks (thread-safe for fz_clone_context).
fz_context *zot_new_base_context(size_t max_store, void **locks_out);
void zot_drop_base_context(fz_context *ctx, void *locks);

// Clone a context for a dedicated OS worker thread.
fz_context *zot_clone_context(fz_context *base);
void zot_drop_cloned_context(fz_context *ctx);

// Open a document (UTF-8 path on Windows is supported by MuPDF) and authenticate if needed.
// Returns NULL on failure and writes error message into err_buf.
fz_document *zot_open_document(
    fz_context *ctx,
    const char *path,
    const char *password,
    int *out_page_count,
    char *err_buf,
    int err_cap
);
void zot_drop_document(fz_context *ctx, fz_document *doc);

// Record a page into an immutable fz_display_list (can be replayed concurrently on cloned contexts).
// Supports optional fz_cookie for instant mid-parse cancellation (sets *out_aborted = 1 if aborted).
fz_display_list *zot_build_display_list_ex(
    fz_context *ctx,
    fz_document *doc,
    int page_index,
    int include_annots,
    fz_cookie *cookie,
    ZotRect *out_bounds,
    int *out_aborted,
    char *err_buf,
    int err_cap
);
fz_display_list *zot_build_display_list(
    fz_context *ctx,
    fz_document *doc,
    int page_index,
    int include_annots,
    ZotRect *out_bounds,
    char *err_buf,
    int err_cap
);
void zot_drop_display_list(fz_context *ctx, fz_display_list *dl);

// Render a display list directly into caller-provided RGBA buffer (width * height * 4 bytes).
// Matrix m[6] = {a, b, c, d, e, f} maps MuPDF page space (origin 0,0) -> canvas pixels.
// Returns: 0 = OK, 1 = Aborted via cookie, -1 = Error (err_buf populated).
int zot_render_display_list(
    fz_context *ctx,
    fz_display_list *dl,
    ZotRect bounds,
    const float m[6],
    int width,
    int height,
    int aa_level,
    const ZotTheme *theme,
    fz_cookie *cookie,
    unsigned char *out_rgba,
    char *err_buf,
    int err_cap
);

// Thread-safe abort trigger on an in-flight fz_cookie.
void zot_cookie_abort(fz_cookie *cookie);

// Shrink (or empty when percent == 0) MuPDF's internal decoded object store.
void zot_shrink_store(fz_context *ctx, unsigned int percent);

const char *zot_mupdf_version(void);

#endif
