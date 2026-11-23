/*
 * Self-contained native C test & micro-benchmark for zotero-turbo native library.
 */
#include "zot_turbo.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
  #include <direct.h>
  static double now_ms(void) {
      LARGE_INTEGER freq, ctr;
      QueryPerformanceFrequency(&freq);
      QueryPerformanceCounter(&ctr);
      return (double)ctr.QuadPart * 1000.0 / (double)freq.QuadPart;
  }
  static FILE *fopen_u8(const char *p, const char *m) {
      int wl = MultiByteToWideChar(CP_UTF8, 0, p, -1, NULL, 0);
      wchar_t *wp = (wchar_t *)malloc((size_t)wl * sizeof(wchar_t));
      MultiByteToWideChar(CP_UTF8, 0, p, -1, wp, wl);
      wchar_t wm[8] = {0};
      for (int i = 0; m[i] && i < 7; ++i) wm[i] = (wchar_t)m[i];
      FILE *fp = _wfopen(wp, wm);
      free(wp);
      return fp;
  }
  static void unlink_u8(const char *p) {
      int wl = MultiByteToWideChar(CP_UTF8, 0, p, -1, NULL, 0);
      wchar_t *wp = (wchar_t *)malloc((size_t)wl * sizeof(wchar_t));
      MultiByteToWideChar(CP_UTF8, 0, p, -1, wp, wl);
      DeleteFileW(wp);
      free(wp);
  }
#else
  #include <time.h>
  #include <unistd.h>
  static double now_ms(void) {
      struct timespec ts;
      clock_gettime(CLOCK_MONOTONIC, &ts);
      return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
  }
  static FILE *fopen_u8(const char *p, const char *m) { return fopen(p, m); }
  static void unlink_u8(const char *p) { unlink(p); }
#endif

