#include "zot_dll.h"
#include "mupdf_render.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <process.h>
#include <windows.h>

typedef SRWLOCK zot_rwlock_t;
#define ZOT_RWLOCK_INIT SRWLOCK_INIT
static inline void zot_rwlock_init(zot_rwlock_t *l) { InitializeSRWLock(l); }
static inline void zot_rwlock_destroy(zot_rwlock_t *l) { (void)l; }
static inline void zot_rwlock_rdlock(zot_rwlock_t *l) { AcquireSRWLockShared(l); }
static inline void zot_rwlock_rdunlock(zot_rwlock_t *l) { ReleaseSRWLockShared(l); }
static inline void zot_rwlock_wrlock(zot_rwlock_t *l) { AcquireSRWLockExclusive(l); }
static inline void zot_rwlock_wrunlock(zot_rwlock_t *l) { ReleaseSRWLockExclusive(l); }

typedef CRITICAL_SECTION zot_mutex_t;
typedef CONDITION_VARIABLE zot_cond_t;
static inline void zot_mutex_init(zot_mutex_t *m) { InitializeCriticalSection(m); }
static inline void zot_mutex_destroy(zot_mutex_t *m) { DeleteCriticalSection(m); }
static inline void zot_mutex_lock(zot_mutex_t *m) { EnterCriticalSection(m); }
static inline void zot_mutex_unlock(zot_mutex_t *m) { LeaveCriticalSection(m); }
static inline void zot_cond_init(zot_cond_t *c) { InitializeConditionVariable(c); }
static inline void zot_cond_destroy(zot_cond_t *c) { (void)c; }
static inline void zot_cond_broadcast(zot_cond_t *c) { WakeAllConditionVariable(c); }
/* Returns 1 if signaled/spurious, 0 if timed out. timeout_ms < 0 waits infinitely. */
static inline int zot_cond_wait_ms(zot_cond_t *c, zot_mutex_t *m, int timeout_ms) {
    DWORD ms = timeout_ms < 0 ? INFINITE : (DWORD)timeout_ms;
    BOOL ok = SleepConditionVariableCS(c, m, ms);
    if (!ok && GetLastError() == ERROR_TIMEOUT) return 0;
    return 1;
}

typedef volatile LONG64 zot_atomic64_t;
typedef volatile LONG zot_atomic32_t;
static inline int64_t zot_atomic64_load(zot_atomic64_t *p) { return (int64_t)InterlockedCompareExchange64(p, 0, 0); }
static inline int64_t zot_atomic64_inc(zot_atomic64_t *p) { return (int64_t)InterlockedIncrement64(p); }
static inline int32_t zot_atomic32_load(zot_atomic32_t *p) { return (int32_t)InterlockedCompareExchange(p, 0, 0); }
static inline int32_t zot_atomic32_inc(zot_atomic32_t *p) { return (int32_t)InterlockedIncrement(p); }
static inline int32_t zot_atomic32_dec(zot_atomic32_t *p) { return (int32_t)InterlockedDecrement(p); }

typedef HANDLE zot_thread_t;
#define ZOT_THREAD_RET unsigned __stdcall
#define ZOT_THREAD_RETURN return 0
static inline void zot_set_bg_priority(void) { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST); }
static inline void zot_thread_yield(void) { SwitchToThread(); }
#else
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef pthread_rwlock_t zot_rwlock_t;
#define ZOT_RWLOCK_INIT PTHREAD_RWLOCK_INITIALIZER
static inline void zot_rwlock_init(zot_rwlock_t *l) { pthread_rwlock_init(l, NULL); }
static inline void zot_rwlock_destroy(zot_rwlock_t *l) { pthread_rwlock_destroy(l); }
static inline void zot_rwlock_rdlock(zot_rwlock_t *l) { pthread_rwlock_rdlock(l); }
static inline void zot_rwlock_rdunlock(zot_rwlock_t *l) { pthread_rwlock_unlock(l); }
static inline void zot_rwlock_wrlock(zot_rwlock_t *l) { pthread_rwlock_wrlock(l); }
static inline void zot_rwlock_wrunlock(zot_rwlock_t *l) { pthread_rwlock_unlock(l); }

typedef pthread_mutex_t zot_mutex_t;
typedef pthread_cond_t zot_cond_t;
static inline void zot_mutex_init(zot_mutex_t *m) { pthread_mutex_init(m, NULL); }
static inline void zot_mutex_destroy(zot_mutex_t *m) { pthread_mutex_destroy(m); }
static inline void zot_mutex_lock(zot_mutex_t *m) { pthread_mutex_lock(m); }
static inline void zot_mutex_unlock(zot_mutex_t *m) { pthread_mutex_unlock(m); }
static inline void zot_cond_init(zot_cond_t *c) { pthread_cond_init(c, NULL); }
static inline void zot_cond_destroy(zot_cond_t *c) { pthread_cond_destroy(c); }
static inline void zot_cond_broadcast(zot_cond_t *c) { pthread_cond_broadcast(c); }
static inline int zot_cond_wait_ms(zot_cond_t *c, zot_mutex_t *m, int timeout_ms) {
    if (timeout_ms < 0) {
        pthread_cond_wait(c, m);
        return 1;
    }
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += timeout_ms / 1000;
    ts.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;
    if (ts.tv_nsec >= 1000000000L) {
        ts.tv_sec += 1;
        ts.tv_nsec -= 1000000000L;
    }
    int rc = pthread_cond_timedwait(c, m, &ts);
    return (rc == ETIMEDOUT) ? 0 : 1;
}

typedef volatile int64_t zot_atomic64_t;
typedef volatile int32_t zot_atomic32_t;
static inline int64_t zot_atomic64_load(zot_atomic64_t *p) { return __atomic_load_n(p, __ATOMIC_SEQ_CST); }
static inline int64_t zot_atomic64_inc(zot_atomic64_t *p) { return __atomic_add_fetch(p, 1, __ATOMIC_SEQ_CST); }
static inline int32_t zot_atomic32_load(zot_atomic32_t *p) { return __atomic_load_n(p, __ATOMIC_SEQ_CST); }
static inline int32_t zot_atomic32_inc(zot_atomic32_t *p) { return __atomic_add_fetch(p, 1, __ATOMIC_SEQ_CST); }
static inline int32_t zot_atomic32_dec(zot_atomic32_t *p) { return __atomic_sub_fetch(p, 1, __ATOMIC_SEQ_CST); }

typedef pthread_t zot_thread_t;
#define ZOT_THREAD_RET void *
#define ZOT_THREAD_RETURN return NULL
static inline void zot_set_bg_priority(void) {
#if defined(__APPLE__)
    pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
#endif
}
static inline void zot_thread_yield(void) { sched_yield(); }
#endif

#define MAX_WORKER_DOCS 2
#define MAX_DLS 24
#define MAX_ACTIVE_COOKIES 64
#define BG_QUEUE_CAP 16
#define MAX_PIX_RECYCLE 1

/* Thread-local open document cache: each foreground ChromeWorker and each bg_worker
 * owns its own fz_document* handles -> ZERO cross-thread doc_lock, ZERO priority inversion,
 * and true multi-core parallel display-list building on the same PDF! */
typedef struct {
    char *path;
    char *password;
    int64_t mtime;
    int64_t fsize;
    fz_document *doc;
    int page_count;
    uint64_t last_used;
} WorkerDocSlot;

typedef struct {
    WorkerDocSlot slots[MAX_WORKER_DOCS];
    int count;
    uint64_t clock;
    int64_t last_evict_gen;
} WorkerDocCache;

