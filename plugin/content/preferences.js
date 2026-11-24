/* global Zotero, document, window */
"use strict";

var ZotTurboPrefs = (function () {
  const MUPDF_BOOL_KEYS = ["enabled", "renderThumbnails", "softwareCanvas", "prerender"];
  const MUPDF_MENULIST_INT_KEYS = ["aaLevel"];
  const MUPDF_INT_KEYS = ["workers", "bgWorkers", "storeMB", "pixCacheMB"];
  const MUPDF_MENULIST_SCALE_KEY = "maxOutputScale";

  function setMenulistValue(el, rawVal) {
    if (!el) return;
    const val = String(rawVal);
    try {
      el.value = val;
      if (typeof el.querySelector === "function") {
        const item = el.querySelector(`menuitem[value="${val}"]`);
        if (item && "selectedItem" in el) {
          el.selectedItem = item;
        }
      }
    } catch {}
  }

  function flushAllNumberInputs() {
    const p = plugin();
    if (!p) return;
    for (const k of MUPDF_INT_KEYS) {
      const el = $(`zt-mupdf-${k}`);
      if (!el) continue;
      const val = parseInt(el.value, 10);
      if (Number.isFinite(val)) p.setMuPDFPref(k, val);
    }
    for (const k of INT_KEYS) {
      const el = $(`zt-pref-${k}`);
      if (!el) continue;
      const val = parseInt(el.value, 10);
      if (Number.isFinite(val)) p.setPref(k, val);
    }
  }

  const BOOL_KEYS = [
    "pdfFulltextEnabled",
    "batchIndexParallelEnabled",
    "pdfRecognizerEnabled",
    "readerTextLayerEnabled",
    "ctrlfAccelEnabled",
    "readerOutlineEnabled",
    "pdfjsCleanupEnabled",
    "tabHibernateEnabled",
    "startupSelectLibraryTab",
    "startupHibernateBackgroundTabs",
    "tabHibernateNotes",
    "autoBackgroundSlimEnabled",
    "searchNativeScanEnabled",
    "searchCacheEnabled",
    "citeCacheEnabled",
    "citeUseCiteprocRs",
    "sqliteTuneEnabled",
    "noteWebpEnabled",
    "itemSelectCoalesceEnabled",
  ];

  const INT_KEYS = [
    "processedDataDelayMs",
    "processedDataMaxPages",
    "tabHibernateMaxLoaded",
    "tabHibernateIdleMin",
    "autoBackgroundSlimMin",
    "sqliteCacheMB",
    "sqliteMmapMB",
    "noteWebpQuality",
    "noteWebpMinKB",
    "noteWebpMaxDim",
    "itemSelectDebounceMs",
    "itemTreeOverscan",
  ];

  let refreshTimer = null;
  let bound = false;

  function plugin() {
    return Zotero.ZotTurbo || null;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setToast(msg) {
    const el = $("zt-save-toast");
    if (el) el.textContent = msg;
  }

  function loadFormValues() {
    const p = plugin();
    if (!p) return;

    for (const k of MUPDF_BOOL_KEYS) {
      const el = $(`zt-mupdf-${k}`);
      if (el) el.checked = !!p.getMuPDFPref(k);
    }
    for (const k of MUPDF_MENULIST_INT_KEYS) {
      setMenulistValue($(`zt-mupdf-${k}`), p.getMuPDFPref(k));
    }
    for (const k of MUPDF_INT_KEYS) {
      const el = $(`zt-mupdf-${k}`);
      if (el) el.value = String(p.getMuPDFPref(k));
    }
    {
      const scaleVal = String(p.getMuPDFPref(MUPDF_MENULIST_SCALE_KEY) || "");
      setMenulistValue($(`zt-mupdf-${MUPDF_MENULIST_SCALE_KEY}`), scaleVal || "native");
    }

    for (const k of BOOL_KEYS) {
      const el = $(`zt-pref-${k}`);
      if (el) el.checked = !!p.getPref(k);
    }
    for (const k of INT_KEYS) {
      const el = $(`zt-pref-${k}`);
      if (el) el.value = String(p.getPref(k));
    }
  }

  function refreshStats() {
    const p = plugin();
    if (!p) return;
    const s = p.getSummary();

    const banner = $("zt-conflict-banner");
    if (banner) {
      banner.style.display = s.standaloneMuPDFDetected ? "block" : "none";
    }

    const badge = $("zt-badge-status");
    if (badge) {
      if (s.nativeAvailable) {
        badge.textContent = `v${s.version} · 单 DLL 原生 MuPDF ${s.render?.mupdfVersion || "1.28.0"} 就绪 (${s.platformKey || "native"})`;
        badge.className = "zt-badge zt-badge-ok";
      } else if (s.standby) {
        badge.textContent = `v${s.version} · 单 DLL 原生 MuPDF 按需待机 (${s.platformKey || "native"})`;
        badge.className = "zt-badge zt-badge-ok";
      } else {
        badge.textContent = `v${s.version} · 兼容模式`;
        badge.className = "zt-badge zt-badge-warn";
      }
    }

    const elRender = $("zt-stat-render");
    if (elRender) {
      const r = s.render;
      if (s.standaloneMuPDFDetected) {
        elRender.textContent = "由旧版独立 MuPDF Engine 接管 (建议卸载旧版启用合一引擎)";
      } else if (!r) {
        elRender.textContent = "未初始化";
      } else if (!r.enabled) {
        elRender.textContent = "已关闭 (当前回退 PDF.js)";
      } else if (!r.ready && r.lastError) {
        elRender.textContent = `引擎异常: ${r.lastError}`;
      } else {
        const avg = Number(r.avgRenderMs || 0).toFixed(1);
        const mainN = Number(r.totalRenders || 0);
        const thumbN = Number(r.thumbCount || 0);
        const total = mainN + thumbN;
        const hitRate = mainN > 0 ? Math.round(((r.pixHits || 0) + (r.dlHits || 0)) * 100 / mainN) : 0;
        const fgW = Number(r.fgWorkers || 0);
        const bgW = Math.max(0, Number(r.workers || 0) - fgW);
        if (!r.ready && total === 0) {
          elRender.textContent = "按需待机（打开 PDF 时秒启，纯文献库零常驻内存）";
        } else {
          const stateLabel = r.ready ? "已就绪" : "已自动休眠";
          elRender.textContent = `${stateLabel} · 累计渲染 ${total} 帧 (主页 ${mainN} / 缩略图 ${thumbN}) · 均耗 ${avg} ms · 缓存命中 ${hitRate}% · 线程 ${fgW}+${bgW}`;
        }
      }
    }

    const elMem = $("zt-stat-memory");
    if (elMem) {
      const m = s.system.memory || {};
      const cleanN = s.pdfText.pdfjsCleanups || 0;
      if (m.ok) {
        const heapStr = m.heapMB > 0 ? ` · JS/C++ 堆 ${m.heapMB.toFixed(0)} MB` : "";
        elMem.textContent = `主进程常驻 RSS ${m.residentMB.toFixed(0)} MB${heapStr} · PDF.js Worker 已清理 ${cleanN} 次`;
      } else {
        elMem.textContent = `PDF.js Worker 已清理 ${cleanN} 次`;
      }
    }

    const elPdf = $("zt-stat-pdf");
    if (elPdf) {
      const ft = s.pdfText;
      const cf = ft.ctrlfPages ? ` · Ctrl+F ${ft.ctrlfPages}页` : "";
      const bp = ft.batchPrefetchHits ? ` (预取 ${ft.batchPrefetchHits})` : "";
      elPdf.textContent = `全文 ${ft.fulltextNativeCount} 次${bp} | 识别 ${ft.recognizerNativeCount || 0} 次 | 文本 ${ft.readerPageHits} 页${cf} | 目录 ${ft.outlineHits || 0} 次`;
    }

    const elTabs = $("zt-stat-tabs");
    if (elTabs) {
      const t = s.tabs;
      const slimStr = t.autoSlimCount ? ` · 静默瘦身 ${t.autoSlimCount} 次` : "";
      elTabs.textContent = `${t.activeReaders} 活跃 / ${t.hibernatedTabs} 休眠 (累计 ${t.totalHibernated} 次${slimStr})`;
    }

    const elSearch = $("zt-stat-search");
    if (elSearch) {
      const sc = s.search;
      elSearch.textContent = `扫描 ${sc.nativeFilesScanned} 文件 (${sc.avgNativeScanMs.toFixed(1)}ms) | 命中率 ${sc.cacheHitRate.toFixed(0)}%`;
    }

    const elCite = $("zt-stat-cite");
    if (elCite) {
      const c = s.cite;
      const eng = c.citeprocRsActive ? "citeproc-rs" : "citeproc-js";
      elCite.textContent = `缓存 ${c.cslCacheSize} 项 (${c.cslHitRate.toFixed(0)}%) | ${eng}`;
    }

    const elSql = $("zt-stat-sqlite");
    if (elSql) {
      const sq = s.system.sqliteInfo || {};
      const dbStr = sq.mainSizeMB ? ` | 主库 ${sq.mainSizeMB.toFixed(1)}MB` : "";
      const walStr = sq.walMB > 0.1 ? ` | WAL ${sq.walMB.toFixed(1)}MB` : "";
      const wasteStr = sq.mainWastePct > 1 ? ` (空洞 ${sq.mainWastePct.toFixed(0)}%)` : "";
      elSql.textContent = `Cache ${sq.cacheMB || "-"}M / MMap ${sq.mmapMB ?? "-"}M${dbStr}${walStr}${wasteStr}`;
    }

    const elWebp = $("zt-stat-webp");
    if (elWebp) {
      const sy = s.system;
      elWebp.textContent = `${sy.webpCompressedCount} 张 (省 ${sy.webpSavedMB.toFixed(2)} MB / ${sy.webpSavedRatio.toFixed(0)}%)`;
    }

    const elUi = $("zt-stat-ui");
    if (elUi && s.ui) {
      const u = s.ui;
      const modeStr = u.coalesceEnabled ? `防抖 ${u.debounceMs}ms` : "已关闭";
      elUi.textContent = `已拦截冗余重绘 ${u.coalescedSelections || 0} 次 (即时 ${u.immediateSelections || 0} 次 · ${modeStr}) · 列表预渲 ${u.activeOverscan || u.overscan} 行`;
    }
  }

  function renderBenchTable(report) {
    const wrap = $("zt-bench-results");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    const NS = "http://www.w3.org/1999/xhtml";
    const table = document.createElementNS(NS, "table");
    table.className = "zt-bench-table";

    const thead = document.createElementNS(NS, "thead");
    const hr = document.createElementNS(NS, "tr");
    for (const h of ["测试项", "Zotero 原生", "Zotero Turbo", "加速比", "说明"]) {
      const th = document.createElementNS(NS, "th");
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElementNS(NS, "tbody");
    for (const r of report.results || []) {
      const tr = document.createElementNS(NS, "tr");

      const tdName = document.createElementNS(NS, "td");
      tdName.textContent = r.name;
      tr.appendChild(tdName);

      const tdBase = document.createElementNS(NS, "td");
      tdBase.textContent = typeof r.baselineMs === "number" ? `${r.baselineMs.toFixed(1)} ms` : "-";
      tr.appendChild(tdBase);

      const tdTurbo = document.createElementNS(NS, "td");
      tdTurbo.textContent = typeof r.turboMs === "number" ? `${r.turboMs.toFixed(2)} ms` : "-";
      tr.appendChild(tdTurbo);

      const tdSp = document.createElementNS(NS, "td");
      if (typeof r.speedup === "number" && r.speedup > 0) {
        tdSp.textContent = `${r.speedup.toFixed(1)}×`;
        tdSp.className = "zt-speedup";
      } else {
        tdSp.textContent = "-";
      }
      tr.appendChild(tdSp);

      const tdDet = document.createElementNS(NS, "td");
      tdDet.textContent = r.detail || "";
      tr.appendChild(tdDet);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function renderHealthAudit(report) {
    const wrap = $("zt-audit-results");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    const NS = "http://www.w3.org/1999/xhtml";

    if (report.hints && report.hints.length > 0) {
      const ul = document.createElementNS(NS, "div");
      ul.className = "zt-hint";
      ul.style.marginBottom = "8px";
      ul.textContent = "诊断建议：" + report.hints.join(" ");
      wrap.appendChild(ul);
    }

    if (report.largeDataFiles && report.largeDataFiles.length > 0) {
      const t1 = document.createElementNS(NS, "table");
      t1.className = "zt-bench-table";
      const thRow = document.createElementNS(NS, "tr");
      for (const h of ["数据目录大文件 (≥1 MB)", "体积", "类别", "诊断说明"]) {
        const th = document.createElementNS(NS, "th");
        th.textContent = h;
        thRow.appendChild(th);
      }
      const thead = document.createElementNS(NS, "thead");
      thead.appendChild(thRow);
      t1.appendChild(thead);
      const tb = document.createElementNS(NS, "tbody");
      for (const f of report.largeDataFiles) {
        const tr = document.createElementNS(NS, "tr");
        for (const val of [f.name, `${f.sizeMB.toFixed(2)} MB`, f.category, f.note || "-"]) {
          const td = document.createElementNS(NS, "td");
          td.textContent = val;
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      t1.appendChild(tb);
      wrap.appendChild(t1);
    }

    if (report.addons && report.addons.length > 0) {
      const t2 = document.createElementNS(NS, "table");
      t2.className = "zt-bench-table";
      t2.style.marginTop = "10px";
      const thRow = document.createElementNS(NS, "tr");
      for (const h of ["已安装插件", "状态", "版本", "XPI 体积"]) {
        const th = document.createElementNS(NS, "th");
        th.textContent = h;
        thRow.appendChild(th);
      }
      const thead = document.createElementNS(NS, "thead");
      thead.appendChild(thRow);
      t2.appendChild(thead);
      const tb = document.createElementNS(NS, "tbody");
      for (const a of report.addons.slice(0, 12)) {
        const tr = document.createElementNS(NS, "tr");
        const sz = a.sizeKB >= 1024 ? `${(a.sizeKB / 1024).toFixed(2)} MB` : a.sizeKB > 0 ? `${a.sizeKB.toFixed(0)} KB` : "-";
        for (const val of [a.name, a.active ? "启用" : "已禁用", a.version || "-", sz]) {
          const td = document.createElementNS(NS, "td");
          td.textContent = val;
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      t2.appendChild(tb);
      wrap.appendChild(t2);
    }
  }

  function bindEvents() {
    if (bound) return;
    bound = true;

    // MuPDF Render controls
    for (const k of MUPDF_BOOL_KEYS) {
      const el = $(`zt-mupdf-${k}`);
      if (!el) continue;
      el.addEventListener("change", () => {
        const p = plugin();
        if (!p) return;
        p.setMuPDFPref(k, !!el.checked);
        if (k === "enabled") {
          p.renderEngine?.setEnabled?.(!!el.checked);
          p.renderHook?.refreshAllViewers?.(true);
        } else if (k === "renderThumbnails" || k === "softwareCanvas") {
          p.renderHook?.refreshAllViewers?.(true);
        }
        setToast(`已更新 MuPDF 渲染设置: ${k}`);
        refreshStats();
      });
    }

    for (const k of MUPDF_MENULIST_INT_KEYS) {
      const el = $(`zt-mupdf-${k}`);
      if (!el) continue;
      const onSelect = () => {
        const p = plugin();
        if (!p) return;
        const val = parseInt(el.value, 10);
        if (Number.isFinite(val)) {
          p.setMuPDFPref(k, val);
          p.renderHook?.refreshAllViewers?.(true);
          setToast(`抗锯齿等级已更新为 ${val}`);
        }
      };
      el.addEventListener("command", onSelect);
      el.addEventListener("change", onSelect);
    }

    for (const k of MUPDF_INT_KEYS) {
      const el = $(`zt-mupdf-${k}`);
      if (!el) continue;
      el.addEventListener("change", () => {
        const p = plugin();
        if (!p) return;
        const val = parseInt(el.value, 10);
        if (Number.isFinite(val)) {
          p.setMuPDFPref(k, val);
          setToast(`已保存 ${k} = ${val}，点击「热重载渲染引擎」或「应用全部参数」立即生效`);
        }
      });
    }

    {
      const el = $(`zt-mupdf-${MUPDF_MENULIST_SCALE_KEY}`);
      if (el) {
        const onScaleSelect = () => {
          const p = plugin();
          if (!p) return;
          const raw = String(el.value || "native");
          const stored = raw === "native" ? "" : raw;
          p.setMuPDFPref(MUPDF_MENULIST_SCALE_KEY, stored);
          p.renderHook?.refreshAllViewers?.(true);
          setToast(`DPR 上限已更新为 ${stored ? stored + "×" : "原生满分辨率"}`);
        };
        el.addEventListener("command", onScaleSelect);
        el.addEventListener("change", onScaleSelect);
      }
    }

    // Turbo 5 modules controls
    for (const k of BOOL_KEYS) {
      const el = $(`zt-pref-${k}`);
      if (!el) continue;
      el.addEventListener("change", async () => {
        const p = plugin();
        if (!p) return;
        p.setPref(k, !!el.checked);
        if (k === "citeUseCiteprocRs") {
          const ok = await p.citeAccel.applyCiteprocRsPref();
          setToast(ok ? "已启用 Rust citeproc-rs (WASM) 引擎" : "已切回 citeproc-js 引擎");
        } else if (k === "sqliteTuneEnabled") {
          await p.systemAccel.applySQLitePragmas();
          setToast(el.checked ? "已应用 SQLite 高性能参数" : "已恢复 Zotero 默认 SQLite 参数");
        } else if (k === "tabHibernateEnabled" && el.checked) {
          p.tabHibernator.sweepAllWindows({ reason: "pref-enable" });
          setToast("已启用智能标签休眠");
        } else {
          setToast(`已更新设置: ${k}`);
        }
        refreshStats();
      });
    }

    for (const k of INT_KEYS) {
      const el = $(`zt-pref-${k}`);
      if (!el) continue;
      el.addEventListener("change", () => {
        const p = plugin();
        if (!p) return;
        const val = parseInt(el.value, 10);
        if (Number.isFinite(val)) {
          p.setPref(k, val);
          if (k === "itemTreeOverscan" || k === "itemSelectDebounceMs") {
            p.uiAccel?.applySettings?.();
          }
          setToast(`已保存数值: ${k} = ${val}`);
        }
      });
    }

    $("zt-btn-refresh")?.addEventListener("click", async () => {
      try {
        await plugin()?.systemAccel?.refreshSQLiteInfo?.();
        refreshStats();
        setToast("统计已刷新");
      } catch (err) {
        setToast("刷新失败: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-deep-reclaim")?.addEventListener("click", async () => {
      try {
        setToast("正在休眠后台标签、裁剪离屏画布、压缩 SQLite/MuPDF 堆并回落系统工作集...");
        const res = await plugin()?.deepReclaimMemory?.();
        refreshStats();
        if (res && res.beforeMB > 0) {
          const extras = [];
          if (res.hibernatedTabs > 0) extras.push(`休眠 ${res.hibernatedTabs} 个后台标签`);
          if (res.trimmedReaders > 0) extras.push(`裁剪 ${res.trimmedReaders} 个阅读器画布缓冲`);
          if (res.cleanedWorkers > 0) extras.push(`清理 ${res.cleanedWorkers} 个 Worker`);
          const extraStr = extras.length > 0 ? `，${extras.join("、")}` : "";
          setToast(
            `深度释放完成：RSS ${res.beforeMB.toFixed(0)} MB → ${res.afterMB.toFixed(0)} MB (回收 ${res.freedMB.toFixed(0)} MB${extraStr})`
          );
        } else {
          setToast(`深度释放完成（休眠 ${res?.hibernatedTabs || 0} 标签 / 裁剪 ${res?.trimmedReaders || 0} 阅读器 / 清理 ${res?.cleanedWorkers || 0} Worker）`);
        }
      } catch (err) {
        setToast("深度释放失败: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-trim-render")?.addEventListener("click", async () => {
      try {
        await plugin()?.trimRenderCache?.();
        refreshStats();
        setToast("已释放 MuPDF 渲染与文本原生缓存");
      } catch (err) {
        setToast("释放缓存失败: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-restart-render")?.addEventListener("click", async () => {
      const p = plugin();
      if (!p) return;
      if (p.standaloneMuPDFDetected) {
        setToast("请先卸载旧版独立 MuPDF Engine 插件并重启 Zotero");
        return;
      }
      try {
        flushAllNumberInputs();
        setToast("正在热重载 MuPDF 渲染引擎...");
        await p.restartRenderEngine();
        refreshStats();
        setToast("MuPDF 渲染引擎热重载完成");
      } catch (err) {
        setToast("热重载失败: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-hibernate-now")?.addEventListener("click", () => {
      try {
        const n = plugin()?.tabHibernator?.hibernateAllBackground?.({ includeNotes: false }) || 0;
        refreshStats();
        setToast(n > 0 ? `已立即休眠 ${n} 个后台 PDF 标签页并释放 MuPDF/Gecko 内存` : "当前没有可休眠的后台阅读标签页");
      } catch (err) {
        setToast("休眠失败: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-optimize-db")?.addEventListener("click", async () => {
      try {
        setToast("正在优化 SQLite 索引、合并 FTS5 碎片并截断 WAL...");
        const res = await plugin()?.systemAccel?.runIdleOptimize?.({ truncateWal: true, mergeFts5: true });
        refreshStats();
        const ftsNote = res?.fts5Merged > 0 ? `，合并 ${res.fts5Merged} 张 FTS5 索引表` : "";
        setToast(res?.ok ? `SQLite 优化与 WAL 截断完成${ftsNote} (${res.ms} ms)` : "SQLite 优化失败");
      } catch (err) {
        setToast("SQLite 优化出错: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-vacuum-db")?.addEventListener("click", async () => {
      const p = plugin();
      const btn = $("zt-btn-vacuum-db");
      if (!p || !btn) return;
      btn.disabled = true;
      try {
        setToast("正在执行原子安全 VACUUM 紧缩主数据库（如有并发写入会自动安全中止）...");
        const res = await p.runVacuum();
        refreshStats();
        if (res?.ok && res.performed) {
          setToast(
            `数据库紧缩完成 (${res.ms} ms)：${res.beforeMB.toFixed(1)} MB → ${res.afterMB.toFixed(1)} MB (回收 ${res.freedMB.toFixed(1)} MB)`
          );
        } else if (res?.ok) {
          setToast("数据库当前无需紧缩或因后台写入安全跳过");
        } else {
          setToast("数据库紧缩未执行: " + (res?.error || "未知原因"));
        }
      } catch (err) {
        setToast("数据库紧缩出错: " + (err?.message || String(err)));
      } finally {
        btn.disabled = false;
      }
    });

    $("zt-btn-scan-note-png")?.addEventListener("click", async () => {
      const p = plugin();
      const scanBtn = $("zt-btn-scan-note-png");
      const goBtn = $("zt-btn-compress-note-png");
      const statusEl = $("zt-note-webp-status");
      if (!p || !scanBtn) return;
      flushAllNumberInputs();
      scanBtn.disabled = true;
      if (goBtn) goBtn.disabled = true;
      try {
        if (statusEl) statusEl.textContent = "正在只读扫描库内历史笔记 PNG/BMP 截图...";
        const res = await p.scanLegacyNoteImages();
        if (res.count > 0) {
          if (statusEl) {
            statusEl.textContent = `发现 ${res.count} 张可瘦身的历史笔记截图 (≥${res.minKB} KB，共 ${res.totalMB.toFixed(2)} MB)，点击「确认批量转 WebP」开始无损结构转换。`;
          }
          if (goBtn) goBtn.disabled = false;
        } else if (statusEl) {
          statusEl.textContent = `未发现 ≥${res.minKB} KB 的历史 PNG/BMP 笔记截图，无需转换。`;
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = "扫描失败: " + (err?.message || String(err));
      } finally {
        scanBtn.disabled = false;
      }
    });

    $("zt-btn-compress-note-png")?.addEventListener("click", async () => {
      const p = plugin();
      const scanBtn = $("zt-btn-scan-note-png");
      const goBtn = $("zt-btn-compress-note-png");
      const statusEl = $("zt-note-webp-status");
      if (!p || !goBtn) return;
      flushAllNumberInputs();
      goBtn.disabled = true;
      if (scanBtn) scanBtn.disabled = true;
      try {
        if (statusEl) statusEl.textContent = "正在批量转换历史笔记截图为 WebP...";
        const res = await p.compressLegacyNoteImages(({ done, total, converted, savedMB }) => {
          if (statusEl) {
            statusEl.textContent = `转换中 ${done}/${total}（已转 ${converted} 张，已省 ${savedMB.toFixed(2)} MB）...`;
          }
        });
        refreshStats();
        if (statusEl) {
          statusEl.textContent = res.ok
            ? `批量瘦身完成：转换 ${res.converted} 张，跳过 ${res.skipped} 张，失败 ${res.failed} 张，共节省 ${res.savedMB.toFixed(2)} MB。`
            : "批量转换失败: " + (res.error || "");
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = "批量转换出错: " + (err?.message || String(err));
      } finally {
        if (scanBtn) scanBtn.disabled = false;
      }
    });

    $("zt-btn-clear-cache")?.addEventListener("click", async () => {
      try {
        await plugin()?.clearAllCaches?.();
        refreshStats();
        setToast("已清空搜索/引文缓存并释放全部原生内存");
      } catch (err) {
        setToast("清空缓存失败: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-apply-all")?.addEventListener("click", async () => {
      const p = plugin();
      if (!p) return;
      try {
        flushAllNumberInputs();
        setToast("正在应用全部参数...");
        await p.systemAccel.applySQLitePragmas();
        p.tabHibernator.sweepAllWindows({ reason: "apply-btn" });
        p.uiAccel?.applySettings?.();
        if (p.renderEngine) {
          await p.restartRenderEngine();
        }
        refreshStats();
        setToast("已应用全部渲染、UI、SQLite 与标签休眠设置");
      } catch (err) {
        setToast("应用参数出错: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-reset")?.addEventListener("click", async () => {
      const p = plugin();
      if (!p) return;
      try {
        p.resetAllPrefs();
        loadFormValues();
        await p.systemAccel.applySQLitePragmas();
        await p.citeAccel.applyCiteprocRsPref();
        p.uiAccel?.applySettings?.();
        if (p.renderEngine) {
          await p.restartRenderEngine();
        }
        refreshStats();
        setToast("已恢复全部默认设置并重载引擎");
      } catch (err) {
        setToast("恢复默认失败: " + (err?.message || String(err)));
      }
    });

    $("zt-btn-benchmark")?.addEventListener("click", async () => {
      const p = plugin();
      const btn = $("zt-btn-benchmark");
      const statusEl = $("zt-bench-status");
      if (!p || !btn) return;
      btn.disabled = true;
      try {
        const report = await p.runBenchmark((msg) => {
          if (statusEl) statusEl.textContent = msg;
        });
        renderBenchTable(report);
        if (statusEl) {
          statusEl.textContent = `实测完成 (${new Date(report.timestamp).toLocaleTimeString()}) · 平台: ${report.platform}`;
        }
        refreshStats();
      } catch (err) {
        if (statusEl) statusEl.textContent = "基准测试出错: " + (err?.message || String(err));
      } finally {
        btn.disabled = false;
      }
    });

    $("zt-btn-health-audit")?.addEventListener("click", async () => {
      const p = plugin();
      const btn = $("zt-btn-health-audit");
      const statusEl = $("zt-audit-status");
      if (!p || !btn) return;
      btn.disabled = true;
      try {
        if (statusEl) statusEl.textContent = "正在扫描数据目录与已安装扩展...";
        const report = await p.runHealthAudit();
        renderHealthAudit(report);
        if (statusEl) {
          statusEl.textContent = `体检完成 (${new Date(report.timestamp).toLocaleTimeString()}) · 数据目录: ${report.dataDir || "-"}`;
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = "体检出错: " + (err?.message || String(err));
      } finally {
        btn.disabled = false;
      }
    });

    $("zt-btn-reveal-datadir")?.addEventListener("click", () => {
      const ok = plugin()?.revealDataDir?.();
      setToast(ok ? "已在文件管理器中打开 Zotero 数据目录" : "无法打开数据目录");
    });
  }

  function init() {
    try {
      loadFormValues();
    } catch (e) {
      Zotero.logError(e);
    }
    try {
      bindEvents();
    } catch (e) {
      Zotero.logError(e);
    }
    try {
      refreshStats();
      plugin()?.systemAccel?.refreshSQLiteInfo?.().then(() => refreshStats()).catch(() => {});
    } catch (e) {
      Zotero.logError(e);
    }

    const pane = $("zot-turbo-prefpane");
    if (pane && !pane.__zotTurboShowingBound) {
      pane.__zotTurboShowingBound = true;
      pane.addEventListener("showing", () => {
        try {
          loadFormValues();
          refreshStats();
          plugin()?.systemAccel?.refreshSQLiteInfo?.().then(() => refreshStats()).catch(() => {});
        } catch {}
      });
    }

    if (!refreshTimer) {
      refreshTimer = window.setInterval(() => {
        try {
          refreshStats();
        } catch {}
      }, 2500);
      window.addEventListener(
        "unload",
        () => {
          if (refreshTimer) {
            window.clearInterval(refreshTimer);
            refreshTimer = null;
          }
        },
        { once: true }
      );
    }
  }

  return { init };
})();

// Required in Zotero 10: pane scripts execute in a Cu.Sandbox(window), while XUL onload="..." runs on window!
window.ZotTurboPrefs = ZotTurboPrefs;
if (typeof document !== "undefined" && document.getElementById("zot-turbo-prefpane")) {
  window.setTimeout(() => window.ZotTurboPrefs.init(), 0);
}
