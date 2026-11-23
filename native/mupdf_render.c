#include "mupdf_render.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>

typedef SRWLOCK zot_mutex_t;
static SRWLOCK g_freetype_lock = SRWLOCK_INIT;

static void zot_mutex_init(zot_mutex_t *m) { InitializeSRWLock(m); }
static void zot_mutex_destroy(zot_mutex_t *m) { (void)m; }
static void zot_mutex_lock(zot_mutex_t *m) { AcquireSRWLockExclusive(m); }
static void zot_mutex_unlock(zot_mutex_t *m) { ReleaseSRWLockExclusive(m); }
#else
#include <pthread.h>

typedef pthread_mutex_t zot_mutex_t;
static pthread_mutex_t g_freetype_lock = PTHREAD_MUTEX_INITIALIZER;

static void zot_mutex_init(zot_mutex_t *m) { pthread_mutex_init(m, NULL); }
static void zot_mutex_destroy(zot_mutex_t *m) { pthread_mutex_destroy(m); }
static void zot_mutex_lock(zot_mutex_t *m) { pthread_mutex_lock(m); }
static void zot_mutex_unlock(zot_mutex_t *m) { pthread_mutex_unlock(m); }
#endif

static void lock_cb(void *user, int lock) {
    if (lock == FZ_LOCK_FREETYPE) {
        zot_mutex_lock(&g_freetype_lock);
    } else {
        zot_mutex_lock(&((zot_mutex_t *)user)[lock]);
    }
}

static void unlock_cb(void *user, int lock) {
    if (lock == FZ_LOCK_FREETYPE) {
        zot_mutex_unlock(&g_freetype_lock);
    } else {
        zot_mutex_unlock(&((zot_mutex_t *)user)[lock]);
    }
}

static void silent_warning_cb(void *user, const char *message) {
    (void)user;
    (void)message;
}

static void copy_err(char *buf, int cap, const char *msg) {
    if (!buf || cap <= 0) return;
    if (!msg) msg = "unknown mupdf error";
    snprintf(buf, (size_t)cap, "%s", msg);
}

const char *zot_mupdf_version(void) {
    return FZ_VERSION;
}

fz_context *zot_new_base_context(size_t max_store, void **locks_out) {
    zot_mutex_t *locks = (zot_mutex_t *)calloc(FZ_LOCK_MAX, sizeof(zot_mutex_t));
    if (!locks) return NULL;
    for (int i = 0; i < FZ_LOCK_MAX; i++) {
        zot_mutex_init(&locks[i]);
    }
    fz_locks_context lctx = { locks, lock_cb, unlock_cb };
    fz_context *ctx = fz_new_context(NULL, &lctx, max_store);
    if (!ctx) {
        for (int i = 0; i < FZ_LOCK_MAX; i++) zot_mutex_destroy(&locks[i]);
        free(locks);
        return NULL;
    }
    fz_set_warning_callback(ctx, silent_warning_cb, NULL);
    fz_try(ctx) {
        fz_register_document_handlers(ctx);
    }
    fz_catch(ctx) {
        fz_drop_context(ctx);
        for (int i = 0; i < FZ_LOCK_MAX; i++) zot_mutex_destroy(&locks[i]);
        free(locks);
        return NULL;
    }
    *locks_out = locks;
    return ctx;
}

void zot_drop_base_context(fz_context *ctx, void *locks) {
    if (ctx) fz_drop_context(ctx);
    if (locks) {
        zot_mutex_t *arr = (zot_mutex_t *)locks;
        for (int i = 0; i < FZ_LOCK_MAX; i++) zot_mutex_destroy(&arr[i]);
        free(arr);
    }
}

fz_context *zot_clone_context(fz_context *base) {
    fz_context *c = fz_clone_context(base);
    if (c) {
        fz_set_warning_callback(c, silent_warning_cb, NULL);
    }
    return c;
}

void zot_drop_cloned_context(fz_context *ctx) {
    if (ctx) fz_drop_context(ctx);
}