typedef struct {
    char *path;
    char *password;
    int64_t mtime;
    int64_t fsize;
    int page_index;
    int include_annots;
    int page_count;
    fz_display_list *dl;
    ZotRect bounds;
    int refs;
    uint64_t last_used;
    int in_cache;
} DLEntry;

typedef struct PixKey {
    char *path;
    int64_t mtime;
    int64_t fsize;
    char *password;
    int page_index;
    int width;
    int height;
    int32_t qm[6];
    int include_annots;
    int aa_level;
    ZotTheme theme;
} PixKey;

typedef struct PixEntry {
    PixKey key;
    unsigned char *rgba;
    size_t byte_len;
    float page_w;
    float page_h;
    int page_count;
    uint64_t last_used;
    struct PixEntry *prev;
    struct PixEntry *next;
} PixEntry;

typedef struct {
    unsigned char *ptr;
    size_t byte_len;
} PixRecycledBuf;

typedef struct {
    int req_id;
    fz_cookie *cookie;
} ActiveCookie;

typedef struct {
    char *path;
    char *password;
    int page_index;
    int width;
    int height;
    float src_pw;
    float src_ph;
    float m[6];
    int include_annots;
    int aa_level;
    ZotTheme theme;
} BgJob;

typedef struct {
    fz_context *base_ctx;
    void *base_locks;

    zot_rwlock_t cache_lock;
    uint64_t clock;
    DLEntry *dls[MAX_DLS];
    int dl_count;

    zot_atomic64_t evict_gen;
    zot_atomic32_t fg_active;

    zot_rwlock_t pix_lock;
    PixEntry *pix_head; // MRU
    PixEntry *pix_tail; // LRU
    size_t pix_bytes;
    size_t max_pix_bytes;
    PixRecycledBuf pix_recycle[MAX_PIX_RECYCLE];
    int pix_recycle_count;

    zot_rwlock_t cookie_lock;
    ActiveCookie cookies[MAX_ACTIVE_COOKIES];

    zot_mutex_t bg_cs;
    zot_cond_t bg_cv;
    BgJob bg_queue[BG_QUEUE_CAP]; // index 0..bg_count-1; index 0 is highest priority!
    int bg_count;
    int bg_stop;
    char *last_fg_path;
    int last_fg_page;
    int last_fg_dir; // +1 = scrolling down, -1 = scrolling up
    zot_thread_t *bg_threads;
    int bg_thread_count;
} ZotEngine;

typedef struct {
    fz_context *ctx;
    WorkerDocCache doc_cache;
} ZotWorker;

static zot_rwlock_t g_singleton_lock = ZOT_RWLOCK_INIT;
static ZotEngine *g_engine = NULL;
static int g_engine_refs = 0;

static double now_ms(void) {
#ifdef _WIN32
    static LARGE_INTEGER freq = {0};
    if (freq.QuadPart == 0) {
        QueryPerformanceFrequency(&freq);
    }
    LARGE_INTEGER cnt;
    QueryPerformanceCounter(&cnt);
    return (double)cnt.QuadPart * 1000.0 / (double)freq.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
#endif
}

static char *dup_str(const char *s) {
    if (!s) s = "";
    size_t n = strlen(s);
    char *out = (char *)malloc(n + 1);
    if (out) memcpy(out, s, n + 1);
    return out;
}

static int stat_utf8(const char *path_utf8, int64_t *out_mtime, int64_t *out_size) {
#ifdef _WIN32
    int wlen = MultiByteToWideChar(CP_UTF8, 0, path_utf8, -1, NULL, 0);
    if (wlen <= 0) return -1;
    wchar_t *wpath = (wchar_t *)malloc((size_t)wlen * sizeof(wchar_t));
    if (!wpath) return -1;
    MultiByteToWideChar(CP_UTF8, 0, path_utf8, -1, wpath, wlen);

    WIN32_FILE_ATTRIBUTE_DATA fad;
    BOOL ok = GetFileAttributesExW(wpath, GetFileExInfoStandard, &fad);
    free(wpath);
    if (!ok) return -1;

    ULARGE_INTEGER sz, mt;
    sz.LowPart = fad.nFileSizeLow;
    sz.HighPart = fad.nFileSizeHigh;
    mt.LowPart = fad.ftLastWriteTime.dwLowDateTime;
    mt.HighPart = fad.ftLastWriteTime.dwHighDateTime;
    *out_size = (int64_t)sz.QuadPart;
    *out_mtime = (int64_t)mt.QuadPart;
    return 0;
#else
    struct stat st;
    if (stat(path_utf8, &st) != 0) return -1;
    *out_size = (int64_t)st.st_size;
#if defined(__APPLE__)
    *out_mtime = (int64_t)st.st_mtimespec.tv_sec * 1000000000LL + (int64_t)st.st_mtimespec.tv_nsec;
#else
    *out_mtime = (int64_t)st.st_mtim.tv_sec * 1000000000LL + (int64_t)st.st_mtim.tv_nsec;
#endif
    return 0;
#endif
}

static void quantize_m(const float m[6], int32_t qm[6]) {
    for (int i = 0; i < 6; i++) {
        qm[i] = (int32_t)llround((double)m[i] * 1000.0);
    }
}

static int theme_eq(const ZotTheme *a, const ZotTheme *b) {
    if (a->enabled != b->enabled) return 0;
    if (!a->enabled) return 1;
    return a->invert_images == b->invert_images &&
           a->bg[0] == b->bg[0] && a->bg[1] == b->bg[1] && a->bg[2] == b->bg[2] &&
           a->fg[0] == b->fg[0] && a->fg[1] == b->fg[1] && a->fg[2] == b->fg[2];
}

static int pix_key_eq(const PixKey *a, const PixKey *b) {
    return a->page_index == b->page_index &&
           a->width == b->width &&
           a->height == b->height &&
           a->mtime == b->mtime &&
           a->fsize == b->fsize &&
           a->include_annots == b->include_annots &&
           a->aa_level == b->aa_level &&
           memcmp(a->qm, b->qm, sizeof(a->qm)) == 0 &&
           theme_eq(&a->theme, &b->theme) &&
           strcmp(a->path, b->path) == 0 &&
           strcmp(a->password, b->password) == 0;
}

/* ---------------- Thread-local WorkerDocCache ---------------- */

static void worker_doc_cache_clear(fz_context *wctx, WorkerDocCache *dc) {
    for (int i = 0; i < dc->count; i++) {
        if (dc->slots[i].doc) {
            zot_drop_document(wctx, dc->slots[i].doc);
            dc->slots[i].doc = NULL;
        }
        free(dc->slots[i].path);
        free(dc->slots[i].password);
        dc->slots[i].path = NULL;
        dc->slots[i].password = NULL;
    }
    dc->count = 0;
}

