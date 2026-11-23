/* global Zotero, ChromeUtils, IOUtils */
"use strict";

var ZotTurboBenchmark = (function () {
  function nowMs() {
    try {
      if (typeof ChromeUtils.now === "function") return ChromeUtils.now();
    } catch {}
    return Date.now();
  }

  async function findSamplePDFs(limit = 80) {
    const libraryID = Zotero.Libraries.userLibraryID;
    const rows = await Zotero.DB.queryAsync(
      `SELECT IA.itemID FROM itemAttachments IA
       JOIN items I ON I.itemID = IA.itemID
       WHERE I.libraryID = ? AND IA.contentType = 'application/pdf'
         AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
       ORDER BY I.dateModified DESC
       LIMIT ?`,
      [libraryID, limit * 3]
    );
    const pdfs = [];
    const ft = Zotero.FullText || Zotero.Fulltext;
    for (const row of rows) {
      if (pdfs.length >= limit) break;
      const item = await Zotero.Items.getAsync(row.itemID);
      if (!item || !item.isPDFAttachment()) continue;
      const filePath = await item.getFilePathAsync();
      if (!filePath) continue;
      let hasCache = false;
      try {
        const cf = ft.getItemCacheFile(item);
        if (cf && cf.path) {
          if (typeof IOUtils !== "undefined" && typeof IOUtils.exists === "function") {
            hasCache = await IOUtils.exists(cf.path);
          } else if (typeof cf.exists === "function") {
            hasCache = cf.exists();
          }
        }
      } catch {}
      pdfs.push({ item, itemID: item.id, path: filePath, hasCache });
    }
    return pdfs;
  }

  async function findSampleRegularItems(limit = 150) {
    const libraryID = Zotero.Libraries.userLibraryID;
    const rows = await Zotero.DB.queryAsync(
      `SELECT I.itemID FROM items I
       JOIN itemTypes IT ON IT.itemTypeID = I.itemTypeID
       WHERE I.libraryID = ?
         AND IT.typeName NOT IN ('attachment', 'note', 'annotation')
         AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
       ORDER BY I.dateModified DESC
       LIMIT ?`,
      [libraryID, limit]
    );
    const ids = rows.map((r) => r.itemID);
    return Zotero.Items.getAsync(ids);
  }

  async function runSuite(plugin, onProgress) {
    const report = (msg) => {
      try {
        onProgress?.(msg);
      } catch {}
    };
    const results = [];
    const nativeReady = await plugin.nativeClient.ensureStarted();

    report("正在查找库内样本 PDF...");
    const pdfs = await findSamplePDFs(80);
    const samplePdf = pdfs.find((p) => p.hasCache) || pdfs[0] || null;

    // 1. MuPDF Native 2K HiDPI Rasterization Benchmark (Cold / Warm / Dark LUT)
    const activeRenderEngine = plugin.renderEngine || Zotero.ZotMuPDF?.engineClient || null;
    if (samplePdf && activeRenderEngine) {
      try {
        report(`正在测试 MuPDF 2K 高分屏页面渲染 (${samplePdf.item.attachmentFilename || samplePdf.itemID})...`);
        await activeRenderEngine.ensureStarted();
        activeRenderEngine.evictPath?.(samplePdf.path);
        const w = 1600;
        const h = 2260;
        const scale = w / 595.0;
        const matrix = [scale, 0, 0, scale, 0, 0];

        const tCold0 = nowMs();
        const rCold = await activeRenderEngine.renderPage("bench-cold", {
          path: samplePdf.path,
          password: "",
          pageIndex: 0,
          width: w,
          height: h,
          matrix,
          includeAnnots: false,
          aaLevel: 8,
          theme: null,
        });
        const coldMs = nowMs() - tCold0;
        if (rCold?.buf) activeRenderEngine.recycleBuffer?.(rCold.buf);

        const tDark0 = nowMs();
        const rDark = await activeRenderEngine.renderPage("bench-dark", {
          path: samplePdf.path,
          password: "",
          pageIndex: 0,
          width: w,
          height: h,
          matrix,
          includeAnnots: false,
          aaLevel: 8,
          theme: {
            background: "#1e1e1e",
            foreground: "#e5e5e5",
            invertImages: true,
          },
        });
        const darkMs = nowMs() - tDark0;
        if (rDark?.buf) activeRenderEngine.recycleBuffer?.(rDark.buf);

        results.push({
          id: "mupdf_render",
          name: "MuPDF 2K 高分屏渲染 (1600×2260)",
          baselineMs: null,
          turboMs: coldMs,
          speedup: null,
          detail: `首帧冷渲 ${coldMs.toFixed(1)} ms (原生 C ${(rCold?.renderMs || 0).toFixed(1)} ms) | 暗色 LUT 温渲 ${darkMs.toFixed(1)} ms (PDF.js 同规格通常 180–900 ms)`,
        });
      } catch (e) {
        results.push({
          id: "mupdf_render",
          name: "MuPDF 2K 高分屏渲染",
          baselineMs: null,
          turboMs: null,
          speedup: null,
          detail: "渲染引擎测试跳过: " + (e?.message || String(e)),
        });
      }
    }

    // 2 & 3. PDF Fulltext & PageData Benchmark
    if (samplePdf && nativeReady) {
      const testMaxPages = 20;
      report(`正在测试 PDF 全文提取 (样本: ${samplePdf.item.attachmentFilename || samplePdf.itemID})...`);

      const tBase0 = nowMs();
      let baseRes = null;
      try {
        baseRes = await plugin.pdfTextAccel.benchmarkOrigGetFullText(samplePdf.itemID, testMaxPages);
      } catch (e) {
        baseRes = { error: e?.message || String(e) };
      }
      const baseMs = nowMs() - tBase0;

      await plugin.nativeClient.evictPath(samplePdf.path);
      const tTurbo0 = nowMs();
      const turboRes = await plugin.nativeClient.extractFulltext(samplePdf.path, testMaxPages);
      const turboMs = nowMs() - tTurbo0;

      results.push({
        id: "pdf_fulltext",
        name: `PDF 全文提取 (${turboRes?.extractedPages || testMaxPages} 页)`,
        baselineMs: baseMs,
        turboMs,
        speedup: turboMs > 0 ? baseMs / turboMs : 0,
        detail: `${samplePdf.item.attachmentFilename || "PDF"} | 原生 ${(baseRes?.text?.length || 0).toLocaleString()} 字 vs Turbo ${(turboRes?.text?.length || 0).toLocaleString()} 字`,
      });

      const pagesN = Math.min(10, Math.max(1, turboRes?.totalPages || 1));
      report(`正在测试单页文本层提取 (${pagesN} 页)...`);
      let totalChars = 0;
      const tPage0 = nowMs();
      for (let p = 0; p < pagesN; p++) {
        const pd = await plugin.nativeClient.extractPageData(samplePdf.path, p);
        if (pd && pd.ok && pd.json) {
          try {
            const parsed = JSON.parse(pd.json);
            totalChars += parsed.c?.length || 0;
          } catch {}
        }
      }
      const pageTotalMs = nowMs() - tPage0;
      const avgPageMs = pageTotalMs / pagesN;
      results.push({
        id: "pdf_page_data",
        name: `阅读器单页文本层解析 (${pagesN} 页均值)`,
        baselineMs: null,
        turboMs: avgPageMs,
        speedup: null,
        detail: `共提取 ${totalChars.toLocaleString()} 字符坐标 + 链接，总耗时 ${pageTotalMs.toFixed(1)} ms (PDF.js 通常 30–300 ms/页)`,
      });

      // 3b. Drag-and-drop PDF metadata recognizer benchmark (getRecognizerData)
      report(`正在测试 PDF 拖入元数据识别提取 (前 5 页)...`);
      const tRecBase0 = nowMs();
      let recBasePages = 0;
      try {
        const rb = await plugin.pdfTextAccel.benchmarkOrigGetRecognizerData(samplePdf.itemID);
        recBasePages = rb?.pages?.length || 0;
      } catch {}
      const recBaseMs = nowMs() - tRecBase0;

      await plugin.nativeClient.evictPath(samplePdf.path);
      const tRecTurbo0 = nowMs();
      const recTurboRes = await plugin.nativeClient.extractRecognizerData(samplePdf.path, 5);
      const recTurboMs = nowMs() - tRecTurbo0;
      let recTurboPages = 0;
      if (recTurboRes?.ok && recTurboRes.json) {
        try {
          recTurboPages = JSON.parse(recTurboRes.json)?.pages?.length || 0;
        } catch {}
      }
      results.push({
        id: "pdf_recognizer",
        name: `PDF 拖入元数据识别提取 (${recTurboPages || recBasePages || 5} 页)`,
        baselineMs: recBaseMs,
        turboMs: recTurboMs,
        speedup: recTurboMs > 0 ? recBaseMs / recTurboMs : 0,
        detail: `拖入 PDF 自动抓取 DOI/标题/作者前处理 (原生 ${recBasePages} 页 vs Turbo ${recTurboPages} 页)`,
      });
    } else {
      results.push({
        id: "pdf_fulltext",
        name: "PDF 全文提取 & 文本层",
        baselineMs: null,
        turboMs: null,
        speedup: null,
        detail: !nativeReady ? "原生 DLL 未就绪" : "当前文献库未找到本地 PDF 附件",
      });
    }

    // 4. Parallel full-text cache file scan benchmark
    const cachedPdfs = pdfs.filter((p) => p.hasCache);
    if (cachedPdfs.length >= 3 && nativeReady) {
      const scanItems = cachedPdfs.map((p) => p.itemID);
      const probeNeedle = "the";
      report(`正在测试批量全文缓存扫描 (${scanItems.length} 篇 PDF 缓存)...`);

      const tBase0 = nowMs();
      const baseFound = await plugin.searchAccel.benchmarkOrigFindTextInItems(scanItems, probeNeedle, "phrase");
      const baseMs = nowMs() - tBase0;

      const ft = Zotero.FullText || Zotero.Fulltext;
      const paths = cachedPdfs.map((p) => ft.getItemCacheFile(p.item).path);
      const tTurbo0 = nowMs();
      const turboRes = await plugin.nativeClient.scanFiles(paths, probeNeedle, {
        caseSensitive: false,
        normalizeWhitespace: true,
        maxBytes: 500000,
      });
      const turboMs = nowMs() - tTurbo0;
      const turboMatches = turboRes?.ok ? JSON.parse(turboRes.indicesJson).length : 0;

      results.push({
        id: "parallel_scan",
        name: `批量全文缓存扫描 (${scanItems.length} 文件)`,
        baselineMs: baseMs,
        turboMs,
        speedup: turboMs > 0 ? baseMs / turboMs : 0,
        detail: `命中 ${turboMatches}/${baseFound.length} 篇 (多线程 C 扫描 vs 单线程 JS 串行 IO)`,
      });
    } else {
      results.push({
        id: "parallel_scan",
        name: "批量全文缓存扫描",
        baselineMs: null,
        turboMs: null,
        speedup: null,
        detail: `已索引缓存 PDF 不足 (${cachedPdfs.length} 篇)`,
      });
    }

    // 5. Citation CSL-JSON retrieveItem benchmark
    report("正在测试引文 CSL-JSON 批量构建...");
    const regItems = await findSampleRegularItems(150);
    if (regItems.length >= 5) {
      const rounds = 3;
      const totalCalls = regItems.length * rounds;
      const sys = new Zotero.Cite.System({ automaticJournalAbbreviations: false, uppercaseSubtitles: false });

      const tBase0 = nowMs();
      for (let r = 0; r < rounds; r++) {
        for (let i = 0; i < regItems.length; i++) {
          plugin.citeAccel.benchmarkOrigRetrieveItem(sys, regItems[i]);
        }
      }
      const baseMs = nowMs() - tBase0;

      plugin.citeAccel.clearCache();
      const tTurbo0 = nowMs();
      for (let r = 0; r < rounds; r++) {
        for (let i = 0; i < regItems.length; i++) {
          sys.retrieveItem(regItems[i]);
        }
      }
      const turboMs = nowMs() - tTurbo0;

      results.push({
        id: "cite_csl",
        name: `引文 CSL-JSON 构建 (${totalCalls} 次调用)`,
        baselineMs: baseMs,
        turboMs,
        speedup: turboMs > 0 ? baseMs / turboMs : 0,
        detail: `${regItems.length} 篇文献 × ${rounds} 轮模拟长文档引文刷新`,
      });
    } else {
      results.push({
        id: "cite_csl",
        name: "引文 CSL-JSON 构建",
        baselineMs: null,
        turboMs: null,
        speedup: null,
        detail: `常规文献条目不足 (${regItems.length} 条)`,
      });
    }

    report("全部基准测试完成！");
    return {
      timestamp: Date.now(),
      nativeReady,
      platform: plugin.nativeClient.platformKey || "native",
      results,
    };
  }

  return { runSuite };
})();