fz_document *zot_open_document(
    fz_context *ctx,
    const char *path,
    const char *password,
    int *out_page_count,
    char *err_buf,
    int err_cap
) {
    fz_document *doc = NULL;
    fz_try(ctx) {
        doc = fz_open_document(ctx, path);
        if (fz_needs_password(ctx, doc)) {
            const char *pw = password ? password : "";
            if (!fz_authenticate_password(ctx, doc, pw)) {
                fz_drop_document(ctx, doc);
                doc = NULL;
                fz_throw(ctx, FZ_ERROR_GENERIC, "password authentication failed");
            }
        }
        if (out_page_count) {
            *out_page_count = fz_count_pages(ctx, doc);
        }
    }
    fz_catch(ctx) {
        copy_err(err_buf, err_cap, fz_caught_message(ctx));
        if (doc) {
            fz_drop_document(ctx, doc);
            doc = NULL;
        }
    }
    return doc;
}

void zot_drop_document(fz_context *ctx, fz_document *doc) {
    if (ctx && doc) {
        fz_drop_document(ctx, doc);
    }
}

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
) {
    if (out_aborted) *out_aborted = 0;
    if (cookie && cookie->abort) {
        if (out_aborted) *out_aborted = 1;
        return NULL;
    }

    fz_page *page = NULL;
    fz_display_list *dl = NULL;
    fz_device *dev = NULL;

    fz_var(page);
    fz_var(dl);
    fz_var(dev);

    fz_try(ctx) {
        page = fz_load_page(ctx, doc, page_index);
        fz_rect bounds = fz_bound_page(ctx, page);
        if (out_bounds) {
            out_bounds->x0 = bounds.x0;
            out_bounds->y0 = bounds.y0;
            out_bounds->x1 = bounds.x1;
            out_bounds->y1 = bounds.y1;
        }
        dl = fz_new_display_list(ctx, bounds);
        dev = fz_new_list_device(ctx, dl);
        if (include_annots) {
            fz_run_page(ctx, page, dev, fz_identity, cookie);
        } else {
            fz_run_page_contents(ctx, page, dev, fz_identity, cookie);
        }
        fz_close_device(ctx, dev);
        if (cookie && cookie->abort) {
            fz_drop_display_list(ctx, dl);
            dl = NULL;
            if (out_aborted) *out_aborted = 1;
        }
    }
    fz_always(ctx) {
        fz_drop_device(ctx, dev);
        fz_drop_page(ctx, page);
    }
    fz_catch(ctx) {
        if (cookie && cookie->abort) {
            if (out_aborted) *out_aborted = 1;
        } else {
            copy_err(err_buf, err_cap, fz_caught_message(ctx));
        }
        fz_drop_display_list(ctx, dl);
        return NULL;
    }
    return dl;
}

fz_display_list *zot_build_display_list(
    fz_context *ctx,
    fz_document *doc,
    int page_index,
    int include_annots,
    ZotRect *out_bounds,
    char *err_buf,
    int err_cap
) {
    return zot_build_display_list_ex(ctx, doc, page_index, include_annots, NULL, out_bounds, NULL, err_buf, err_cap);
}

void zot_drop_display_list(fz_context *ctx, fz_display_list *dl) {
    if (ctx && dl) {
        fz_drop_display_list(ctx, dl);
    }
}

/* ============================================================================
 * Zotero Theme Color Remapping (Light/Sepia/Dark themes, preserving chroma)
 * Maps white paper (L=1) -> theme.bg and black ink (L=0) -> theme.fg,
 * while keeping colored text, equations, and plots visually distinct and legible.
 * ============================================================================ */

static inline float clamp01(float v) {
    return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
}

static inline void remap_rgb_float(
    float r, float g, float b,
    float bg_r, float bg_g, float bg_b,
    float fg_r, float fg_g, float fg_b,
    int is_dark,
    float *out_r, float *out_g, float *out_b
) {
    float maxc = r > g ? (r > b ? r : b) : (g > b ? g : b);
    float minc = r < g ? (r < b ? r : b) : (g < b ? g : b);
    float lum = 0.2126f * r + 0.7152f * g + 0.0722f * b;
    float sat = maxc - minc;

    // Neutral gray/black/white: smooth linear ramp between fg (at lum=0) and bg (at lum=1)
    float base_r = fg_r + lum * (bg_r - fg_r);
    float base_g = fg_g + lum * (bg_g - fg_g);
    float base_b = fg_b + lum * (bg_b - fg_b);

    if (sat < 0.02f) {
        *out_r = clamp01(base_r);
        *out_g = clamp01(base_g);
        *out_b = clamp01(base_b);
        return;
    }

    // Preserve chromatic deviation around luminance so colored lines/plots stay recognizable
    float dr = r - lum;
    float dg = g - lum;
    float db = b - lum;

    // In dark mode, mildly boost chroma visibility on dark backgrounds without clipping harshly
    float chroma_scale = is_dark ? 0.92f : 0.95f;
    *out_r = clamp01(base_r + dr * chroma_scale);
    *out_g = clamp01(base_g + dg * chroma_scale);
    *out_b = clamp01(base_b + db * chroma_scale);
}