static fz_document *worker_doc_get(
    ZotEngine *eng,
    fz_context *wctx,
    WorkerDocCache *dc,
    const char *path,
    const char *password,
    int64_t mtime,
    int64_t fsize,
    int *out_page_count,
    char *err_buf,
    int err_cap
) {
    int64_t cur_gen = zot_atomic64_load(&eng->evict_gen);
    if (dc->last_evict_gen != cur_gen) {
        worker_doc_cache_clear(wctx, dc);
        dc->last_evict_gen = cur_gen;
    }

    for (int i = 0; i < dc->count; i++) {
        WorkerDocSlot *s = &dc->slots[i];
        if (s->mtime == mtime && s->fsize == fsize &&
            strcmp(s->path, path) == 0 && strcmp(s->password, password) == 0) {
            s->last_used = ++dc->clock;
            if (out_page_count) *out_page_count = s->page_count;
            return s->doc;
        }
    }

    int page_count = 0;
    fz_document *doc = zot_open_document(wctx, path, password[0] ? password : NULL, &page_count, err_buf, err_cap);
    if (!doc) return NULL;

    int target = dc->count;
    if (dc->count >= MAX_WORKER_DOCS) {
        int victim = 0;
        for (int i = 1; i < dc->count; i++) {
            if (dc->slots[i].last_used < dc->slots[victim].last_used) {
                victim = i;
            }
        }
        if (dc->slots[victim].doc) {
            zot_drop_document(wctx, dc->slots[victim].doc);
        }
        free(dc->slots[victim].path);
        free(dc->slots[victim].password);
        target = victim;
    } else {
        dc->count++;
    }

    WorkerDocSlot *slot = &dc->slots[target];
    slot->path = dup_str(path);
    slot->password = dup_str(password);
    slot->mtime = mtime;
    slot->fsize = fsize;
    slot->doc = doc;
    slot->page_count = page_count;
    slot->last_used = ++dc->clock;

    if (out_page_count) *out_page_count = page_count;
    return doc;
}

/* ---------------- Rendered RGBA Bitmap LRU Cache + Warm Buffer Recycling ---------------- */

static unsigned char *pix_alloc_buf(ZotEngine *eng, size_t byte_len) {
    unsigned char *reused = NULL;
    zot_rwlock_wrlock(&eng->pix_lock);
    for (int i = eng->pix_recycle_count - 1; i >= 0; i--) {
        if (eng->pix_recycle[i].byte_len == byte_len) {
            reused = eng->pix_recycle[i].ptr;
            eng->pix_recycle[i] = eng->pix_recycle[--eng->pix_recycle_count];
            break;
        }
    }
    zot_rwlock_wrunlock(&eng->pix_lock);
    if (reused) return reused;
    return (unsigned char *)malloc(byte_len);
}

static void pix_recycle_buf_locked(ZotEngine *eng, unsigned char *ptr, size_t byte_len) {
    if (!ptr) return;
    // Keep at most MAX_PIX_RECYCLE (1) buffer matching the latest working size; always drop stale-size buffers!
    if (byte_len >= (1u << 20) && byte_len <= eng->max_pix_bytes / 2) {
        if (eng->pix_recycle_count >= MAX_PIX_RECYCLE) {
            free(eng->pix_recycle[0].ptr);
            eng->pix_recycle[0].ptr = ptr;
            eng->pix_recycle[0].byte_len = byte_len;
            return;
        }
        eng->pix_recycle[eng->pix_recycle_count].ptr = ptr;
        eng->pix_recycle[eng->pix_recycle_count].byte_len = byte_len;
        eng->pix_recycle_count++;
        return;
    }
    free(ptr);
}

static void pix_release_buf(ZotEngine *eng, unsigned char *ptr, size_t byte_len) {
    if (!ptr) return;
    zot_rwlock_wrlock(&eng->pix_lock);
    pix_recycle_buf_locked(eng, ptr, byte_len);
    zot_rwlock_wrunlock(&eng->pix_lock);
}

static void free_pix_entry_meta(PixEntry *e) {
    if (!e) return;
    free(e->key.path);
    free(e->key.password);
    free(e);
}

static void free_pix_entry(PixEntry *e) {
    if (!e) return;
    free(e->rgba);
    free_pix_entry_meta(e);
}

static void pix_unlink(ZotEngine *eng, PixEntry *e) {
    if (e->prev) e->prev->next = e->next;
    else eng->pix_head = e->next;
    if (e->next) e->next->prev = e->prev;
    else eng->pix_tail = e->prev;
    e->prev = e->next = NULL;
}

static void pix_push_front(ZotEngine *eng, PixEntry *e) {
    e->prev = NULL;
    e->next = eng->pix_head;
    if (eng->pix_head) eng->pix_head->prev = e;
    else eng->pix_tail = e;
    eng->pix_head = e;
}

static void pix_push_back(ZotEngine *eng, PixEntry *e) {
    e->next = NULL;
    e->prev = eng->pix_tail;
    if (eng->pix_tail) eng->pix_tail->next = e;
    else eng->pix_head = e;
    eng->pix_tail = e;
}

static int pix_exists(ZotEngine *eng, const PixKey *k) {
    zot_rwlock_rdlock(&eng->pix_lock);
    PixEntry *cur = eng->pix_head;
    while (cur) {
        if (pix_key_eq(&cur->key, k)) {
            zot_rwlock_rdunlock(&eng->pix_lock);
            return 1;
        }
        cur = cur->next;
    }
    zot_rwlock_rdunlock(&eng->pix_lock);
    return 0;
}

static int pix_lookup_copy(
    ZotEngine *eng,
    const PixKey *k,
    unsigned char *out_rgba,
    float *out_pw,
    float *out_ph,
    int *out_page_count
) {
    zot_rwlock_wrlock(&eng->pix_lock);
    PixEntry *cur = eng->pix_head;
    while (cur) {
        if (pix_key_eq(&cur->key, k)) {
            // Once consumed by Zotero's DOM canvas, demote to LRU tail so upcoming unconsumed
            // background pre-renders stay protected at the front while transient redraws still hit!
            if (cur != eng->pix_tail) {
                pix_unlink(eng, cur);
                pix_push_back(eng, cur);
            }
            if (out_rgba) {
                memcpy(out_rgba, cur->rgba, cur->byte_len);
            }
            if (out_pw) *out_pw = cur->page_w;
            if (out_ph) *out_ph = cur->page_h;
            if (out_page_count) *out_page_count = cur->page_count;
            zot_rwlock_wrunlock(&eng->pix_lock);
            return 1;
        }
        cur = cur->next;
    }
    zot_rwlock_wrunlock(&eng->pix_lock);
    return 0;
}

/* Takes ownership of `owned_rgba` (recycles evicted buffers to eliminate Windows VirtualAlloc page-fault storms!) */
static void pix_store_take(
    ZotEngine *eng,
    const PixKey *k,
    unsigned char *owned_rgba,
    size_t byte_len,
    float pw,
    float ph,
    int page_count
) {
    if (!owned_rgba || byte_len == 0 || byte_len > eng->max_pix_bytes / 2) {
        pix_release_buf(eng, owned_rgba, byte_len);
        return;
    }

    zot_rwlock_wrlock(&eng->pix_lock);
    PixEntry *cur = eng->pix_head;
    while (cur) {
        if (pix_key_eq(&cur->key, k)) {
            pix_recycle_buf_locked(eng, cur->rgba, cur->byte_len);
            eng->pix_bytes -= cur->byte_len;
            cur->rgba = owned_rgba;
            cur->byte_len = byte_len;
            cur->page_w = pw;
            cur->page_h = ph;
            cur->page_count = page_count;
            eng->pix_bytes += byte_len;
            if (cur != eng->pix_head) {
                pix_unlink(eng, cur);
                pix_push_front(eng, cur);
            }
            zot_rwlock_wrunlock(&eng->pix_lock);
            return;
        }
        cur = cur->next;
    }

    PixEntry *e = (PixEntry *)calloc(1, sizeof(PixEntry));
    if (!e) {
        pix_recycle_buf_locked(eng, owned_rgba, byte_len);
        zot_rwlock_wrunlock(&eng->pix_lock);
        return;
    }
    e->key = *k;
    e->key.path = dup_str(k->path);
    e->key.password = dup_str(k->password);
    e->rgba = owned_rgba;
    e->byte_len = byte_len;
    e->page_w = pw;
    e->page_h = ph;
    e->page_count = page_count;
    pix_push_front(eng, e);
    eng->pix_bytes += byte_len;

    while (eng->pix_bytes > eng->max_pix_bytes && eng->pix_tail && eng->pix_tail != eng->pix_head) {
        PixEntry *ev = eng->pix_tail;
        pix_unlink(eng, ev);
        eng->pix_bytes -= ev->byte_len;
        pix_recycle_buf_locked(eng, ev->rgba, ev->byte_len);
        ev->rgba = NULL;
        free_pix_entry_meta(ev);
    }
    zot_rwlock_wrunlock(&eng->pix_lock);
}

