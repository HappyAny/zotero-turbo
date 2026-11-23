#include "zot_dll.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <process.h>
#include <windows.h>
#define TEST_SLEEP_MS(ms) Sleep(ms)
#define TEST_THREAD_RET unsigned __stdcall
#define TEST_THREAD_RETURN return 0
#else
#include <pthread.h>
#include <unistd.h>
#define TEST_SLEEP_MS(ms) usleep((useconds_t)(ms) * 1000u)
#define TEST_THREAD_RET void *
#define TEST_THREAD_RETURN return NULL
#endif

typedef struct {
    void *eng;
    const char *pdf;
    int page_index;
    int ok;
    float ms;
} ThreadJob;

static int write_sample_pdf_utf8(const char *utf8_path) {
#ifdef _WIN32
    wchar_t wpath[MAX_PATH * 2];
    if (MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, wpath, (int)(sizeof(wpath) / sizeof(wpath[0]))) <= 0) {
        return 0;
    }
    FILE *fp = _wfopen(wpath, L"wb");
#else
    FILE *fp = fopen(utf8_path, "wb");
#endif
    if (!fp) return 0;

    // Build a valid 3-page PDF with vector content on each page and exact xref byte offsets
    const char *streams[3] = {
        "0.1 0.4 0.8 rg 60 650 480 90 re f 0.9 0.2 0.2 RG 4 w 60 120 m 540 600 l S\n",
        "0.2 0.7 0.3 rg 80 500 440 200 re f 0.1 0.1 0.1 RG 3 w 80 460 m 520 120 l S\n",
        "0.8 0.5 0.1 rg 100 300 400 320 re f 0.2 0.2 0.8 RG 5 w 100 200 m 500 680 l S\n",
    };

    long offsets[9] = {0};
    fprintf(fp, "%%PDF-1.4\n%%\xE2\xE3\xCF\xD3\n");

    offsets[1] = ftell(fp);
    fprintf(fp, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    offsets[2] = ftell(fp);
    fprintf(fp, "2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>\nendobj\n");

    for (int i = 0; i < 3; i++) {
        int page_obj = 3 + i * 2;
        int content_obj = 4 + i * 2;
        size_t slen = strlen(streams[i]);

        offsets[page_obj] = ftell(fp);
        fprintf(fp,
                "%d 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents %d 0 R >>\nendobj\n",
                page_obj, content_obj);

        offsets[content_obj] = ftell(fp);
        fprintf(fp, "%d 0 obj\n<< /Length %zu >>\nstream\n%sendstream\nendobj\n",
                content_obj, slen, streams[i]);
    }

    long xref_pos = ftell(fp);
    fprintf(fp, "xref\n0 9\n");
    fprintf(fp, "0000000000 65535 f \n");
    for (int id = 1; id <= 8; id++) {
        fprintf(fp, "%010ld 00000 n \n", offsets[id]);
    }
    fprintf(fp, "trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n%ld\n%%%%EOF\n", xref_pos);

    fclose(fp);
    return 1;
}

static int delete_utf8_file(const char *utf8_path) {
#ifdef _WIN32
    wchar_t wpath[MAX_PATH * 2];
    if (MultiByteToWideChar(CP_UTF8, 0, utf8_path, -1, wpath, (int)(sizeof(wpath) / sizeof(wpath[0]))) > 0) {
        return DeleteFileW(wpath) ? 1 : 0;
    }
    return 0;
#else
    return unlink(utf8_path) == 0 ? 1 : 0;
#endif
}

static int has_non_white_pixels(const unsigned char *rgba, int width, int height) {
    size_t n = (size_t)width * (size_t)height;
    for (size_t i = 0; i < n; i += 7) {
        if (rgba[i * 4] != 255 || rgba[i * 4 + 1] != 255 || rgba[i * 4 + 2] != 255) {
            return 1;
        }
    }
    return 0;
}