/* Custom MuPDF filter device for invert_images == 0 (remaps text/vectors, keeps raster images intact) */
typedef struct {
    fz_device super;
    fz_device *inner;
    float bg[3];
    float fg[3];
    int is_dark;
} theme_filter_device;

static void map_fz_color(
    fz_context *ctx,
    theme_filter_device *tdev,
    fz_colorspace *cs,
    const float *color,
    fz_color_params color_params,
    float out_rgb[3]
) {
    float rgb[3] = { 0.0f, 0.0f, 0.0f };
    if (cs && color) {
        fz_convert_color(ctx, cs, color, fz_device_rgb(ctx), rgb, NULL, color_params);
    }
    remap_rgb_float(
        rgb[0], rgb[1], rgb[2],
        tdev->bg[0], tdev->bg[1], tdev->bg[2],
        tdev->fg[0], tdev->fg[1], tdev->fg[2],
        tdev->is_dark,
        &out_rgb[0], &out_rgb[1], &out_rgb[2]
    );
}

static void tf_close_device(fz_context *ctx, fz_device *dev) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_close_device(ctx, t->inner);
}

static void tf_drop_device(fz_context *ctx, fz_device *dev) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_drop_device(ctx, t->inner);
}

static void tf_fill_path(fz_context *ctx, fz_device *dev, const fz_path *path, int even_odd, fz_matrix ctm, fz_colorspace *cs, const float *color, float alpha, fz_color_params cp) {
    theme_filter_device *t = (theme_filter_device *)dev;
    float mapped[3];
    map_fz_color(ctx, t, cs, color, cp, mapped);
    fz_fill_path(ctx, t->inner, path, even_odd, ctm, fz_device_rgb(ctx), mapped, alpha, cp);
}

static void tf_stroke_path(fz_context *ctx, fz_device *dev, const fz_path *path, const fz_stroke_state *stroke, fz_matrix ctm, fz_colorspace *cs, const float *color, float alpha, fz_color_params cp) {
    theme_filter_device *t = (theme_filter_device *)dev;
    float mapped[3];
    map_fz_color(ctx, t, cs, color, cp, mapped);
    fz_stroke_path(ctx, t->inner, path, stroke, ctm, fz_device_rgb(ctx), mapped, alpha, cp);
}

static void tf_clip_path(fz_context *ctx, fz_device *dev, const fz_path *path, int even_odd, fz_matrix ctm, fz_rect scissor) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_clip_path(ctx, t->inner, path, even_odd, ctm, scissor);
}

static void tf_clip_stroke_path(fz_context *ctx, fz_device *dev, const fz_path *path, const fz_stroke_state *stroke, fz_matrix ctm, fz_rect scissor) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_clip_stroke_path(ctx, t->inner, path, stroke, ctm, scissor);
}

static void tf_fill_text(fz_context *ctx, fz_device *dev, const fz_text *text, fz_matrix ctm, fz_colorspace *cs, const float *color, float alpha, fz_color_params cp) {
    theme_filter_device *t = (theme_filter_device *)dev;
    float mapped[3];
    map_fz_color(ctx, t, cs, color, cp, mapped);
    fz_fill_text(ctx, t->inner, text, ctm, fz_device_rgb(ctx), mapped, alpha, cp);
}

static void tf_stroke_text(fz_context *ctx, fz_device *dev, const fz_text *text, const fz_stroke_state *stroke, fz_matrix ctm, fz_colorspace *cs, const float *color, float alpha, fz_color_params cp) {
    theme_filter_device *t = (theme_filter_device *)dev;
    float mapped[3];
    map_fz_color(ctx, t, cs, color, cp, mapped);
    fz_stroke_text(ctx, t->inner, text, stroke, ctm, fz_device_rgb(ctx), mapped, alpha, cp);
}

static void tf_clip_text(fz_context *ctx, fz_device *dev, const fz_text *text, fz_matrix ctm, fz_rect scissor) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_clip_text(ctx, t->inner, text, ctm, scissor);
}