/* ---------------- Shared Display List LRU Cache (Self-Contained) ---------------- */

static void drop_dl_unlocked(fz_context *ctx, DLEntry *dl) {
    if (!dl) return;
    if (dl->dl) {
        zot_drop_display_list(ctx, dl->dl);
        dl->dl = NULL;
    }
    free(dl->path);
    free(dl->password);
    free(dl);
}

static DLEntry *acquire_dl(
    ZotEngine *eng,
    fz_context *wctx,
    WorkerDocCache *doc_cache,
    const char *path,
    const char *password,
    int64_t mtime,
    int64_t fsize,
    int page_index,
    int include_annots,
    fz_cookie *cookie,
    int *out_dl_hit,
    int *out_page_count,
    int *out_aborted,
    char *err_buf,
    int err_cap
) {
    *out_dl_hit = 0;
    if (out_aborted) *out_aborted = 0;

    zot_rwlock_wrlock(&eng->cache_lock);
    for (int i = 0; i < eng->dl_count; i++) {
        DLEntry *e = eng->dls[i];
        if (e->page_index == page_index && e->include_annots == include_annots &&
            e->mtime == mtime && e->fsize == fsize &&
            strcmp(e->path, path) == 0 && strcmp(e->password, password) == 0) {
            e->last_used = ++eng->clock;
            e->refs++;
            *out_dl_hit = 1;
            if (out_page_count) *out_page_count = e->page_count;
            zot_rwlock_wrunlock(&eng->cache_lock);
            return e;
        }
    }
    zot_rwlock_wrunlock(&eng->cache_lock);

    if (cookie && cookie->abort) {
        if (out_aborted) *out_aborted = 1;
        return NULL;
    }

    int page_count = 0;
    fz_document *doc = worker_doc_get(eng, wctx, doc_cache, path, password, mtime, fsize, &page_count, err_buf, err_cap);
    if (!doc) return NULL;
    if (out_page_count) *out_page_count = page_count;

    if (page_index < 0 || page_index >= page_count) {
        if (err_buf && err_cap > 0) {
            snprintf(err_buf, (size_t)err_cap, "page index %d out of range [0, %d)", page_index, page_count);
        }
        return NULL;
    }

    // Build display list completely LOCK-FREE using this worker's private fz_document* + abortable fz_cookie!
    ZotRect bounds = {0};
    int aborted = 0;
    fz_display_list *dl = zot_build_display_list_ex(
        wctx, doc, page_index, include_annots, cookie, &bounds, &aborted, err_buf, err_cap
    );
    if (!dl) {
        if (out_aborted) *out_aborted = aborted;
        return NULL;
    }

    DLEntry *ev_dl = NULL;

    zot_rwlock_wrlock(&eng->cache_lock);
    for (int i = 0; i < eng->dl_count; i++) {
        DLEntry *e = eng->dls[i];
        if (e->page_index == page_index && e->include_annots == include_annots &&
            e->mtime == mtime && e->fsize == fsize &&
            strcmp(e->path, path) == 0 && strcmp(e->password, password) == 0) {
            e->last_used = ++eng->clock;
            e->refs++;
            *out_dl_hit = 1;
            zot_rwlock_wrunlock(&eng->cache_lock);
            zot_drop_display_list(wctx, dl);
            return e;
        }
    }

    if (eng->dl_count >= MAX_DLS) {
        int victim = 0;
        for (int i = 1; i < eng->dl_count; i++) {
            if (eng->dls[i]->last_used < eng->dls[victim]->last_used) victim = i;
        }
        DLEntry *v = eng->dls[victim];
        v->in_cache = 0;
        v->refs--;
        if (v->refs <= 0) ev_dl = v;
        eng->dls[victim] = eng->dls[--eng->dl_count];
    }

    DLEntry *ne = (DLEntry *)calloc(1, sizeof(DLEntry));
    ne->path = dup_str(path);
    ne->password = dup_str(password);
    ne->mtime = mtime;
    ne->fsize = fsize;
    ne->page_index = page_index;
    ne->include_annots = include_annots;
    ne->page_count = page_count;
    ne->dl = dl;
    ne->bounds = bounds;
    ne->refs = 2; // 1 cache + 1 caller
    ne->last_used = ++eng->clock;
    ne->in_cache = 1;
    eng->dls[eng->dl_count++] = ne;
    zot_rwlock_wrunlock(&eng->cache_lock);

    if (ev_dl) {
        drop_dl_unlocked(wctx, ev_dl);
    }
    return ne;
}

static void release_dl(ZotEngine *eng, fz_context *wctx, DLEntry *dl) {
    DLEntry *to_drop_dl = NULL;
    zot_rwlock_wrlock(&eng->cache_lock);
    dl->refs--;
    if (dl->refs <= 0) to_drop_dl = dl;
    zot_rwlock_wrunlock(&eng->cache_lock);
    if (to_drop_dl) {
        drop_dl_unlocked(wctx, to_drop_dl);
    }
}

/* ---------------- Active Request Cookie Table ---------------- */

static void register_cookie(ZotEngine *eng, int req_id, fz_cookie *c) {
    if (req_id <= 0) return;
    zot_rwlock_wrlock(&eng->cookie_lock);
    for (int i = 0; i < MAX_ACTIVE_COOKIES; i++) {
        if (eng->cookies[i].cookie == NULL) {
            eng->cookies[i].req_id = req_id;
            eng->cookies[i].cookie = c;
            break;
        }
    }
    zot_rwlock_wrunlock(&eng->cookie_lock);
}

static void unregister_cookie(ZotEngine *eng, fz_cookie *c) {
    zot_rwlock_wrlock(&eng->cookie_lock);
    for (int i = 0; i < MAX_ACTIVE_COOKIES; i++) {
        if (eng->cookies[i].cookie == c) {
            eng->cookies[i].req_id = 0;
            eng->cookies[i].cookie = NULL;
            break;
        }
    }
    zot_rwlock_wrunlock(&eng->cookie_lock);
}

/* ---------------- Direction-Aware LIFO Foreground-Yielding Pre-Renderer ---------------- */

static void free_bg_job(BgJob *j) {
    free(j->path);
    free(j->password);
    j->path = NULL;
    j->password = NULL;
}