static int write_minimal_pdf(const char *path) {
    /* Valid 2-page PDF with Helvetica text and an external URI link on page 1 */
    const char *stream1 =
        "BT\n"
        "/F1 12 Tf\n"
        "72 720 Td\n"
        "(Hello Zotero Turbo Engine!) Tj\n"
        "0 -20 Td\n"
        "(Second line of academic text.) Tj\n"
        "ET\n";
    const char *stream2 =
        "BT\n"
        "/F1 12 Tf\n"
        "72 700 Td\n"
        "(Page two quantum optics benchmark.) Tj\n"
        "ET\n";

    FILE *fp = fopen_u8(path, "wb");
    if (!fp) return -1;

    long offsets[14] = {0};
    fprintf(fp, "%%PDF-1.4\n");

    offsets[1] = ftell(fp);
    fprintf(fp, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R >>\nendobj\n");

    offsets[2] = ftell(fp);
    fprintf(fp, "2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>\nendobj\n");

    offsets[3] = ftell(fp);
    fprintf(fp, "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [8 0 R] >>\nendobj\n");

    offsets[4] = ftell(fp);
    fprintf(fp, "4 0 obj\n<< /Length %zu >>\nstream\n%s\nendstream\nendobj\n", strlen(stream1), stream1);

    offsets[5] = ftell(fp);
    fprintf(fp, "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

    offsets[6] = ftell(fp);
    fprintf(fp, "6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>\nendobj\n");

    offsets[7] = ftell(fp);
    fprintf(fp, "7 0 obj\n<< /Length %zu >>\nstream\n%s\nendstream\nendobj\n", strlen(stream2), stream2);

    offsets[8] = ftell(fp);
    fprintf(fp, "8 0 obj\n<< /Type /Annot /Subtype /Link /Rect [70 715 260 735] /Border [0 0 0] /A << /S /URI /URI (https://example.org/paper) >> >>\nendobj\n");

    offsets[9] = ftell(fp);
    fprintf(fp, "9 0 obj\n<< /Type /Outlines /First 10 0 R /Last 11 0 R /Count 2 >>\nendobj\n");

    offsets[10] = ftell(fp);
    fprintf(fp, "10 0 obj\n<< /Title (1 Introduction) /Parent 9 0 R /Next 11 0 R /Dest [3 0 R /XYZ 72 720 0] >>\nendobj\n");

    offsets[11] = ftell(fp);
    fprintf(fp, "11 0 obj\n<< /Title (2 Quantum Optics) /Parent 9 0 R /Prev 10 0 R /Dest [6 0 R /Fit] >>\nendobj\n");

    offsets[12] = ftell(fp);
    fprintf(fp, "12 0 obj\n<< /Title (Zotero Turbo Test Paper) /Author (Alice Smith) >>\nendobj\n");

    long xref_pos = ftell(fp);
    fprintf(fp, "xref\n0 13\n0000000000 65535 f \n");
    for (int i = 1; i <= 12; ++i) {
        fprintf(fp, "%010ld 00000 n \n", offsets[i]);
    }
    fprintf(fp, "trailer\n<< /Size 13 /Root 1 0 R /Info 12 0 R >>\nstartxref\n%ld\n%%%%EOF\n", xref_pos);
    fclose(fp);
    return 0;
}

#define CHECK(cond, msg) do { \
    if (!(cond)) { \
        fprintf(stderr, "[FAIL] %s (line %d)\n", msg, __LINE__); \
        return 1; \
    } \
} while (0)

int main(void) {
    printf("[test] zot_turbo version: %s\n", zot_turbo_version());
    CHECK(strcmp(zot_turbo_version(), "0.6.2") == 0, "version mismatch");

    ZotTurboEngine *eng = zot_turbo_engine_create(32);
    CHECK(eng != NULL, "engine_create failed");

    /* Use UTF-8 Chinese filename to verify Unicode paths */
    const char *pdf_path = "zot_turbo_test_\xE6\xB5\x8B\xE8\xAF\x95.pdf";
    CHECK(write_minimal_pdf(pdf_path) == 0, "write_minimal_pdf failed");

    /* 1. Test fulltext extraction */
    int len = 0, extracted = 0, total = 0, err = 0;
    double t0 = now_ms();
    char *ft = zot_turbo_pdf_fulltext(eng, pdf_path, 0, &len, &extracted, &total, &err);
    double dt = now_ms() - t0;
    CHECK(ft != NULL && err == 0, "pdf_fulltext failed");
    CHECK(extracted == 2 && total == 2, "pdf_fulltext page counts mismatch");
    CHECK(strstr(ft, "Hello Zotero Turbo Engine!") != NULL, "page 1 text missing");
    CHECK(strstr(ft, "quantum optics benchmark") != NULL, "page 2 text missing");
    CHECK(strchr(ft, '\f') != NULL, "formfeed page separator missing");
    printf("[PASS] fulltext: %d bytes, %d/%d pages in %.2f ms\n", len, extracted, total, dt);
    zot_turbo_free_buf(ft);

    /* 2. Test max_pages limit */
    char *ft1 = zot_turbo_pdf_fulltext(eng, pdf_path, 1, &len, &extracted, &total, &err);
    CHECK(ft1 != NULL && err == 0 && extracted == 1 && total == 2, "max_pages=1 failed");
    CHECK(strstr(ft1, "quantum optics") == NULL, "page 2 leaked into max_pages=1");
    printf("[PASS] fulltext max_pages=1: %d bytes\n", len);
    zot_turbo_free_buf(ft1);

    /* 3. Test single-page structured chars + links */
    t0 = now_ms();
    char *pd = zot_turbo_pdf_page_data(eng, pdf_path, 0, &len, &err);
    dt = now_ms() - t0;
    CHECK(pd != NULL && err == 0, "pdf_page_data failed");
    CHECK(strstr(pd, "\"b\":[0.00,0.00,612.00,792.00]") != NULL, "page_data bbox wrong");
    CHECK(strstr(pd, "https://example.org/paper") != NULL, "page_data link URI missing");
    CHECK(strstr(pd, "\"c\":[[72,") != NULL, "first char 'H' (72) missing");
    printf("[PASS] pdf_page_data: %d bytes JSON in %.2f ms\n", len, dt);
    zot_turbo_free_buf(pd);

    /* 3b. Test embedded PDF outline extraction */
    t0 = now_ms();
    char *ol = zot_turbo_pdf_outline(eng, pdf_path, &len, &err);
    dt = now_ms() - t0;
    CHECK(ol != NULL && err == 0, "pdf_outline failed");
    CHECK(strstr(ol, "1 Introduction") != NULL, "outline item 1 missing");
    CHECK(strstr(ol, "2 Quantum Optics") != NULL, "outline item 2 missing");
    CHECK(strstr(ol, "\"pageIndex\":1") != NULL, "outline pageIndex 1 missing");
    printf("[PASS] pdf_outline: %d bytes JSON in %.2f ms\n", len, dt);
    zot_turbo_free_buf(ol);

    /* 3c. Test PDF recognizer data extraction */
    t0 = now_ms();
    char *rd = zot_turbo_pdf_recognizer_data(eng, pdf_path, 5, &len, &err);
    dt = now_ms() - t0;
    CHECK(rd != NULL && err == 0, "pdf_recognizer_data failed");
    CHECK(strstr(rd, "\"Title\":\"Zotero Turbo Test Paper\"") != NULL, "recognizer Title missing");
    CHECK(strstr(rd, "\"Author\":\"Alice Smith\"") != NULL, "recognizer Author missing");
    CHECK(strstr(rd, "\"totalPages\":2") != NULL, "recognizer totalPages missing");
    CHECK(strstr(rd, "\"Turbo\"") != NULL, "recognizer word token missing");
    printf("[PASS] pdf_recognizer_data: %d bytes JSON in %.2f ms\n", len, dt);
    zot_turbo_free_buf(rd);

    /* 4. Test evict & trim (must unlock file on Windows so DeleteFileW succeeds) */
    zot_turbo_engine_evict_path(eng, pdf_path);
    zot_turbo_engine_trim(eng, 1);
    zot_turbo_os_trim_memory(0);
    unlink_u8(pdf_path);
    printf("[PASS] evict_path + trim + Windows file unlock\n");

    /* 5. Test multi-threaded parallel file scanner across 200 files */
    const int NFILES = 200;
    char *paths_buf = (char *)malloc(65536);
    paths_buf[0] = '\0';
    char fname[128];
    for (int i = 0; i < NFILES; ++i) {
        snprintf(fname, sizeof(fname), "zot_turbo_scan_%03d.txt", i);
        FILE *fp = fopen_u8(fname, "wb");
        CHECK(fp != NULL, "create scan test file failed");
        for (int r = 0; r < 60; ++r) {
            fprintf(fp, "Lorem ipsum dolor sit amet, consectetur adipiscing elit, line %d.\n", r);
        }
        if (i == 7 || i == 42 || i == 199) {
            fprintf(fp, "Special   QUANTUM\nOptics   Needle \xE9\x87\x8F\xE5\xAD\x90!\n");
        }
        fclose(fp);
        strcat(paths_buf, fname);
        if (i + 1 < NFILES) strcat(paths_buf, "\n");
    }

    int scanned = 0;
    t0 = now_ms();
    char *res = zot_turbo_scan_files(paths_buf, "quantum optics needle \xE9\x87\x8F\xE5\xAD\x90", 2 /* ci + norm_ws */, 500000, 0, &len, &scanned, &err);
    dt = now_ms() - t0;
    CHECK(res != NULL && err == 0, "scan_files failed");
    CHECK(scanned == NFILES, "scanned count mismatch");
    CHECK(strcmp(res, "[7,42,199]") == 0, "scan_files match indices mismatch");
    printf("[PASS] parallel scan_files (%d files, ci+norm_ws+UTF8): %s in %.2f ms\n", scanned, res, dt);
    zot_turbo_free_buf(res);

    /* Case-sensitive test should return empty */
    res = zot_turbo_scan_files(paths_buf, "quantum optics", 1 | 2, 500000, 0, &len, &scanned, &err);
    CHECK(res != NULL && strcmp(res, "[]") == 0, "case-sensitive mismatch");
    zot_turbo_free_buf(res);

    for (int i = 0; i < NFILES; ++i) {
        snprintf(fname, sizeof(fname), "zot_turbo_scan_%03d.txt", i);
        unlink_u8(fname);
    }
    free(paths_buf);

    zot_turbo_engine_destroy(eng);
    printf("[ALL TESTS PASSED]\n");
    return 0;
}