static void tf_clip_stroke_text(fz_context *ctx, fz_device *dev, const fz_text *text, const fz_stroke_state *stroke, fz_matrix ctm, fz_rect scissor) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_clip_stroke_text(ctx, t->inner, text, stroke, ctm, scissor);
}

static void tf_ignore_text(fz_context *ctx, fz_device *dev, const fz_text *text, fz_matrix ctm) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_ignore_text(ctx, t->inner, text, ctm);
}

static void tf_fill_shade(fz_context *ctx, fz_device *dev, fz_shade *shd, fz_matrix ctm, float alpha, fz_color_params cp) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_fill_shade(ctx, t->inner, shd, ctm, alpha, cp);
}

static void tf_fill_image(fz_context *ctx, fz_device *dev, fz_image *img, fz_matrix ctm, float alpha, fz_color_params cp) {
    theme_filter_device *t = (theme_filter_device *)dev;
    // Keep embedded photos/figures un-inverted when invert_images == 0
    fz_fill_image(ctx, t->inner, img, ctm, alpha, cp);
}

static void tf_fill_image_mask(fz_context *ctx, fz_device *dev, fz_image *img, fz_matrix ctm, fz_colorspace *cs, const float *color, float alpha, fz_color_params cp) {
    theme_filter_device *t = (theme_filter_device *)dev;
    float mapped[3];
    map_fz_color(ctx, t, cs, color, cp, mapped);
    fz_fill_image_mask(ctx, t->inner, img, ctm, fz_device_rgb(ctx), mapped, alpha, cp);
}

static void tf_clip_image_mask(fz_context *ctx, fz_device *dev, fz_image *img, fz_matrix ctm, fz_rect scissor) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_clip_image_mask(ctx, t->inner, img, ctm, scissor);
}

static void tf_pop_clip(fz_context *ctx, fz_device *dev) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_pop_clip(ctx, t->inner);
}

static void tf_begin_mask(fz_context *ctx, fz_device *dev, fz_rect area, int luminosity, fz_colorspace *cs, const float *bc, fz_color_params cp) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_begin_mask(ctx, t->inner, area, luminosity, cs, bc, cp);
}

static void tf_end_mask(fz_context *ctx, fz_device *dev, fz_function *fn) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_end_mask_tr(ctx, t->inner, fn);
}

static void tf_begin_group(fz_context *ctx, fz_device *dev, fz_rect area, fz_colorspace *cs, int isolated, int knockout, int blendmode, float alpha) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_begin_group(ctx, t->inner, area, cs, isolated, knockout, blendmode, alpha);
}

static void tf_end_group(fz_context *ctx, fz_device *dev) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_end_group(ctx, t->inner);
}

static int tf_begin_tile(fz_context *ctx, fz_device *dev, fz_rect area, fz_rect view, float xstep, float ystep, fz_matrix ctm, int id, int doc_id) {
    theme_filter_device *t = (theme_filter_device *)dev;
    return fz_begin_tile_tid(ctx, t->inner, area, view, xstep, ystep, ctm, id, doc_id);
}

static void tf_end_tile(fz_context *ctx, fz_device *dev) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_end_tile(ctx, t->inner);
}

static void tf_render_flags(fz_context *ctx, fz_device *dev, int set, int clear) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_render_flags(ctx, t->inner, set, clear);
}

static void tf_set_default_colorspaces(fz_context *ctx, fz_device *dev, fz_default_colorspaces *dcs) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_set_default_colorspaces(ctx, t->inner, dcs);
}

static void tf_begin_layer(fz_context *ctx, fz_device *dev, const char *name) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_begin_layer(ctx, t->inner, name);
}

static void tf_end_layer(fz_context *ctx, fz_device *dev) {
    theme_filter_device *t = (theme_filter_device *)dev;
    fz_end_layer(ctx, t->inner);
}