static void schedule_bg_prerenders(
    ZotEngine *eng,
    const char *path,
    const char *password,
    int64_t mtime,
    int64_t fsize,
    int page_index,
    int page_count,
    int width,
    int height,
    float src_pw,
    float src_ph,
    const float m[6],
    int include_annots,
    int aa_level,
    const ZotTheme *theme
) {
    if (eng->bg_thread_count <= 0) return;
    // Only pre-render real main viewer pages (never HiDPI 480x620 sidebar thumbnails!)
    if (width < 650 && height < 650) return;
    if (fabsf(m[4]) > 8.0f && fabsf(m[5]) > 8.0f) return;

    zot_mutex_lock(&eng->bg_cs);
    if (eng->bg_stop) {
        zot_mutex_unlock(&eng->bg_cs);
        return;
    }

    // Track scroll direction per document so upward scrolling pre-renders -1,-2,-3,+1!
    int dir = 1;
    if (eng->last_fg_path && strcmp(eng->last_fg_path, path) == 0) {
        if (page_index < eng->last_fg_page) dir = -1;
        else if (page_index > eng->last_fg_page) dir = 1;
        else dir = eng->last_fg_dir != 0 ? eng->last_fg_dir : 1;
    } else {
        free(eng->last_fg_path);
        eng->last_fg_path = dup_str(path);
    }
    eng->last_fg_page = page_index;
    eng->last_fg_dir = dir;

    // Flush stale jobs from switched-away PDFs, old zoom dimensions, or pages far from current viewport
    int widx = 0;
    for (int i = 0; i < eng->bg_count; i++) {
        BgJob *ex = &eng->bg_queue[i];
        int stale = 0;
        if (strcmp(ex->path, path) != 0) {
            stale = 1;
        } else if (ex->width != width || ex->height != height || abs(ex->page_index - page_index) > 4) {
            stale = 1;
        }
        if (stale) {
            free_bg_job(ex);
        } else {
            if (widx != i) eng->bg_queue[widx] = *ex;
            widx++;
        }
    }
    eng->bg_count = widx;

    // Insert in reverse priority order at front (index 0) so highest-priority neighbor (+dir) pops FIRST!
    const int offsets[3] = { -dir, dir * 2, dir };
    int woke = 0;
    for (int k = 0; k < 3; k++) {
        int tp = page_index + offsets[k];
        if (tp < 0 || (page_count > 0 && tp >= page_count)) continue;

        PixKey pk;
        memset(&pk, 0, sizeof(pk));
        pk.path = (char *)path;
        pk.password = (char *)password;
        pk.mtime = mtime;
        pk.fsize = fsize;
        pk.page_index = tp;
        pk.width = width;
        pk.height = height;
        quantize_m(m, pk.qm);
        pk.include_annots = include_annots;
        pk.aa_level = aa_level;
        pk.theme = *theme;

        if (pix_exists(eng, &pk)) continue;

        // Remove existing duplicate so it gets promoted to the front
        for (int q = 0; q < eng->bg_count; q++) {
            BgJob *ex = &eng->bg_queue[q];
            if (ex->page_index == tp && ex->width == width && ex->height == height && strcmp(ex->path, path) == 0) {
                free_bg_job(ex);
                if (q + 1 < eng->bg_count) {
                    memmove(&eng->bg_queue[q], &eng->bg_queue[q + 1], (size_t)(eng->bg_count - q - 1) * sizeof(BgJob));
                }
                eng->bg_count--;
                break;
            }
        }

        if (eng->bg_count >= BG_QUEUE_CAP) {
            free_bg_job(&eng->bg_queue[eng->bg_count - 1]);
            eng->bg_count--;
        }
        if (eng->bg_count > 0) {
            memmove(&eng->bg_queue[1], &eng->bg_queue[0], (size_t)eng->bg_count * sizeof(BgJob));
        }
        BgJob *slot = &eng->bg_queue[0];
        slot->path = dup_str(path);
        slot->password = dup_str(password);
        slot->page_index = tp;
        slot->width = width;
        slot->height = height;
        slot->src_pw = src_pw;
        slot->src_ph = src_ph;
        memcpy(slot->m, m, sizeof(slot->m));
        slot->include_annots = include_annots;
        slot->aa_level = aa_level;
        slot->theme = *theme;
        eng->bg_count++;
        woke = 1;
    }
    if (woke) {
        zot_cond_broadcast(&eng->bg_cv);
    }
    zot_mutex_unlock(&eng->bg_cs);
}

static ZOT_THREAD_RET bg_worker_proc(void *arg) {
    ZotEngine *eng = (ZotEngine *)arg;
    // Lowest priority guarantees background pre-rendering NEVER starves Zotero UI, WebRender, or PDF.js!
    zot_set_bg_priority();

    fz_context *wctx = zot_clone_context(eng->base_ctx);
    if (!wctx) ZOT_THREAD_RETURN;

    WorkerDocCache local_docs;
    memset(&local_docs, 0, sizeof(local_docs));

    for (;;) {
        BgJob job;
        int should_clear_docs = 0;
        zot_mutex_lock(&eng->bg_cs);
        while (!eng->bg_stop && (eng->bg_count == 0 || zot_atomic32_load(&eng->fg_active) > 0)) {
            int64_t cur_gen = zot_atomic64_load(&eng->evict_gen);
            if (local_docs.count > 0 && local_docs.last_evict_gen != cur_gen) {
                should_clear_docs = 1;
                break;
            }
            int timeout = eng->bg_count == 0 ? (local_docs.count > 0 ? 15000 : -1) : 35;
            int signaled = zot_cond_wait_ms(&eng->bg_cv, &eng->bg_cs, timeout);
            if (!signaled && eng->bg_count == 0 && local_docs.count > 0) {
                should_clear_docs = 1;
                break;
            }
        }
        if (eng->bg_stop) {
            zot_mutex_unlock(&eng->bg_cs);
            break;
        }
        if (should_clear_docs) {
            zot_mutex_unlock(&eng->bg_cs);
            worker_doc_cache_clear(wctx, &local_docs);
            local_docs.last_evict_gen = zot_atomic64_load(&eng->evict_gen);
            continue;
        }
        // Pop highest-priority job from index 0
        job = eng->bg_queue[0];
        eng->bg_count--;
        if (eng->bg_count > 0) {
            memmove(&eng->bg_queue[0], &eng->bg_queue[1], (size_t)eng->bg_count * sizeof(BgJob));
        }
        zot_mutex_unlock(&eng->bg_cs);

        int64_t mtime = 0, fsize = 0;
        if (stat_utf8(job.path, &mtime, &fsize) == 0) {
            PixKey pk;
            memset(&pk, 0, sizeof(pk));
            pk.path = job.path;
            pk.password = job.password;
            pk.mtime = mtime;
            pk.fsize = fsize;
            pk.page_index = job.page_index;
            pk.width = job.width;
            pk.height = job.height;
            quantize_m(job.m, pk.qm);
            pk.include_annots = job.include_annots;
            pk.aa_level = job.aa_level;
            pk.theme = job.theme;

            if (!pix_exists(eng, &pk)) {
                int dl_hit = 0, page_count = 0, aborted = 0;
                char err_buf[256];
                DLEntry *dl = acquire_dl(
                    eng, wctx, &local_docs, job.path, job.password, mtime, fsize,
                    job.page_index, job.include_annots, NULL, &dl_hit, &page_count, &aborted,
                    err_buf, sizeof(err_buf)
                );
                if (dl) {
                    float pw = dl->bounds.x1 - dl->bounds.x0;
                    float ph = dl->bounds.y1 - dl->bounds.y0;
                    // Skip rasterizing at wrong aspect if this page has different physical page dimensions
                    // (the parsed Display List still stays cached in eng->dls for instant rendering!)
                    int same_dims = (job.src_pw <= 0.0f || job.src_ph <= 0.0f) ||
                                    (fabsf(pw - job.src_pw) <= 2.5f && fabsf(ph - job.src_ph) <= 2.5f);
                    if (zot_atomic32_load(&eng->fg_active) > 0) {
                        zot_thread_yield();
                    }
                    if (same_dims && !eng->bg_stop && !pix_exists(eng, &pk)) {
                        size_t nbytes = (size_t)job.width * (size_t)job.height * 4;
                        unsigned char *buf = pix_alloc_buf(eng, nbytes);
                        if (buf) {
                            fz_cookie cookie;
                            memset(&cookie, 0, sizeof(cookie));
                            int rc = zot_render_display_list(
                                wctx, dl->dl, dl->bounds, job.m, job.width, job.height,
                                job.aa_level, &job.theme, &cookie, buf, err_buf, sizeof(err_buf)
                            );
                            if (rc == 0) {
                                pix_store_take(eng, &pk, buf, nbytes, pw, ph, page_count);
                            } else {
                                pix_release_buf(eng, buf, nbytes);
                            }
                        }
                    }
                    release_dl(eng, wctx, dl);
                }
            }
        }
        free_bg_job(&job);
    }

    worker_doc_cache_clear(wctx, &local_docs);
    zot_drop_cloned_context(wctx);
    ZOT_THREAD_RETURN;
}

