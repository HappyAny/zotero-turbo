/* Page-context script injected into Zotero's pdf/web/viewer.html iframe.
 * 1. Accelerates PDFDocumentProxy.prototype.getPageData using native MuPDF fz_stext (< 5ms/page)
 * 2. Accelerates PDFDocumentProxy.prototype.getOutline2 using native MuPDF fz_load_outline (< 0.5ms)
 * 3. Defers heavy getProcessedData() until reader settles idle (preserving 100% citation popups by default)
 *    and automatically calls pdfDocument.cleanup(false) to purge redundant PDF.js Worker heap memory!
 */
(function initZotTurboTextPatch() {
  "use strict";

  if (window.__zotTurboTextPatched) return;
  window.__zotTurboTextPatched = true;

  const bridge = window.__zotTurboTextBridge;
  if (!bridge) return;

  let patchedDocProto = null;
  let origGetPageData = null;
  let wrappedGetPageData = null;
  let origGetOutline2 = null;
  let wrappedGetOutline2 = null;
  let origGetProcessedData = null;
  let wrappedGetProcessedData = null;
  let retryTimer = null;
  let idleCleanupTimer = null;
  let retryCount = 0;

  // Ctrl+F sequential sweep detector + parallel lookahead prefetch queue
  let lastSeqPage = -10;
  let lastSeqDoneAt = 0;
  let seqStreak = 0;
  let zeroOriginConfirmed = false;
  const prefetchMap = new Map(); // pageIndex -> Promise<nativeRes>
  const PREFETCH_AHEAD = 6;
  const PREFETCH_MAX_MAP = 12;

  function resetSweepState() {
    lastSeqPage = -10;
    lastSeqDoneAt = 0;
    seqStreak = 0;
    zeroOriginConfirmed = false;
    prefetchMap.clear();
  }

  function prefetchPage(pageIndex, numPages) {
    if (pageIndex < 0 || (numPages > 0 && pageIndex >= numPages)) return;
    if (prefetchMap.has(pageIndex)) return;
    if (prefetchMap.size >= PREFETCH_MAX_MAP) {
      const oldest = prefetchMap.keys().next().value;
      prefetchMap.delete(oldest);
    }
    const p = Promise.resolve(bridge.requestPageData(pageIndex)).catch(() => ({ ok: false }));
    prefetchMap.set(pageIndex, p);
  }

  const ASCII_CHARS = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));
  const SPECIALS = Object.assign(Object.create(null), {
    "e\u0301": "é", "a\u0301": "á", "i\u0301": "í", "o\u0301": "ó", "u\u0301": "ú",
    "e\u0300": "è", "a\u0300": "à", "i\u0300": "ì", "o\u0300": "ò", "u\u0300": "ù",
    "e\u0302": "ê", "a\u0302": "â", "i\u0302": "î", "o\u0302": "ô", "u\u0302": "û",
    "e\u0308": "ë", "a\u0308": "ä", "i\u0308": "ï", "o\u0308": "ö", "u\u0308": "ü",
    "c\u0327": "ç", "n\u0303": "ñ",
  });

  function normalizeChar(ch) {
    if (!ch) return ch;
    if (ch.length === 1 && ch.charCodeAt(0) < 128) return ch;
    const nfkd = ch.normalize("NFKD");
    return SPECIALS[nfkd] || nfkd;
  }

  function makeSortIndex(pageIndex, offset) {
    return `${String(pageIndex).padStart(5, "0")}|${String(offset).padStart(6, "0")}|00000`;
  }

  function convertCompactToZoteroPageData(raw, viewBox, pageIndex) {
    const [vx0, vy0, vx1, vy1] = viewBox;
    const [bx0, by0, bx1, by1] = raw.b;
    const vw = vx1 - vx0;
    const vh = vy1 - vy0;
    const bw = bx1 - bx0;
    const bh = by1 - by0;
    if (Math.abs(vw - bw) > 2.5 || Math.abs(vh - bh) > 2.5) {
      return null;
    }

    const fonts = raw.f || [];
    const rawChars = raw.c || [];
    const chars = new Array(rawChars.length);
    const ox = vx0 - bx0;
    const oy = vy1 + by0;

    for (let i = 0; i < rawChars.length; i++) {
      const t = rawChars[i];
      const cp = t[0];
      const u = cp < 128 ? ASCII_CHARS[cp] : String.fromCodePoint(cp);
      const c = cp < 128 ? u : normalizeChar(u);
      const rx0 = ox + t[1];
      const ry0 = oy - t[4];
      const rx1 = ox + t[3];
      const ry1 = oy - t[2];
      const lx0 = ox + t[5];
      const ly0 = oy - t[8];
      const lx1 = ox + t[7];
      const ly1 = oy - t[6];
      const flags = t[11];

      const obj = {
        c,
        u,
        rect: [rx0 <= rx1 ? rx0 : rx1, ry0 <= ry1 ? ry0 : ry1, rx0 >= rx1 ? rx0 : rx1, ry0 >= ry1 ? ry0 : ry1],
        inlineRect: [lx0 <= lx1 ? lx0 : lx1, ly0 <= ly1 ? ly0 : ly1, lx0 >= lx1 ? lx0 : lx1, ly0 >= ly1 ? ly0 : ly1],
        fontSize: t[9],
        fontName: fonts[t[10]] || "",
        bold: (flags & 1) !== 0,
        italic: (flags & 2) !== 0,
        rotation: t[12] || 0,
        pageIndex,
        offset: i,
      };
      if (flags & 4) obj.spaceAfter = true;
      if (flags & 8) obj.wordBreakAfter = true;
      if (flags & 16) {
        obj.lineBreakAfter = true;
        obj.wordBreakAfter = true;
      }
      if (flags & 32) obj.paragraphBreakAfter = true;
      if (flags & 64) obj.ignorable = true;
      chars[i] = obj;
    }

    if (chars.length > 0) {
      const last = chars[chars.length - 1];
      last.wordBreakAfter = true;
      last.lineBreakAfter = true;
      last.paragraphBreakAfter = true;
    }

    const overlays = [];
    const rawLinks = raw.l || [];
    for (let i = 0; i < rawLinks.length; i++) {
      const l = rawLinks[i];
      const isExt = l[0] === 1;
      const rect = [vx0 + (l[1] - bx0), vy1 - (l[4] - by0), vx0 + (l[3] - bx0), vy1 - (l[2] - by0)];
      if (isExt && l[5]) {
        overlays.push({
          source: "annotation",
          sortIndex: makeSortIndex(pageIndex, i),
          type: "external-link",
          url: l[5],
          position: { pageIndex, rects: [rect] },
        });
      } else if (!isExt && l[6] >= 0) {
        const destPage = l[6];
        overlays.push({
          source: "annotation",
          sortIndex: makeSortIndex(pageIndex, i),
          type: "internal-link",
          destinationPosition: { pageIndex: destPage },
          position: { pageIndex, rects: [rect] },
        });
      }
    }

    return {
      partial: true,
      chars,
      overlays,
      viewBox: viewBox.slice(),
    };
  }

  function runPdfjsCleanup(pdfDoc) {
    try {
      if (!pdfDoc || typeof pdfDoc.cleanup !== "function") return;
      if (typeof bridge.isPdfjsCleanupEnabled === "function" && !bridge.isPdfjsCleanupEnabled()) return;
      // Pass keepLoadedFonts=true so active tab fonts stay intact while freeing heavy decoded streams/images
      Promise.resolve(pdfDoc.cleanup(true))
        .then(() => {
          try {
            bridge.reportPdfjsCleanup?.();
          } catch {}
        })
        .catch(() => {});
    } catch {}
  }

  function scheduleIdleCleanup(pdfDoc, delayMs = 4500) {
    if (idleCleanupTimer) {
      clearTimeout(idleCleanupTimer);
      idleCleanupTimer = null;
    }
    idleCleanupTimer = setTimeout(() => {
      idleCleanupTimer = null;
      runPdfjsCleanup(pdfDoc);
    }, delayMs);
  }

  function patchDocProto(pdfDoc) {
    if (!pdfDoc) return false;
    const proto = Object.getPrototypeOf(pdfDoc);
    if (!proto || typeof proto.getPageData !== "function") return false;
    if (patchedDocProto === proto) return true;

    patchedDocProto = proto;

    // 1. Native getPageData (with Ctrl+F sequential sweep detection + 3-worker parallel lookahead!)
    origGetPageData = proto.getPageData;
    const capturedGetPageData = origGetPageData;
    wrappedGetPageData = async function zotTurboGetPageData(data) {
      if (!bridge.isEnabled() || !data || typeof data.pageIndex !== "number") {
        return capturedGetPageData.call(this, data);
      }
      const pageIndex = data.pageIndex;
      const numPages = Number(this.numPages) || 0;
      const ctrlfEnabled = typeof bridge.isCtrlFAccelEnabled === "function" ? bridge.isCtrlFAccelEnabled() : true;
      const now = Date.now();

      // FindController._extractText() loops 0..N with setTimeout(0) (~1-20ms gap between pages).
      // Normal human page-by-page scrolling has a much larger gap, so require rapid sequential timing.
      if (pageIndex === lastSeqPage + 1 && (lastSeqDoneAt === 0 || now - lastSeqDoneAt < 180)) {
        seqStreak++;
      } else {
        seqStreak = 0;
      }
      lastSeqPage = pageIndex;
      const isCtrlFSweep = ctrlfEnabled && seqStreak >= 2;

      if (isCtrlFSweep) {
        for (let k = 1; k <= PREFETCH_AHEAD; k++) {
          prefetchPage(pageIndex + k, numPages);
        }
      }

      try {
        const resPromise = prefetchMap.has(pageIndex)
          ? prefetchMap.get(pageIndex)
          : bridge.requestPageData(pageIndex);
        prefetchMap.delete(pageIndex);

        // Reuse already-loaded PDFPageProxy if viewer has it in memory (0ms, 0 Worker IPC, exact rotate/view).
        // Otherwise during a rapid offscreen Ctrl+F sweep after page 0 confirmed [0,0,W,H], skip getPage()
        // so searching a 300-page book never wakes PDF.js Worker to decode 300 pages into heap.
        const existingPdfPage = window.PDFViewerApplication?.pdfViewer?._pages?.[pageIndex]?.pdfPage || null;
        let viewBox = null;
        let res = null;
        if (existingPdfPage) {
          res = await resPromise;
          if ((existingPdfPage.rotate && existingPdfPage.rotate !== 0) || !Array.isArray(existingPdfPage.view) || existingPdfPage.view.length !== 4) {
            bridge.reportFallback("rotated-or-box");
            return capturedGetPageData.call(this, data);
          }
          viewBox = existingPdfPage.view;
          if (pageIndex === 0 && Math.abs(viewBox[0]) < 0.5 && Math.abs(viewBox[1]) < 0.5) {
            zeroOriginConfirmed = true;
          }
        } else if (isCtrlFSweep && zeroOriginConfirmed) {
          res = await resPromise;
        } else {
          const [page, r] = await Promise.all([this.getPage(pageIndex + 1), resPromise]);
          res = r;
          if (!page || (page.rotate && page.rotate !== 0) || !Array.isArray(page.view) || page.view.length !== 4) {
            bridge.reportFallback("rotated-or-box");
            return capturedGetPageData.call(this, data);
          }
          viewBox = page.view;
          if (pageIndex === 0 && Math.abs(viewBox[0]) < 0.5 && Math.abs(viewBox[1]) < 0.5) {
            zeroOriginConfirmed = true;
          }
        }

        if (!res || !res.ok || !res.json) {
          bridge.reportFallback("native-err");
          return capturedGetPageData.call(this, data);
        }
        const parsed = JSON.parse(res.json);
        if (!parsed || !Array.isArray(parsed.c) || parsed.c.length === 0) {
          bridge.reportFallback("empty-chars");
          return capturedGetPageData.call(this, data);
        }
        if (!viewBox && Array.isArray(parsed.b) && parsed.b.length === 4) {
          viewBox = [0, 0, parsed.b[2] - parsed.b[0], parsed.b[3] - parsed.b[1]];
        }
        const converted = convertCompactToZoteroPageData(parsed, viewBox, pageIndex);
        if (!converted) {
          bridge.reportFallback("box-mismatch");
          return capturedGetPageData.call(this, data);
        }
        lastSeqDoneAt = Date.now();
        bridge.reportHit(res.ms || 0, converted.chars.length, isCtrlFSweep);
        return converted;
      } catch (_err) {
        bridge.reportFallback("exception");
        return capturedGetPageData.call(this, data);
      }
    };
    proto.getPageData = wrappedGetPageData;

    // 2. Native getOutline2 (< 0.5ms embedded outline via MuPDF fz_load_outline)
    if (typeof proto.getOutline2 === "function") {
      origGetOutline2 = proto.getOutline2;
      const capturedGetOutline2 = origGetOutline2;
      wrappedGetOutline2 = async function zotTurboGetOutline2(data) {
        if (typeof bridge.isOutlineEnabled === "function" && bridge.isOutlineEnabled()) {
          try {
            const res = await bridge.requestOutline();
            if (res && res.ok && res.json) {
              const parsed = JSON.parse(res.json);
              if (Array.isArray(parsed) && parsed.length > 0) {
                bridge.reportOutlineHit?.(res.ms || 0);
                return parsed;
              }
            }
          } catch {}
          bridge.reportOutlineFallback?.();
        }
        return capturedGetOutline2.call(this, data);
      };
      proto.getOutline2 = wrappedGetOutline2;
    }

    // 3. Smart deferred getProcessedData (100% preserves citation popups by default) + post-scan PDF.js cleanup
    if (typeof proto.getProcessedData === "function") {
      origGetProcessedData = proto.getProcessedData;
      const capturedGetProcessedData = origGetProcessedData;
      wrappedGetProcessedData = async function zotTurboGetProcessedData(data) {
        const docSelf = this;
        const maxPages =
          typeof bridge.getProcessedDataMaxPages === "function"
            ? Number(bridge.getProcessedDataMaxPages())
            : 100;
        const delayMs =
          typeof bridge.getProcessedDataDelayMs === "function"
            ? Math.max(0, Number(bridge.getProcessedDataDelayMs()) || 0)
            : 1500;

        // If user explicitly lowered maxPages cap and this huge textbook exceeds it, skip heavy 100-page scan
        if (Number.isFinite(maxPages) && maxPages >= 0 && docSelf.numPages > maxPages) {
          scheduleIdleCleanup(docSelf, 1200);
          return { pages: {} };
        }

        // Let initial visible pages finish rendering first so opening a PDF never stutters
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }

        try {
          const result = await capturedGetProcessedData.call(docSelf, data);
          // Preserve 100% of citation/link overlays, but when MuPDF provides getPageData() chars,
          // do NOT apply PDF.js's raw numeric isolatedCharIndexes onto MuPDF's chars array
          // (index drift between PDF.js and MuPDF would falsely mark body chars as isolated!).
          if (bridge.isEnabled() && result && result.pages && typeof result.pages === "object") {
            for (const key of Object.keys(result.pages)) {
              const p = result.pages[key];
              if (p && p.chars) {
                delete p.chars;
              }
            }
          }
          // Purge redundant PDF.js Worker decoded streams/images immediately after citation scan finishes!
          scheduleIdleCleanup(docSelf, 600);
          return result;
        } catch (err) {
          scheduleIdleCleanup(docSelf, 1000);
          throw err;
        }
      };
      proto.getProcessedData = wrappedGetProcessedData;
    }

    scheduleIdleCleanup(pdfDoc, 5000);
    return true;
  }

  function tryAttach() {
    try {
      const app = window.PDFViewerApplication;
      if (app && app.pdfDocument) {
        if (patchDocProto(app.pdfDocument)) {
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
          }
          return true;
        }
      }
      if (app && app.eventBus && !window.__zotTurboDocListener) {
        window.__zotTurboDocListener = () => {
          try {
            resetSweepState();
            if (app.pdfDocument) {
              patchDocProto(app.pdfDocument);
              scheduleIdleCleanup(app.pdfDocument, 5000);
            }
          } catch {}
        };
        app.eventBus.on("documentloaded", window.__zotTurboDocListener);
      }
    } catch {}
    if (++retryCount < 60) {
      retryTimer = setTimeout(tryAttach, 120);
    }
    return false;
  }

  window.__zotTurboCleanupPdfjs = function manualCleanup() {
    try {
      const doc = window.PDFViewerApplication?.pdfDocument;
      if (doc && typeof doc.cleanup === "function") {
        runPdfjsCleanup(doc);
        return true;
      }
    } catch {}
    return false;
  };

  window.__zotTurboUnpatchText = function unpatch() {
    try {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (idleCleanupTimer) {
        clearTimeout(idleCleanupTimer);
        idleCleanupTimer = null;
      }
      resetSweepState();
      if (patchedDocProto) {
        if (origGetPageData && patchedDocProto.getPageData === wrappedGetPageData) {
          patchedDocProto.getPageData = origGetPageData;
        }
        if (origGetOutline2 && patchedDocProto.getOutline2 === wrappedGetOutline2) {
          patchedDocProto.getOutline2 = origGetOutline2;
        }
        if (origGetProcessedData && patchedDocProto.getProcessedData === wrappedGetProcessedData) {
          patchedDocProto.getProcessedData = origGetProcessedData;
        }
      }
      const app = window.PDFViewerApplication;
      if (app?.eventBus && window.__zotTurboDocListener) {
        app.eventBus.off("documentloaded", window.__zotTurboDocListener);
      }
    } catch {}
    delete window.__zotTurboDocListener;
    delete window.__zotTurboCleanupPdfjs;
    delete window.__zotTurboTextPatched;
    delete window.__zotTurboUnpatchText;
  };

  tryAttach();
})();