static fz_device *new_theme_filter_device(fz_context *ctx, fz_device *inner, const ZotTheme *theme) {
    theme_filter_device *dev = (theme_filter_device *)fz_new_device_of_size(ctx, sizeof(theme_filter_device));
    dev->inner = fz_keep_device(ctx, inner);
    for (int i = 0; i < 3; i++) {
        dev->bg[i] = theme->bg[i] / 255.0f;
        dev->fg[i] = theme->fg[i] / 255.0f;
    }
    float bg_lum = 0.2126f * dev->bg[0] + 0.7152f * dev->bg[1] + 0.0722f * dev->bg[2];
    float fg_lum = 0.2126f * dev->fg[0] + 0.7152f * dev->fg[1] + 0.0722f * dev->fg[2];
    dev->is_dark = bg_lum < fg_lum ? 1 : 0;

    dev->super.close_device = tf_close_device;
    dev->super.drop_device = tf_drop_device;
    dev->super.fill_path = tf_fill_path;
    dev->super.stroke_path = tf_stroke_path;
    dev->super.clip_path = tf_clip_path;
    dev->super.clip_stroke_path = tf_clip_stroke_path;
    dev->super.fill_text = tf_fill_text;
    dev->super.stroke_text = tf_stroke_text;
    dev->super.clip_text = tf_clip_text;
    dev->super.clip_stroke_text = tf_clip_stroke_text;
    dev->super.ignore_text = tf_ignore_text;
    dev->super.fill_shade = tf_fill_shade;
    dev->super.fill_image = tf_fill_image;
    dev->super.fill_image_mask = tf_fill_image_mask;
    dev->super.clip_image_mask = tf_clip_image_mask;
    dev->super.pop_clip = tf_pop_clip;
    dev->super.begin_mask = tf_begin_mask;
    dev->super.end_mask = tf_end_mask;
    dev->super.begin_group = tf_begin_group;
    dev->super.end_group = tf_end_group;
    dev->super.begin_tile = tf_begin_tile;
    dev->super.end_tile = tf_end_tile;
    dev->super.render_flags = tf_render_flags;
    dev->super.set_default_colorspaces = tf_set_default_colorspaces;
    dev->super.begin_layer = tf_begin_layer;
    dev->super.end_layer = tf_end_layer;
    return (fz_device *)dev;
}