/* ---------------- Engine Lifecycle ---------------- */

static ZotEngine *create_engine_internal(int store_mb, int pix_cache_mb, int bg_workers) {
    if (store_mb <= 0) store_mb = 96;
    if (pix_cache_mb <= 0) pix_cache_mb = 96;
    if (bg_workers < 0) bg_workers = 0;
    if (bg_workers > 4) bg_workers = 4;

    ZotEngine *eng = (ZotEngine *)calloc(1, sizeof(ZotEngine));
    if (!eng) return NULL;

    eng->base_ctx = zot_new_base_context((size_t)store_mb << 20, &eng->base_locks);
    if (!eng->base_ctx) {
        free(eng);
        return NULL;
    }

    zot_rwlock_init(&eng->cache_lock);
    zot_rwlock_init(&eng->pix_lock);
    zot_rwlock_init(&eng->cookie_lock);
    zot_mutex_init(&eng->bg_cs);
    zot_cond_init(&eng->bg_cv);
    eng->max_pix_bytes = (size_t)pix_cache_mb << 20;
    eng->last_fg_dir = 1;

    if (bg_workers > 0) {
        eng->bg_threads = (zot_thread_t *)calloc((size_t)bg_workers, sizeof(zot_thread_t));
        if (eng->bg_threads) {
            for (int i = 0; i < bg_workers; i++) {
#ifdef _WIN32
                uintptr_t th = _beginthreadex(NULL, 0, bg_worker_proc, eng, 0, NULL);
                if (th != 0) {
                    eng->bg_threads[eng->bg_thread_count++] = (HANDLE)th;
                }
#else
                pthread_t th;
                if (pthread_create(&th, NULL, bg_worker_proc, eng) == 0) {
                    eng->bg_threads[eng->bg_thread_count++] = th;
                }
#endif
            }
        }
    }
    return eng;
}

static void destroy_engine_internal(ZotEngine *eng) {
    if (!eng) return;

    zot_mutex_lock(&eng->bg_cs);
    eng->bg_stop = 1;
    for (int i = 0; i < eng->bg_count; i++) {
        free_bg_job(&eng->bg_queue[i]);
    }
    eng->bg_count = 0;
    free(eng->last_fg_path);
    eng->last_fg_path = NULL;
    zot_cond_broadcast(&eng->bg_cv);
    zot_mutex_unlock(&eng->bg_cs);

    for (int i = 0; i < eng->bg_thread_count; i++) {
#ifdef _WIN32
        WaitForSingleObject(eng->bg_threads[i], 3000);
        CloseHandle(eng->bg_threads[i]);
#else
        pthread_join(eng->bg_threads[i], NULL);
#endif
    }
    free(eng->bg_threads);
    zot_cond_destroy(&eng->bg_cv);
    zot_mutex_destroy(&eng->bg_cs);
    zot_rwlock_destroy(&eng->cookie_lock);
    zot_rwlock_destroy(&eng->pix_lock);
    zot_rwlock_destroy(&eng->cache_lock);

    PixEntry *pe = eng->pix_head;
    while (pe) {
        PixEntry *next = pe->next;
        free_pix_entry(pe);
        pe = next;
    }
    for (int i = 0; i < eng->pix_recycle_count; i++) {
        free(eng->pix_recycle[i].ptr);
    }

    for (int i = 0; i < eng->dl_count; i++) {
        drop_dl_unlocked(eng->base_ctx, eng->dls[i]);
    }

    zot_drop_base_context(eng->base_ctx, eng->base_locks);
    free(eng);
}

/* ---------------- Exported DLL API ---------------- */

ZOT_EXPORT const char *zot_dll_version(void) {
    return zot_mupdf_version();
}

ZOT_EXPORT void *zot_dll_engine_acquire(int store_mb, int pix_cache_mb, int bg_workers) {
    zot_rwlock_wrlock(&g_singleton_lock);
    if (!g_engine) {
        g_engine = create_engine_internal(store_mb, pix_cache_mb, bg_workers);
    }
    if (g_engine) {
        g_engine_refs++;
    }
    void *ret = g_engine;
    zot_rwlock_wrunlock(&g_singleton_lock);
    return ret;
}

ZOT_EXPORT void zot_dll_engine_release(void *eng) {
    ZotEngine *to_destroy = NULL;
    zot_rwlock_wrlock(&g_singleton_lock);
    if (eng && eng == g_engine) {
        g_engine_refs--;
        if (g_engine_refs <= 0) {
            to_destroy = g_engine;
            g_engine = NULL;
            g_engine_refs = 0;
        }
    }
    zot_rwlock_wrunlock(&g_singleton_lock);
    if (to_destroy) {
        destroy_engine_internal(to_destroy);
    }
}

ZOT_EXPORT void zot_dll_engine_evict(void *eng_ptr) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    if (!eng) return;

    zot_mutex_lock(&eng->bg_cs);
    for (int i = 0; i < eng->bg_count; i++) {
        free_bg_job(&eng->bg_queue[i]);
    }
    eng->bg_count = 0;
    free(eng->last_fg_path);
    eng->last_fg_path = NULL;
    zot_atomic64_inc(&eng->evict_gen);
    zot_cond_broadcast(&eng->bg_cv);
    zot_mutex_unlock(&eng->bg_cs);

    zot_rwlock_wrlock(&eng->pix_lock);
    PixEntry *pe = eng->pix_head;
    eng->pix_head = eng->pix_tail = NULL;
    eng->pix_bytes = 0;
    for (int i = 0; i < eng->pix_recycle_count; i++) {
        free(eng->pix_recycle[i].ptr);
    }
    eng->pix_recycle_count = 0;
    zot_rwlock_wrunlock(&eng->pix_lock);
    while (pe) {
        PixEntry *next = pe->next;
        free_pix_entry(pe);
        pe = next;
    }

    fz_context *tmp = zot_clone_context(eng->base_ctx);
    if (!tmp) return;

    DLEntry *drop_dls[MAX_DLS];
    int n_dls = 0;

    zot_rwlock_wrlock(&eng->cache_lock);
    for (int i = 0; i < eng->dl_count; i++) {
        DLEntry *e = eng->dls[i];
        e->in_cache = 0;
        e->refs--;
        if (e->refs <= 0) drop_dls[n_dls++] = e;
    }
    eng->dl_count = 0;
    zot_rwlock_wrunlock(&eng->cache_lock);

    for (int i = 0; i < n_dls; i++) {
        drop_dl_unlocked(tmp, drop_dls[i]);
    }
    zot_shrink_store(tmp, 0);
    zot_drop_cloned_context(tmp);
}