static TEST_THREAD_RET parallel_worker(void *arg) {
    ThreadJob *j = (ThreadJob *)arg;
    void *w = zot_dll_worker_create(j->eng);
    if (!w) TEST_THREAD_RETURN;
    int width = 2000, height = 2600;
    unsigned char *buf = (unsigned char *)malloc((size_t)width * (size_t)height * 4);
    float stats[4] = {0};
    char err[256] = {0};
    int rc = zot_dll_render_rgba(j->eng, w, 100 + j->page_index, j->pdf, "", j->page_index,
                                 width, height, 3.2f, 0, 0, 3.2f, 0, 0, 1, 8, 0, 0, 0, 0,
                                 buf, stats, err, sizeof(err));
    j->ok = (rc == 0 && has_non_white_pixels(buf, width, height));
    j->ms = stats[0];
    free(buf);
    zot_dll_worker_destroy(w);
    TEST_THREAD_RETURN;
}

int main(void) {
    printf("DLL MuPDF version: %s\n", zot_dll_version());

    char temp_utf8[1024] = {0};
    unsigned long pid_num = 0;
#ifdef _WIN32
    wchar_t wtemp[MAX_PATH];
    DWORD tlen = GetTempPathW(MAX_PATH, wtemp);
    if (tlen == 0 || tlen >= MAX_PATH) {
        printf("GetTempPathW failed\n");
        return 1;
    }
    if (WideCharToMultiByte(CP_UTF8, 0, wtemp, -1, temp_utf8, sizeof(temp_utf8), NULL, NULL) <= 0) {
        printf("WideCharToMultiByte failed\n");
        return 1;
    }
    pid_num = (unsigned long)GetCurrentProcessId();
#else
    const char *td = getenv("TMPDIR");
    if (!td || !td[0]) td = "/tmp";
    size_t tdlen = strlen(td);
    if (tdlen > 0 && td[tdlen - 1] == '/') {
        snprintf(temp_utf8, sizeof(temp_utf8), "%s", td);
    } else {
        snprintf(temp_utf8, sizeof(temp_utf8), "%s/", td);
    }
    pid_num = (unsigned long)getpid();
#endif

    char pdf_path[1280];
    char cn_path[1280];
    snprintf(pdf_path, sizeof(pdf_path), "%szot_mupdf_test_%lu.pdf", temp_utf8, pid_num);
    // UTF-8 Chinese filename: 测试文档
    snprintf(cn_path, sizeof(cn_path), "%szot_mupdf_\xe6\xb5\x8b\xe8\xaf\x95\xe6\x96\x87\xe6\xa1\xa3_%lu.pdf",
             temp_utf8, pid_num);

    const char *env_pdf = getenv("ZOT_TEST_PDF");
    int created_main = 0;
    if (!env_pdf || !env_pdf[0]) {
        if (!write_sample_pdf_utf8(pdf_path)) {
            printf("Failed to write temp test PDF\n");
            return 1;
        }
        created_main = 1;
    } else {
        snprintf(pdf_path, sizeof(pdf_path), "%s", env_pdf);
    }
    if (!write_sample_pdf_utf8(cn_path)) {
        printf("Failed to write Chinese UTF-8 temp PDF\n");
        if (created_main) delete_utf8_file(pdf_path);
        return 1;
    }

    void *eng = zot_dll_engine_acquire(96, 96, 1);
    if (!eng) {
        printf("acquire failed\n");
        if (created_main) delete_utf8_file(pdf_path);
        delete_utf8_file(cn_path);
        return 1;
    }
    void *w = zot_dll_worker_create(eng);
    if (!w) {
        printf("worker failed\n");
        zot_dll_engine_release(eng);
        if (created_main) delete_utf8_file(pdf_path);
        delete_utf8_file(cn_path);
        return 1;
    }

    int width = 2200, height = 2850;
    unsigned char *rgba = (unsigned char *)malloc((size_t)width * (size_t)height * 4);
    float stats[4] = {0};
    char err[256] = {0};

    int rc1 = zot_dll_render_rgba(eng, w, 1, pdf_path, "", 0, width, height,
                                  3.69f, 0, 0, 3.38f, 0, 0, 1, 8, 0, 0, 0, 0,
                                  rgba, stats, err, sizeof(err));
    int px1 = (rc1 == 0) ? has_non_white_pixels(rgba, width, height) : 0;
    printf("Cold 4K HiDPI direct-write (2200x2850, 25.1MB): rc=%d, px=%d, ms=%.2f, tier=%.0f, page=%.1fx%.1f, err=%s\n",
           rc1, px1, stats[0], stats[1], stats[2], stats[3], err);

    int rc2 = zot_dll_render_rgba(eng, w, 2, pdf_path, "", 0, width, height,
                                  3.69f, 0, 0, 3.38f, 0, 0, 1, 8, 0, 0, 0, 0,
                                  rgba, stats, err, sizeof(err));
    int tier2_ok = (rc2 == 0 && (int)(stats[1] + 0.5f) == 1);
    printf("Warm 4K HiDPI DL hit (zero redundant fg pix copy): rc=%d, ms=%.2f, tier=%.0f\n",
           rc2, stats[0], stats[1]);

    // Wait 300ms for low-priority background pre-render of page 2 (index 1)
    TEST_SLEEP_MS(300);
    int rc3 = zot_dll_render_rgba(eng, w, 3, pdf_path, "", 1, width, height,
                                  3.69f, 0, 0, 3.38f, 0, 0, 1, 8, 0, 0, 0, 0,
                                  rgba, stats, err, sizeof(err));
    int px3 = (rc3 == 0) ? has_non_white_pixels(rgba, width, height) : 0;
    int tier3_ok = (rc3 == 0 && (int)(stats[1] + 0.5f) == 2);
    printf("Pre-rendered 4K HiDPI next page (p2 PIX hit): rc=%d, px=%d, ms=%.2f, tier=%.0f\n",
           rc3, px3, stats[0], stats[1]);

    // Test lock-free parallel rendering on 3 simultaneous foreground threads for the SAME PDF
    zot_dll_engine_evict(eng);
    ThreadJob jobs[3] = {
        { eng, pdf_path, 0, 0, 0 },
        { eng, pdf_path, 1, 0, 0 },
        { eng, pdf_path, 2, 0, 0 },
    };
#ifdef _WIN32
    HANDLE hs[3];
    for (int i = 0; i < 3; i++) {
        hs[i] = (HANDLE)_beginthreadex(NULL, 0, parallel_worker, &jobs[i], 0, NULL);
    }
    WaitForMultipleObjects(3, hs, TRUE, 15000);
    int par_ok = 1;
    for (int i = 0; i < 3; i++) {
        CloseHandle(hs[i]);
        if (!jobs[i].ok) par_ok = 0;
    }
#else
    pthread_t ths[3];
    for (int i = 0; i < 3; i++) {
        pthread_create(&ths[i], NULL, parallel_worker, &jobs[i]);
    }
    int par_ok = 1;
    for (int i = 0; i < 3; i++) {
        pthread_join(ths[i], NULL);
        if (!jobs[i].ok) par_ok = 0;
    }
#endif
    printf("3-thread lock-free parallel same-PDF render: ok=%d (p1=%.1fms, p2=%.1fms, p3=%.1fms)\n",
           par_ok, jobs[0].ms, jobs[1].ms, jobs[2].ms);

    // Test Chinese UTF-8 filename + repeated direct-write reuse into same rgba buffer
    int rc4 = zot_dll_render_rgba(eng, w, 4, cn_path, "", 0, 1600, 1200,
                                  1.5f, 0, 0, 1.5f, 0, 0, 1, 8, 0, 0, 0, 0,
                                  rgba, stats, err, sizeof(err));
    int px4 = (rc4 == 0) ? has_non_white_pixels(rgba, 1600, 1200) : 0;
    printf("Chinese UTF-8 path PDF: rc=%d, px=%d, ms=%.2f, page=%.1fx%.1f, err=%s\n",
           rc4, px4, stats[0], stats[2], stats[3], err);

    // Test dark-mode LUT pixel theme (invert_images=1) & device theme (invert_images=0) at 4K HiDPI
    int rc_dark1 = zot_dll_render_rgba(eng, w, 7, pdf_path, "", 0, width, height,
                                       3.69f, 0, 0, 3.38f, 0, 0, 1, 8, 1, 0x1E1E1E, 0xE5E5E5, 1,
                                       rgba, stats, err, sizeof(err));
    int dark1_bg_ok = (rc_dark1 == 0 && rgba[0] == 0x1E && rgba[1] == 0x1E && rgba[2] == 0x1E && rgba[3] == 255);
    printf("Dark-mode 4K LUT (invertImages=1, 2200x2850): rc=%d, bg_ok=%d, ms=%.2f, err=%s\n",
           rc_dark1, dark1_bg_ok, stats[0], err);

    int rc_dark0 = zot_dll_render_rgba(eng, w, 8, pdf_path, "", 0, width, height,
                                       3.69f, 0, 0, 3.38f, 0, 0, 1, 8, 1, 0x1E1E1E, 0xE5E5E5, 0,
                                       rgba, stats, err, sizeof(err));
    int dark0_bg_ok = (rc_dark0 == 0 && rgba[0] == 0x1E && rgba[1] == 0x1E && rgba[2] == 0x1E && rgba[3] == 255);
    printf("Dark-mode 4K Device (invertImages=0, 2200x2850): rc=%d, bg_ok=%d, ms=%.2f, err=%s\n",
           rc_dark0, dark0_bg_ok, stats[0], err);

    // Test fast native thumbnail renderer
    float tstats[4] = {0};
    int rc5 = zot_dll_render_thumb_rgba(eng, w, 5, pdf_path, "", 0, 240, 520, 4, 0, 0, 0, 0,
                                        rgba, tstats, err, sizeof(err));
    int px5 = (rc5 == 0) ? has_non_white_pixels(rgba, (int)tstats[1], (int)tstats[2]) : 0;
    printf("Native thumbnail (240w): rc=%d, px=%d, ms=%.2f, dims=%.0fx%.0f, aspect=%.3f, err=%s\n",
           rc5, px5, tstats[0], tstats[1], tstats[2], tstats[3], err);

    // Test per-path eviction + worker trim + soft/aggressive memory trim
    zot_dll_engine_evict_path(eng, cn_path);
    zot_dll_worker_trim(w);
    TEST_SLEEP_MS(50);
    int del_cn_ok = delete_utf8_file(cn_path);
    zot_dll_engine_trim(eng, 0);
    zot_dll_engine_trim(eng, 1);
    int rc6 = zot_dll_render_rgba(eng, w, 6, pdf_path, "", 0, 1200, 1600,
                                  2.0f, 0, 0, 2.0f, 0, 0, 1, 8, 0, 0, 0, 0,
                                  rgba, stats, err, sizeof(err));
    int px6 = (rc6 == 0) ? has_non_white_pixels(rgba, 1200, 1600) : 0;
    printf("Post-evict/trim re-render & unlocked delete: del_cn_ok=%d, rc=%d, px=%d, ms=%.2f, err=%s\n",
           del_cn_ok, rc6, px6, stats[0], err);

    free(rgba);
    zot_dll_worker_destroy(w);
    zot_dll_engine_release(eng);

    if (created_main) delete_utf8_file(pdf_path);
    if (!del_cn_ok) delete_utf8_file(cn_path);

    return (rc1 == 0 && px1 && tier2_ok && tier3_ok && px3 && rc4 == 0 && px4 &&
            dark1_bg_ok && dark0_bg_ok && rc5 == 0 && px5 && rc6 == 0 && px6 && del_cn_ok && par_ok) ? 0 : 1;
}