static void apply_pixel_theme(unsigned char *rgba, size_t npixels, const ZotTheme *theme) {
    const float inv255 = 1.0f / 255.0f;
    float bg_r = theme->bg[0] * inv255;
    float bg_g = theme->bg[1] * inv255;
    float bg_b = theme->bg[2] * inv255;
    float fg_r = theme->fg[0] * inv255;
    float fg_g = theme->fg[1] * inv255;
    float fg_b = theme->fg[2] * inv255;
    float bg_lum = 0.2126f * bg_r + 0.7152f * bg_g + 0.0722f * bg_b;
    float fg_lum = 0.2126f * fg_r + 0.7152f * fg_g + 0.0722f * fg_b;
    int is_dark = bg_lum < fg_lum ? 1 : 0;
    float span_r = bg_r - fg_r;
    float span_g = bg_g - fg_g;
    float span_b = bg_b - fg_b;
    float chroma_scale = is_dark ? 0.92f : 0.95f;

    // 256-entry L1-resident RGBA LUT for neutral/grayscale pixels (95%+ of PDF pages: paper, text, AA edges!)
    uint32_t gray_lut[256];
    for (int g = 0; g < 256; g++) {
        float lum = g * inv255;
        uint32_t or_ = (uint32_t)(clamp01(fg_r + lum * span_r) * 255.0f + 0.5f);
        uint32_t og_ = (uint32_t)(clamp01(fg_g + lum * span_g) * 255.0f + 0.5f);
        uint32_t ob_ = (uint32_t)(clamp01(fg_b + lum * span_b) * 255.0f + 0.5f);
        gray_lut[g] = or_ | (og_ << 8) | (ob_ << 16) | 0xFF000000u;
    }

    uint32_t *px32 = (uint32_t *)rgba;
    for (size_t i = 0; i < npixels; i++) {
        uint32_t v = px32[i];
        unsigned r = v & 0xFFu;
        unsigned g = (v >> 8) & 0xFFu;
        unsigned b = (v >> 16) & 0xFFu;

        // Ultra-fast exact gray path: single L1 table lookup, zero float ops!
        if (r == g && g == b) {
            px32[i] = gray_lut[r];
            continue;
        }

        unsigned maxc = r > g ? (r > b ? r : b) : (g > b ? g : b);
        unsigned minc = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (maxc - minc <= 5u) {
            // Matches remap_rgb_float sat < 0.02f threshold using integer BT.709 luminance
            unsigned lum8 = (54u * r + 183u * g + 19u * b + 128u) >> 8;
            if (lum8 > 255u) lum8 = 255u;
            px32[i] = gray_lut[lum8];
            continue;
        }

        float rf = r * inv255;
        float gf = g * inv255;
        float bf = b * inv255;
        float lum = 0.2126f * rf + 0.7152f * gf + 0.0722f * bf;
        float base_r = fg_r + lum * span_r;
        float base_g = fg_g + lum * span_g;
        float base_b = fg_b + lum * span_b;
        uint32_t or_ = (uint32_t)(clamp01(base_r + (rf - lum) * chroma_scale) * 255.0f + 0.5f);
        uint32_t og_ = (uint32_t)(clamp01(base_g + (gf - lum) * chroma_scale) * 255.0f + 0.5f);
        uint32_t ob_ = (uint32_t)(clamp01(base_b + (bf - lum) * chroma_scale) * 255.0f + 0.5f);
        px32[i] = or_ | (og_ << 8) | (ob_ << 16) | 0xFF000000u;
    }
}

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
) {
    if (width <= 0 || height <= 0 || !dl || !out_rgba) {
        copy_err(err_buf, err_cap, "invalid render dimensions or arguments");
        return -1;
    }

    fz_pixmap *pix = NULL;
    fz_device *draw_dev = NULL;
    fz_device *run_dev = NULL;
    int status = 0;

    fz_var(pix);
    fz_var(draw_dev);
    fz_var(run_dev);
    fz_var(status);

    fz_try(ctx) {
        if (aa_level >= 0 && aa_level <= 8) {
            fz_set_aa_level(ctx, aa_level);
        }

        fz_irect bbox = { 0, 0, width, height };
        // Rasterize directly into caller's RGBA ArrayBuffer (zero extra 30MB malloc + zero memcpy!).
        // fz_new_pixmap_with_bbox_and_data does NOT free out_rgba when fz_drop_pixmap runs.
        pix = fz_new_pixmap_with_bbox_and_data(ctx, fz_device_rgb(ctx), bbox, NULL, 1, out_rgba);

        int use_device_theme = theme && theme->enabled && !theme->invert_images;
        int use_pixel_theme = theme && theme->enabled && theme->invert_images;

        if (use_device_theme) {
            uint32_t *dst32 = (uint32_t *)pix->samples;
            size_t total = (size_t)width * (size_t)height;
            // Little-endian RGBA pixel word (R, G, B, 255)
            uint32_t px = (uint32_t)theme->bg[0] |
                          ((uint32_t)theme->bg[1] << 8) |
                          ((uint32_t)theme->bg[2] << 16) |
                          (0xFFu << 24);
            for (size_t i = 0; i < total; i++) {
                dst32[i] = px;
            }
        } else {
            fz_clear_pixmap_with_value(ctx, pix, 255);
        }

        fz_matrix req = { m[0], m[1], m[2], m[3], m[4], m[5] };
        fz_matrix ctm = (bounds.x0 != 0.0f || bounds.y0 != 0.0f)
            ? fz_concat(fz_translate(-bounds.x0, -bounds.y0), req)
            : req;

        draw_dev = fz_new_draw_device(ctx, fz_identity, pix);
        if (use_device_theme) {
            run_dev = new_theme_filter_device(ctx, draw_dev, theme);
        } else {
            run_dev = fz_keep_device(ctx, draw_dev);
        }

        fz_rect scissor = fz_rect_from_irect(bbox);
        fz_run_display_list(ctx, dl, run_dev, ctm, scissor, cookie);
        fz_close_device(ctx, run_dev);

        if (cookie && cookie->abort) {
            status = 1;
        } else if (use_pixel_theme) {
            apply_pixel_theme(out_rgba, (size_t)width * (size_t)height, theme);
        }
    }
    fz_always(ctx) {
        fz_drop_device(ctx, run_dev);
        fz_drop_device(ctx, draw_dev);
        fz_drop_pixmap(ctx, pix);
    }
    fz_catch(ctx) {
        if (cookie && cookie->abort) {
            status = 1;
        } else {
            copy_err(err_buf, err_cap, fz_caught_message(ctx));
            status = -1;
        }
    }
    return status;
}

void zot_cookie_abort(fz_cookie *cookie) {
    if (cookie) {
        cookie->abort = 1;
    }
}

void zot_shrink_store(fz_context *ctx, unsigned int percent) {
    if (!ctx) return;
    if (percent == 0) {
        fz_empty_store(ctx);
    } else {
        fz_shrink_store(ctx, percent);
    }
}