ZOT_EXPORT void zot_dll_engine_evict_path(void *eng_ptr, const char *path_utf8) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    if (!eng || !path_utf8 || !path_utf8[0]) return;

    zot_mutex_lock(&eng->bg_cs);
    int widx = 0;
    for (int i = 0; i < eng->bg_count; i++) {
        if (strcmp(eng->bg_queue[i].path, path_utf8) == 0) {
            free_bg_job(&eng->bg_queue[i]);
        } else {
            if (widx != i) eng->bg_queue[widx] = eng->bg_queue[i];
            widx++;
        }
    }
    eng->bg_count = widx;
    if (eng->last_fg_path && strcmp(eng->last_fg_path, path_utf8) == 0) {
        free(eng->last_fg_path);
        eng->last_fg_path = NULL;
    }
    zot_atomic64_inc(&eng->evict_gen);
    zot_cond_broadcast(&eng->bg_cv);
    zot_mutex_unlock(&eng->bg_cs);

    PixEntry *evicted = NULL;
    zot_rwlock_wrlock(&eng->pix_lock);
    PixEntry *cur = eng->pix_head;
    while (cur) {
        PixEntry *next = cur->next;
        if (cur->key.path && strcmp(cur->key.path, path_utf8) == 0) {
            pix_unlink(eng, cur);
            eng->pix_bytes -= cur->byte_len;
            cur->next = evicted;
            evicted = cur;
        }
        cur = next;
    }
    for (int i = 0; i < eng->pix_recycle_count; i++) {
        free(eng->pix_recycle[i].ptr);
    }
    eng->pix_recycle_count = 0;
    zot_rwlock_wrunlock(&eng->pix_lock);

    while (evicted) {
        PixEntry *next = evicted->next;
        free_pix_entry(evicted);
        evicted = next;
    }

    DLEntry *drop_dls[MAX_DLS];
    int n_dls = 0;
    zot_rwlock_wrlock(&eng->cache_lock);
    int dl_write = 0;
    for (int i = 0; i < eng->dl_count; i++) {
        DLEntry *e = eng->dls[i];
        if (e->path && strcmp(e->path, path_utf8) == 0) {
            e->in_cache = 0;
            e->refs--;
            if (e->refs <= 0) drop_dls[n_dls++] = e;
        } else {
            eng->dls[dl_write++] = e;
        }
    }
    eng->dl_count = dl_write;
    zot_rwlock_wrunlock(&eng->cache_lock);

    fz_context *tmp = zot_clone_context(eng->base_ctx);
    if (!tmp) return;
    for (int i = 0; i < n_dls; i++) {
        drop_dl_unlocked(tmp, drop_dls[i]);
    }
    zot_shrink_store(tmp, 50);
    zot_drop_cloned_context(tmp);
}

ZOT_EXPORT void zot_dll_engine_trim(void *eng_ptr, int aggressive) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    if (!eng) return;
    if (aggressive) {
        zot_dll_engine_evict(eng);
#ifdef _WIN32
        HANDLE hHeap = GetProcessHeap();
        if (hHeap) HeapCompact(hHeap, 0);
#endif
        return;
    }

    // Soft idle trim: release recycle buffer, keep at most 2 hottest bitmaps (<=48MB) and 8 DLs, shrink store 75%
    size_t target_pix = eng->max_pix_bytes / 3;
    if (target_pix > (48u << 20)) target_pix = (48u << 20);

    PixEntry *evicted = NULL;
    zot_rwlock_wrlock(&eng->pix_lock);
    for (int i = 0; i < eng->pix_recycle_count; i++) {
        free(eng->pix_recycle[i].ptr);
    }
    eng->pix_recycle_count = 0;

    int count = 0;
    for (PixEntry *p = eng->pix_head; p; p = p->next) count++;
    while (eng->pix_tail && (count > 2 || eng->pix_bytes > target_pix)) {
        PixEntry *ev = eng->pix_tail;
        pix_unlink(eng, ev);
        eng->pix_bytes -= ev->byte_len;
        count--;
        ev->next = evicted;
        evicted = ev;
    }
    zot_rwlock_wrunlock(&eng->pix_lock);

    while (evicted) {
        PixEntry *next = evicted->next;
        free_pix_entry(evicted);
        evicted = next;
    }

    DLEntry *drop_dls[MAX_DLS];
    int n_dls = 0;
    zot_rwlock_wrlock(&eng->cache_lock);
    while (eng->dl_count > 8) {
        int victim = 0;
        for (int i = 1; i < eng->dl_count; i++) {
            if (eng->dls[i]->last_used < eng->dls[victim]->last_used) victim = i;
        }
        DLEntry *v = eng->dls[victim];
        v->in_cache = 0;
        v->refs--;
        if (v->refs <= 0) drop_dls[n_dls++] = v;
        eng->dls[victim] = eng->dls[--eng->dl_count];
    }
    zot_rwlock_wrunlock(&eng->cache_lock);

    fz_context *tmp = zot_clone_context(eng->base_ctx);
    if (!tmp) return;
    for (int i = 0; i < n_dls; i++) {
        drop_dl_unlocked(tmp, drop_dls[i]);
    }
    zot_shrink_store(tmp, 25);
    zot_drop_cloned_context(tmp);
}

ZOT_EXPORT void zot_dll_engine_abort(void *eng_ptr, int req_id) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    if (!eng || req_id <= 0) return;
    zot_rwlock_rdlock(&eng->cookie_lock);
    for (int i = 0; i < MAX_ACTIVE_COOKIES; i++) {
        if (eng->cookies[i].req_id == req_id && eng->cookies[i].cookie) {
            zot_cookie_abort(eng->cookies[i].cookie);
        }
    }
    zot_rwlock_rdunlock(&eng->cookie_lock);
}

ZOT_EXPORT void *zot_dll_worker_create(void *eng_ptr) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    if (!eng) return NULL;
    ZotWorker *w = (ZotWorker *)calloc(1, sizeof(ZotWorker));
    if (!w) return NULL;
    w->ctx = zot_clone_context(eng->base_ctx);
    if (!w->ctx) {
        free(w);
        return NULL;
    }
    return w;
}

ZOT_EXPORT void zot_dll_worker_trim(void *worker_ptr) {
    ZotWorker *w = (ZotWorker *)worker_ptr;
    if (!w || !w->ctx) return;
    worker_doc_cache_clear(w->ctx, &w->doc_cache);
}

ZOT_EXPORT void zot_dll_worker_destroy(void *worker_ptr) {
    ZotWorker *w = (ZotWorker *)worker_ptr;
    if (!w) return;
    worker_doc_cache_clear(w->ctx, &w->doc_cache);
    zot_drop_cloned_context(w->ctx);
    free(w);
}

ZOT_EXPORT int zot_dll_render_rgba(
    void *eng_ptr,
    void *worker_ptr,
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
) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    ZotWorker *worker = (ZotWorker *)worker_ptr;
    if (!eng || !worker || !worker->ctx || !path_utf8 || !out_rgba || width <= 0 || height <= 0) {
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "invalid arguments");
        return -1;
    }
    if (!password_utf8) password_utf8 = "";
    if (aa_level <= 0) aa_level = 8;

    double t0 = now_ms();

    int64_t mtime = 0, fsize = 0;
    if (stat_utf8(path_utf8, &mtime, &fsize) != 0) {
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "stat failed for pdf path");
        return -1;
    }

    float m[6] = { m0, m1, m2, m3, m4, m5 };
    ZotTheme theme;
    memset(&theme, 0, sizeof(theme));
    if (theme_enabled) {
        theme.enabled = 1;
        theme.bg[0] = (unsigned char)((bg_rgb >> 16) & 0xFF);
        theme.bg[1] = (unsigned char)((bg_rgb >> 8) & 0xFF);
        theme.bg[2] = (unsigned char)(bg_rgb & 0xFF);
        theme.fg[0] = (unsigned char)((fg_rgb >> 16) & 0xFF);
        theme.fg[1] = (unsigned char)((fg_rgb >> 8) & 0xFF);
        theme.fg[2] = (unsigned char)(fg_rgb & 0xFF);
        theme.invert_images = invert_images ? 1 : 0;
    }

    PixKey pk;
    memset(&pk, 0, sizeof(pk));
    pk.path = (char *)path_utf8;
    pk.password = (char *)password_utf8;
    pk.mtime = mtime;
    pk.fsize = fsize;
    pk.page_index = page_index;
    pk.width = width;
    pk.height = height;
    quantize_m(m, pk.qm);
    pk.include_annots = include_annots ? 1 : 0;
    pk.aa_level = aa_level;
    pk.theme = theme;

    // 1. Ultra-fast RAM RGBA bitmap cache hit (~1-2 ms direct memcpy into warm JS ArrayBuffer!)
    float hit_pw = 0.0f, hit_ph = 0.0f;
    int hit_pc = 0;
    if (pix_lookup_copy(eng, &pk, out_rgba, &hit_pw, &hit_ph, &hit_pc)) {
        double elapsed = now_ms() - t0;
        if (out_stats) {
            out_stats[0] = (float)elapsed;
            out_stats[1] = 2.0f; // tier = pix
            out_stats[2] = hit_pw;
            out_stats[3] = hit_ph;
        }
        schedule_bg_prerenders(eng, path_utf8, password_utf8, mtime, fsize, page_index, hit_pc, width, height, hit_pw, hit_ph, m, pk.include_annots, aa_level, &theme);
        return 0;
    }

    // 2. Lock-free parallel display-list acquire + direct zero-copy rasterization into out_rgba
    zot_atomic32_inc(&eng->fg_active);

    fz_cookie cookie;
    memset(&cookie, 0, sizeof(cookie));
    register_cookie(eng, req_id, &cookie);

    int dl_hit = 0, page_count = 0, aborted = 0;
    DLEntry *dl = acquire_dl(
        eng, worker->ctx, &worker->doc_cache, path_utf8, password_utf8, mtime, fsize,
        page_index, pk.include_annots, &cookie, &dl_hit, &page_count, &aborted,
        err_buf, err_cap
    );
    if (!dl) {
        unregister_cookie(eng, &cookie);
        if (zot_atomic32_dec(&eng->fg_active) == 0) {
            zot_mutex_lock(&eng->bg_cs);
            zot_cond_broadcast(&eng->bg_cv);
            zot_mutex_unlock(&eng->bg_cs);
        }
        return aborted ? 1 : -1;
    }

    int rc = zot_render_display_list(
        worker->ctx,
        dl->dl,
        dl->bounds,
        m,
        width,
        height,
        aa_level,
        &theme,
        &cookie,
        out_rgba,
        err_buf,
        err_cap
    );

    unregister_cookie(eng, &cookie);

    float pw = dl->bounds.x1 - dl->bounds.x0;
    float ph = dl->bounds.y1 - dl->bounds.y0;
    release_dl(eng, worker->ctx, dl);

    if (zot_atomic32_dec(&eng->fg_active) == 0) {
        zot_mutex_lock(&eng->bg_cs);
        zot_cond_broadcast(&eng->bg_cv);
        zot_mutex_unlock(&eng->bg_cs);
    }

    if (rc == 0) {
        if (width >= 650 || height >= 650) {
            // Skip redundant 25MB foreground pix_store_copy (Zotero DOM canvas holds this page right now!);
            // keep pixCache dedicated to upcoming off-thread bg pre-renders (+dir, +2*dir, -dir).
            schedule_bg_prerenders(eng, path_utf8, password_utf8, mtime, fsize, page_index, page_count, width, height, pw, ph, m, pk.include_annots, aa_level, &theme);
        }

        double elapsed = now_ms() - t0;
        if (out_stats) {
            out_stats[0] = (float)elapsed;
            out_stats[1] = dl_hit ? 1.0f : 0.0f;
            out_stats[2] = pw;
            out_stats[3] = ph;
        }
    }
    return rc;
}

ZOT_EXPORT int zot_dll_render_thumb_rgba(
    void *eng_ptr,
    void *worker_ptr,
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
) {
    ZotEngine *eng = (ZotEngine *)eng_ptr;
    ZotWorker *worker = (ZotWorker *)worker_ptr;
    if (!eng || !worker || !worker->ctx || !path_utf8 || !out_rgba || target_w <= 0 || max_h <= 0) {
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "invalid thumbnail arguments");
        return -1;
    }
    if (!password_utf8) password_utf8 = "";
    if (aa_level <= 0) aa_level = 4;

    double t0 = now_ms();

    int64_t mtime = 0, fsize = 0;
    if (stat_utf8(path_utf8, &mtime, &fsize) != 0) {
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "stat failed for pdf path");
        return -1;
    }

    ZotTheme theme;
    memset(&theme, 0, sizeof(theme));
    if (theme_enabled) {
        theme.enabled = 1;
        theme.bg[0] = (unsigned char)((bg_rgb >> 16) & 0xFF);
        theme.bg[1] = (unsigned char)((bg_rgb >> 8) & 0xFF);
        theme.bg[2] = (unsigned char)(bg_rgb & 0xFF);
        theme.fg[0] = (unsigned char)((fg_rgb >> 16) & 0xFF);
        theme.fg[1] = (unsigned char)((fg_rgb >> 8) & 0xFF);
        theme.fg[2] = (unsigned char)(fg_rgb & 0xFF);
        theme.invert_images = invert_images ? 1 : 0;
    }

    fz_cookie cookie;
    memset(&cookie, 0, sizeof(cookie));
    register_cookie(eng, req_id, &cookie);

    int dl_hit = 0, page_count = 0, aborted = 0;
    DLEntry *dl = acquire_dl(
        eng, worker->ctx, &worker->doc_cache, path_utf8, password_utf8, mtime, fsize,
        page_index, 1, &cookie, &dl_hit, &page_count, &aborted, err_buf, err_cap
    );
    if (!dl) {
        unregister_cookie(eng, &cookie);
        return aborted ? 1 : -1;
    }

    float pw = dl->bounds.x1 - dl->bounds.x0;
    float ph = dl->bounds.y1 - dl->bounds.y0;
    if (pw <= 0.1f || ph <= 0.1f) {
        release_dl(eng, worker->ctx, dl);
        unregister_cookie(eng, &cookie);
        if (err_buf && err_cap > 0) snprintf(err_buf, (size_t)err_cap, "degenerate page bounds");
        return -1;
    }

    float scale = (float)target_w / pw;
    int w = target_w;
    int h = (int)lroundf(ph * scale);
    if (h < 1) h = 1;
    if (h > max_h) {
        h = max_h;
        scale = (float)max_h / ph;
        w = (int)lroundf(pw * scale);
        if (w < 1) w = 1;
        if (w > target_w) w = target_w;
    }

    float m[6] = { scale, 0.0f, 0.0f, scale, 0.0f, 0.0f };
    int rc = zot_render_display_list(
        worker->ctx,
        dl->dl,
        dl->bounds,
        m,
        w,
        h,
        aa_level,
        &theme,
        &cookie,
        out_rgba,
        err_buf,
        err_cap
    );

    unregister_cookie(eng, &cookie);
    release_dl(eng, worker->ctx, dl);

    if (rc == 0) {
        double elapsed = now_ms() - t0;
        if (out_stats) {
            out_stats[0] = (float)elapsed;
            out_stats[1] = (float)w;
            out_stats[2] = (float)h;
            out_stats[3] = pw / ph;
        }
    }
    return rc;
}
