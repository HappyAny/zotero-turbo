/* Page-context script injected into Zotero's pdf/web/viewer.html iframe.
 * Hooks PDFPageProxy.prototype.render so canvas rasterization runs on in-process lock-free
 * native MuPDF DLL via ChromeWorker + direct zero-copy Skia putImageData (async WebRender GPU upload),
 * decouples PDFRenderingQueue from slow PDF.js textLayer/annotationLayer stalls,
 * lets Zotero's native +1 DOM lookahead & _trimPageBuffer manage GPU/DOM canvas memory cleanly
 * (while MuPDF's lowest-priority bg thread pre-renders +1/+2/-1 off-thread in RAM),
 * and prioritizes initial getPage(2..6) ahead of Zotero's heavy 100-page getProcessedData() scan —
 * while preserving 100% of Zotero native highlights, text selection, links, themes, and 3rd-party plugins.
 */
(function initZotMuPDFPagePatch() {
  "use strict";

  if (window.__zotMuPDFPatched) {
    return;
  }
  window.__zotMuPDFPatched = true;

  const bridge = window.__zotMuPDFBridge;
  if (!bridge) {
    return;
  }

  let origOpen = null;
  let wrappedOpen = null;
  let origGetPage = null;
  let wrappedGetPage = null;
  let patchedDocProto = null;
  let origPageRender = null;
  let wrappedPageRender = null;
  let patchedPageProto = null;
  let patchedTextLayerProto = null;
  let origTextLayerRender = null;
  let wrappedTextLayerRender = null;
  let origTextLayerCancel = null;
  let wrappedTextLayerCancel = null;
  let patchedStructTreeProto = null;
  let origStructTreeRender = null;
  let wrappedStructTreeRender = null;
  let nextReqId = 1;
  let docLoadedListener = null;
  let pageRenderedListener = null;
  let textLayerRenderedListener = null;
  let scaleChangeListener = null;
  let pageChangeListener = null;
  let attachRetryTimer = null;
  let attachRetryTries = 0;

  // 4K 120Hz & long-document runtime optimizations (CSS isolation, blend-free scroll, scroll-settled textLayer,
  // and Rhythm-Aware Adaptive HiDPI: 3.6 MP fast tier for off-screen/scrolling/peeking pages ->
  // slow-read 400ms / fast-flip 1200ms dwell (or 0ms on page click/selection) -> unlimited native atomic swap,
  // plus off-screen demotion & ZOT_RENDER_FLAG_NO_BG_PRERENDER so VRAM/pixCache stay ultra-lean!)
  const OPT_STYLE_ID = "zot-turbo-4k-style";
  const SCROLL_CLASS = "zot-turbo-scrolling";
  const SCROLL_SETTLE_MS = 140;
  const ADAPTIVE_DEFAULT_FAST_MP = 3.6;
  const ADAPTIVE_DEFAULT_SLOW_DWELL_MS = 400;
  const ADAPTIVE_DEFAULT_FAST_DWELL_MS = 1200;
  const ADAPTIVE_PRIMARY_MIN_RATIO = 0.35;
  const ADAPTIVE_DEMOTE_DELAY_MS = 600;
  let scrollContainer = null;
  let scrollListener = null;
  let pointerDownListener = null;
  let selectionChangeListener = null;
  let scrollIdleTimer = null;
  let adaptiveUpgradeTimer = null;
  let adaptiveDemoteTimer = null;
  let isScrolling = false;
  let scrollSessionStartAt = 0;
  let scrollSessionStartPage = 0;
  let scrollSessionStartTop = 0;
  let lastScrollEndAt = 0;
  let recentFlipBursts = 0;
  let lastRhythmWasFast = false;
  let scrollSettleWaiters = [];
  const activeAdaptiveUpgrades = new Map(); // pageNumber -> { reqId, cancelled }

  const pageRenderEndTimes = new Map(); // pageNumber -> performance.now()

  function cancelPendingAdaptiveTimers() {
    if (adaptiveUpgradeTimer) {
      clearTimeout(adaptiveUpgradeTimer);
      adaptiveUpgradeTimer = null;
    }
    if (adaptiveDemoteTimer) {
      clearTimeout(adaptiveDemoteTimer);
      adaptiveDemoteTimer = null;
    }
  }

  function cancelAllAdaptiveUpgrades() {
    cancelPendingAdaptiveTimers();
    if (activeAdaptiveUpgrades.size === 0) return;
    for (const entry of activeAdaptiveUpgrades.values()) {
      entry.cancelled = true;
      try {
        bridge.cancelRequest(entry.reqId);
      } catch {}
    }
    activeAdaptiveUpgrades.clear();
  }

  function isInFastFlipCooldown() {
    return adaptiveUpgradeTimer !== null && lastRhythmWasFast;
  }

  function getAdaptiveDwellMs(isFastFlip) {
    try {
      const cfg = bridge.getConfig?.() || {};
      const slowRaw = Number(cfg.adaptiveSlowDwellMs);
      const fastRaw = Number(cfg.adaptiveFastDwellMs);
      const slowMs = Number.isFinite(slowRaw) && slowRaw >= SCROLL_SETTLE_MS ? slowRaw : ADAPTIVE_DEFAULT_SLOW_DWELL_MS;
      const fastMs = Number.isFinite(fastRaw) && fastRaw >= slowMs ? fastRaw : ADAPTIVE_DEFAULT_FAST_DWELL_MS;
      return isFastFlip ? fastMs : slowMs;
    } catch {
      return isFastFlip ? ADAPTIVE_DEFAULT_FAST_DWELL_MS : ADAPTIVE_DEFAULT_SLOW_DWELL_MS;
    }
  }

  function scheduleAdaptiveUpgrade(extraDelayMs) {
    if (adaptiveUpgradeTimer) {
      clearTimeout(adaptiveUpgradeTimer);
      adaptiveUpgradeTimer = null;
    }
    const cfg = bridge.getConfig?.() || {};
    if (!cfg.adaptiveHiDPI || !bridge.isEnabled() || isScrolling) return;
    const delay = Math.max(0, Number(extraDelayMs) || 0);
    if (delay === 0) {
      upgradeVisibleAdaptivePages();
      return;
    }
    adaptiveUpgradeTimer = setTimeout(() => {
      adaptiveUpgradeTimer = null;
      lastRhythmWasFast = false;
      upgradeVisibleAdaptivePages();
    }, delay);
  }

  function triggerImmediateAdaptiveUpgrade() {
    if (!window.__zotMuPDFPatched || isScrolling || !bridge.isEnabled()) return;
    const cfg = bridge.getConfig?.() || {};
    if (!cfg.adaptiveHiDPI) return;
    if (adaptiveUpgradeTimer) {
      clearTimeout(adaptiveUpgradeTimer);
      adaptiveUpgradeTimer = null;
    }
    lastRhythmWasFast = false;
    recentFlipBursts = 0;
    upgradeVisibleAdaptivePages();
  }

  function flushScrollWaiters() {
    if (scrollSettleWaiters.length === 0) return;
    const waiters = scrollSettleWaiters.splice(0, scrollSettleWaiters.length);
    for (const resolve of waiters) {
      try {
        resolve();
      } catch {}
    }
  }

  function waitUntilScrollSettles() {
    if (!isScrolling) return Promise.resolve();
    return new Promise(resolve => {
      scrollSettleWaiters.push(resolve);
    });
  }

  function applyRuntimeOpts() {
    try {
      const cfg = bridge.getConfig?.() || {};
      const cssOpt = cfg.longDocCssOpt !== false;
      const liteBlend = cfg.liteOverlayBlend !== false;
      const existing = document.getElementById(OPT_STYLE_ID);
      if (!cssOpt && !liteBlend) {
        if (existing) existing.remove();
        return;
      }
      const parts = [];
      if (cssOpt) {
        parts.push(
          `.pdfViewer .page { contain: layout style; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14) !important; }`,
          `.pdfViewer .canvasWrapper { contain: strict; }`,
          `.pdfViewer .textLayer { contain: layout style paint; }`
        );
      }
      if (liteBlend) {
        parts.push(
          `.annotationOverlay .overlayRect[style*="118, 198, 255"],`,
          `.annotationOverlay .overlayRect[style*="#76c6ff"],`,
          `.annotationOverlay .overlayRect[style*="70, 177, 255"],`,
          `.annotationOverlay .overlayRect[style*="#46b1ff"] { mix-blend-mode: normal !important; }`,
          `#viewerContainer.${SCROLL_CLASS} .annotationOverlay .overlayRect { mix-blend-mode: normal !important; }`
        );
      }
      const cssText = parts.join("\n");
      if (existing) {
        if (existing.textContent !== cssText) existing.textContent = cssText;
      } else if (document.head || document.documentElement) {
        const el = document.createElement("style");
        el.id = OPT_STYLE_ID;
        el.textContent = cssText;
        (document.head || document.documentElement).appendChild(el);
      }
    } catch {}
  }

  function attachScrollWatcher() {
    try {
      const container =
        window.PDFViewerApplication?.pdfViewer?.container || document.getElementById("viewerContainer");
      if (!container || container === scrollContainer) return;
      if (scrollContainer && scrollListener) {
        try {
          scrollContainer.removeEventListener("scroll", scrollListener, { passive: true });
          if (pointerDownListener) {
            scrollContainer.removeEventListener("pointerdown", pointerDownListener, { passive: true });
          }
          scrollContainer.classList?.remove(SCROLL_CLASS);
        } catch {}
      }
      if (selectionChangeListener && typeof document.removeEventListener === "function") {
        try {
          document.removeEventListener("selectionchange", selectionChangeListener);
        } catch {}
      }
      scrollContainer = container;
      scrollListener = () => {
        cancelAllAdaptiveUpgrades();
        if (!isScrolling) {
          isScrolling = true;
          const now = performance.now();
          if (lastScrollEndAt > 0 && now - lastScrollEndAt < 2500) {
            recentFlipBursts++;
          } else {
            recentFlipBursts = 0;
          }
          scrollSessionStartAt = now;
          scrollSessionStartPage = window.PDFViewerApplication?.pdfViewer?.currentPageNumber | 0;
          scrollSessionStartTop = Number(scrollContainer?.scrollTop) || 0;
          try {
            const cfg = bridge.getConfig?.() || {};
            if (cfg.liteOverlayBlend !== false) {
              scrollContainer.classList?.add(SCROLL_CLASS);
            }
          } catch {}
        }
        if (scrollIdleTimer) {
          clearTimeout(scrollIdleTimer);
        }
        scrollIdleTimer = setTimeout(() => {
          scrollIdleTimer = null;
          isScrolling = false;
          try {
            scrollContainer?.classList?.remove(SCROLL_CLASS);
          } catch {}
          const now = performance.now();
          const endPage = window.PDFViewerApplication?.pdfViewer?.currentPageNumber | 0;
          const endTop = Number(scrollContainer?.scrollTop) || 0;
          const pageDelta =
            scrollSessionStartPage > 0 && endPage > 0 ? Math.abs(endPage - scrollSessionStartPage) : 0;
          const scrollPx = Math.abs(endTop - scrollSessionStartTop);
          const activeDurMs = Math.max(80, now - scrollSessionStartAt - SCROLL_SETTLE_MS);
          const pxPerSec = (scrollPx * 1000) / activeDurMs;
          const isFastFlip =
            pageDelta >= 2 || pxPerSec >= 1800 || scrollPx >= 2400 || recentFlipBursts >= 2;
          lastScrollEndAt = now;
          lastRhythmWasFast = isFastFlip;

          // Restore TextLayer & StructTree promptly at 140ms so text selection & highlights stay snappy
          flushScrollWaiters();
          // Immediately reclaim VRAM if >= 2 off-screen full-res canvases are sitting around,
          // then demote any remaining off-screen full-res canvas after 600ms
          demoteOffscreenAdaptivePages(1);
          scheduleOffscreenAdaptiveDemote();
          // Decoupled rhythm-aware HiDPI upgrade: 400ms total on slow reading, 1200ms on fast skimming
          const totalDwellMs = getAdaptiveDwellMs(isFastFlip);
          scheduleAdaptiveUpgrade(Math.max(0, totalDwellMs - SCROLL_SETTLE_MS));
        }, SCROLL_SETTLE_MS);
      };
      scrollContainer.addEventListener("scroll", scrollListener, { passive: true });

      // Explicit reading-intent shortcut: clicking/selecting inside a PDF page skips remaining dwell immediately!
      pointerDownListener = ev => {
        if (isScrolling) return;
        const target = ev?.target;
        if (target && typeof target.closest === "function" && target.closest(".page")) {
          triggerImmediateAdaptiveUpgrade();
        }
      };
      scrollContainer.addEventListener("pointerdown", pointerDownListener, { passive: true });

      if (typeof document.addEventListener === "function") {
        selectionChangeListener = () => {
          if (isScrolling || adaptiveUpgradeTimer === null) return;
          try {
            const sel = window.getSelection?.();
            if (sel && !sel.isCollapsed && String(sel).length > 0) {
              triggerImmediateAdaptiveUpgrade();
            }
          } catch {}
        };
        document.addEventListener("selectionchange", selectionChangeListener);
      }
    } catch {}
  }

  function isActivePageLayer(layerObj, propName) {
    try {
      const pages = window.PDFViewerApplication?.pdfViewer?._pages;
      if (!Array.isArray(pages) || pages.length === 0) return true;
      for (let i = 0; i < pages.length; i++) {
        const pv = pages[i];
        if (pv && pv[propName] === layerObj) {
          // renderingState === 0 means INITIAL (page was reset/destroyed while scrolling past)
          return pv.renderingState !== 0;
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  function patchTextAndStructPrototypes() {
    try {
      const pages = window.PDFViewerApplication?.pdfViewer?._pages;
      if (!Array.isArray(pages)) return;
      for (let i = 0; i < pages.length; i++) {
        const pv = pages[i];
        if (!pv) continue;
        if (!patchedTextLayerProto && pv.textLayer) {
          const proto = Object.getPrototypeOf(pv.textLayer);
          if (proto && typeof proto.render === "function") {
            patchedTextLayerProto = proto;
            if (typeof proto.cancel === "function") {
              origTextLayerCancel = proto.cancel;
              const capturedCancel = origTextLayerCancel;
              wrappedTextLayerCancel = function zotTurboTextLayerCancel(...args) {
                this._zotTurboCancelled = true;
                return capturedCancel.apply(this, args);
              };
              proto.cancel = wrappedTextLayerCancel;
            }
            origTextLayerRender = proto.render;
            const capturedRender = origTextLayerRender;
            wrappedTextLayerRender = async function zotTurboTextLayerRender(...args) {
              this._zotTurboCancelled = false;
              const cfg = bridge.getConfig?.() || {};
              if (isScrolling && bridge.isEnabled() && cfg.deferTextLayerOnScroll !== false) {
                await waitUntilScrollSettles();
                if (
                  this._zotTurboCancelled ||
                  !window.__zotMuPDFPatched ||
                  !isActivePageLayer(this, "textLayer")
                ) {
                  return;
                }
              }
              return capturedRender.apply(this, args);
            };
            proto.render = wrappedTextLayerRender;
          }
        }
        if (!patchedStructTreeProto && pv.structTreeLayer) {
          const proto = Object.getPrototypeOf(pv.structTreeLayer);
          if (proto && typeof proto.render === "function") {
            patchedStructTreeProto = proto;
            origStructTreeRender = proto.render;
            const capturedStructRender = origStructTreeRender;
            wrappedStructTreeRender = async function zotTurboStructTreeRender(...args) {
              const cfg = bridge.getConfig?.() || {};
              if (isScrolling && bridge.isEnabled() && cfg.deferTextLayerOnScroll !== false) {
                await waitUntilScrollSettles();
                if (!window.__zotMuPDFPatched || !isActivePageLayer(this, "structTreeLayer")) {
                  return null;
                }
              }
              return capturedStructRender.apply(this, args);
            };
            proto.render = wrappedStructTreeRender;
          }
        }
        if (patchedTextLayerProto && patchedStructTreeProto) break;
      }
    } catch {}
  }

  function invert2D(m) {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      return null;
    }
    const invDet = 1 / det;
    return [
      d * invDet,
      -b * invDet,
      -c * invDet,
      a * invDet,
      (c * f - d * e) * invDet,
      (b * e - a * f) * invDet,
    ];
  }

  function multiply2D(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  function isThumbnailCanvas(canvas, ctxAlreadyProvided, width, height) {
    if (canvas && canvas.closest && canvas.closest(".thumbnail, #thumbnailView")) {
      return true;
    }
    // Zotero 10's PDFThumbnails uses DRAW_UPSCALE_FACTOR=2 * THUMBNAIL_WIDTH=120 * dpr (up to 480x680+ on 2x HiDPI)
    if (ctxAlreadyProvided && width <= 720 && height <= 960) {
      return true;
    }
    return false;
  }

  function isPageVisibleInViewer(pageNumber, pageIndex) {
    try {
      const pv = window.PDFViewerApplication?.pdfViewer;
      if (!pv) return true;
      if (typeof pv._getVisiblePages === "function") {
        const vis = pv._getVisiblePages();
        if (vis && vis.ids && vis.ids.size > 0) {
          return vis.ids.has(pageNumber);
        }
      }
      const pageDiv = pv._pages?.[pageIndex]?.div;
      const container = pv.container;
      if (pageDiv && container && typeof pageDiv.getBoundingClientRect === "function") {
        const pr = pageDiv.getBoundingClientRect();
        const cr = container.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0 && pr.height > 0) {
          return pr.bottom >= cr.top - 40 && pr.top <= cr.bottom + 40;
        }
      }
    } catch {}
    return true;
  }

  function getVisiblePageViews() {
    const pv = window.PDFViewerApplication?.pdfViewer;
    if (!pv) return [];
    const out = [];
    const seen = new Set();
    try {
      if (typeof pv._getVisiblePages === "function") {
        const vis = pv._getVisiblePages();
        if (vis && Array.isArray(vis.views) && vis.views.length > 0) {
          for (const item of vis.views) {
            const view = item?.view || item;
            if (view && view.id != null && !seen.has(view.id)) {
              seen.add(view.id);
              out.push(view);
            }
          }
        } else if (vis && vis.ids && vis.ids.size > 0 && Array.isArray(pv._pages)) {
          for (const pageView of pv._pages) {
            if (pageView && vis.ids.has(pageView.id) && !seen.has(pageView.id)) {
              seen.add(pageView.id);
              out.push(pageView);
            }
          }
        }
      }
    } catch {}
    if (out.length === 0 && Array.isArray(pv._pages)) {
      for (let i = 0; i < pv._pages.length; i++) {
        const pageView = pv._pages[i];
        if (pageView && isPageVisibleInViewer(pageView.id, i)) {
          out.push(pageView);
        }
      }
    }
    const curPage = pv.currentPageNumber | 0;
    if (curPage > 0 && out.length > 1) {
      out.sort((a, b) => Math.abs((a.id | 0) - curPage) - Math.abs((b.id | 0) - curPage));
    }
    return out;
  }

  function getViewVisibilityScore(pv) {
    try {
      const viewer = window.PDFViewerApplication?.pdfViewer;
      const container = viewer?.container || scrollContainer;
      const pageDiv = pv?.div;
      if (
        !container ||
        !pageDiv ||
        typeof pageDiv.getBoundingClientRect !== "function" ||
        typeof container.getBoundingClientRect !== "function"
      ) {
        return null;
      }
      const pr = pageDiv.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      if (!cr || !pr || cr.height <= 0 || pr.height <= 0) return null;
      const visH = Math.max(0, Math.min(pr.bottom, cr.bottom) - Math.max(pr.top, cr.top));
      if (visH <= 0) return { visH: 0, pageRatio: 0, viewRatio: 0 };
      return {
        visH,
        pageRatio: visH / pr.height,
        viewRatio: visH / cr.height,
      };
    } catch {
      return null;
    }
  }

  function isPrimaryVisibleView(pv, visibleCount) {
    if (!pv) return false;
    if (visibleCount <= 1) return true;
    const score = getViewVisibilityScore(pv);
    if (!score) return true;
    if (score.visH <= 0) return false;
    if (score.pageRatio >= ADAPTIVE_PRIMARY_MIN_RATIO || score.viewRatio >= ADAPTIVE_PRIMARY_MIN_RATIO) {
      return true;
    }
    const curPage = window.PDFViewerApplication?.pdfViewer?.currentPageNumber | 0;
    if (curPage > 0 && (pv.id | 0) === curPage && (score.pageRatio >= 0.1 || score.viewRatio >= 0.1)) {
      return true;
    }
    return false;
  }

  function isPrimaryVisiblePage(pageNumber, pageIndex) {
    try {
      const visibleViews = getVisiblePageViews();
      if (visibleViews.length <= 1) return true;
      for (const pv of visibleViews) {
        if (pv && (pv.id === pageNumber || pv.id === pageIndex + 1)) {
          return isPrimaryVisibleView(pv, visibleViews.length);
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  function atomicSwapPageCanvas(pv, oldCanvas, newCanvas, specPropName, specValue) {
    try {
      if (oldCanvas.className) newCanvas.className = oldCanvas.className;
      if (oldCanvas.role) newCanvas.role = oldCanvas.role;
      if (oldCanvas.ariaLabel) newCanvas.ariaLabel = oldCanvas.ariaLabel;
      if (oldCanvas.style && newCanvas.style && typeof oldCanvas.style.cssText === "string") {
        newCanvas.style.cssText = oldCanvas.style.cssText;
      }
      // Preserve structTreeLayer accessibility DOM appended inside this.canvas (viewer.mjs:13682)
      while (oldCanvas.firstChild) {
        newCanvas.appendChild(oldCanvas.firstChild);
      }
      delete newCanvas._zotAdaptiveSpec;
      delete newCanvas._zotAdaptiveFullSpec;
      delete newCanvas._zotFullAt;
      if (specPropName && specValue) {
        newCanvas[specPropName] = specValue;
        if (specPropName === "_zotAdaptiveFullSpec") {
          newCanvas._zotFullAt = performance.now();
        }
      }
      if (typeof oldCanvas.replaceWith === "function") {
        oldCanvas.replaceWith(newCanvas);
      } else if (oldCanvas.parentNode && typeof oldCanvas.parentNode.replaceChild === "function") {
        oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);
      } else {
        return false;
      }
      pv.canvas = newCanvas;
      // Release replaced canvas backing store & WebRender GPU texture immediately
      oldCanvas.width = 0;
      oldCanvas.height = 0;
      delete oldCanvas._zotAdaptiveSpec;
      delete oldCanvas._zotAdaptiveFullSpec;
      delete oldCanvas._zotFullAt;
      return true;
    } catch {
      return false;
    }
  }

  function upgradeVisibleAdaptivePages() {
    try {
      if (!window.__zotMuPDFPatched || isScrolling || !bridge.isEnabled()) return;
      const cfg = bridge.getConfig?.() || {};
      if (!cfg.adaptiveHiDPI) return;
      const visibleViews = getVisiblePageViews();
      const visCount = visibleViews.length;
      for (const pv of visibleViews) {
        if (!pv || pv.renderingState !== 3) continue;
        // Skip barely peeking top/bottom edge pages (< 35% visible) so only primary reading page(s) use full VRAM
        if (!isPrimaryVisibleView(pv, visCount)) continue;
        const oldCanvas = pv.canvas;
        const spec = oldCanvas?._zotAdaptiveSpec;
        if (!oldCanvas || !spec) continue;
        if (oldCanvas.isConnected === false) continue;
        if (oldCanvas.style && oldCanvas.style.transform) continue;
        if (oldCanvas.width >= spec.origWidth && oldCanvas.height >= spec.origHeight) {
          delete oldCanvas._zotAdaptiveSpec;
          oldCanvas._zotAdaptiveFullSpec = spec;
          oldCanvas._zotFullAt = performance.now();
          continue;
        }
        const pageNumber = spec.pageNumber;
        if (activeAdaptiveUpgrades.has(pageNumber)) continue;

        const hiCanvas = document.createElement("canvas");
        hiCanvas.width = spec.origWidth;
        hiCanvas.height = spec.origHeight;

        const reqId = nextReqId++;
        const upgrade = { reqId, cancelled: false };
        activeAdaptiveUpgrades.set(pageNumber, upgrade);

        const isAborted = () =>
          upgrade.cancelled ||
          !window.__zotMuPDFPatched ||
          isScrolling ||
          oldCanvas.isConnected === false ||
          pv.canvas !== oldCanvas ||
          pv.renderingState !== 3 ||
          !!(oldCanvas.style && oldCanvas.style.transform) ||
          !isPageVisibleInViewer(spec.pageNumber, spec.pageIndex);

        const cleanupHiCanvas = () => {
          if (activeAdaptiveUpgrades.get(pageNumber) === upgrade) {
            activeAdaptiveUpgrades.delete(pageNumber);
          }
          try {
            hiCanvas.width = 0;
            hiCanvas.height = 0;
          } catch {}
        };

        const finishOrDiscard = () => {
          if (activeAdaptiveUpgrades.get(pageNumber) === upgrade) {
            activeAdaptiveUpgrades.delete(pageNumber);
          }
          if (isAborted()) {
            cleanupHiCanvas();
            return;
          }
          const swapped = atomicSwapPageCanvas(pv, oldCanvas, hiCanvas, "_zotAdaptiveFullSpec", spec);
          if (!swapped) {
            cleanupHiCanvas();
          }
        };

        const payload = JSON.stringify({
          reqId,
          pageIndex: spec.pageIndex,
          width: spec.origWidth,
          height: spec.origHeight,
          baseW: spec.baseW,
          baseH: spec.baseH,
          matrix: spec.fullMatrix,
          includeAnnots: spec.includeAnnots,
          skipBgPrerender: true,
          aaLevel: spec.aaLevel,
          theme: spec.theme,
          isMainPage: true,
          isVisible: true,
          isDetached: true,
          isAdaptiveUpgrade: true,
          hasProvidedCtx: false,
        });

        bridge.renderPage(
          payload,
          hiCanvas,
          null,
          isAborted,
          () => {
            finishOrDiscard();
          },
          (rgbaU8, respW, respH) => {
            if (isAborted()) {
              cleanupHiCanvas();
              return;
            }
            try {
              if (
                hiCanvas.width !== respW ||
                hiCanvas.height !== respH ||
                !rgbaU8 ||
                rgbaU8.byteLength !== respW * respH * 4
              ) {
                cleanupHiCanvas();
                return;
              }
              const ctx = hiCanvas.getContext("2d", {
                alpha: false,
                willReadFrequently: cfg.softwareCanvas !== false,
              });
              if (!ctx) {
                cleanupHiCanvas();
                return;
              }
              const clamped = new Uint8ClampedArray(rgbaU8.buffer, rgbaU8.byteOffset, rgbaU8.byteLength);
              ctx.putImageData(new ImageData(clamped, respW, respH), 0, 0);
              finishOrDiscard();
            } catch {
              cleanupHiCanvas();
            }
          },
          () => {
            cleanupHiCanvas();
          }
        );
      }
    } catch {}
  }

  function demoteOffscreenAdaptivePages(keepMostRecent = 0) {
    try {
      if (!window.__zotMuPDFPatched || isScrolling || !bridge.isEnabled()) return;
      const cfg = bridge.getConfig?.() || {};
      if (!cfg.adaptiveHiDPI) return;
      const viewer = window.PDFViewerApplication?.pdfViewer;
      const pages = viewer?._pages;
      if (!Array.isArray(pages) || pages.length === 0) return;

      const visibleIds = new Set();
      for (const v of getVisiblePageViews()) {
        if (v && v.id != null) visibleIds.add(v.id);
      }

      const candidates = [];
      for (let i = 0; i < pages.length; i++) {
        const pv = pages[i];
        if (!pv || pv.renderingState !== 3) continue;
        if (visibleIds.has(pv.id)) continue;
        const hiCanvas = pv.canvas;
        const spec = hiCanvas?._zotAdaptiveFullSpec;
        if (!hiCanvas || !spec) continue;
        if (hiCanvas.isConnected === false) continue;
        if (hiCanvas.style && hiCanvas.style.transform) continue;
        if (hiCanvas.width <= spec.fastW && hiCanvas.height <= spec.fastH) {
          delete hiCanvas._zotAdaptiveFullSpec;
          continue;
        }
        candidates.push({ pv, hiCanvas, spec, fullAt: Number(hiCanvas._zotFullAt) || 0 });
      }

      const keep = Math.max(0, keepMostRecent | 0);
      if (candidates.length <= keep) return;
      if (keep > 0) {
        // Demote oldest off-screen unlimited canvases first, keeping the most recent neighbor briefly until 600ms
        candidates.sort((a, b) => a.fullAt - b.fullAt);
      }
      const demoteCount = candidates.length - keep;
      for (let i = 0; i < demoteCount; i++) {
        const { pv, hiCanvas, spec } = candidates[i];
        const downCanvas = document.createElement("canvas");
        downCanvas.width = spec.fastW;
        downCanvas.height = spec.fastH;
        const ctx = downCanvas.getContext?.("2d", {
          alpha: false,
          willReadFrequently: cfg.softwareCanvas !== false,
        });
        if (!ctx || typeof ctx.drawImage !== "function") {
          downCanvas.width = 0;
          downCanvas.height = 0;
          continue;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(hiCanvas, 0, 0, spec.fastW, spec.fastH);
        const swapped = atomicSwapPageCanvas(pv, hiCanvas, downCanvas, "_zotAdaptiveSpec", spec);
        if (!swapped) {
          downCanvas.width = 0;
          downCanvas.height = 0;
        }
      }
    } catch {}
  }

  function scheduleOffscreenAdaptiveDemote() {
    if (adaptiveDemoteTimer) {
      clearTimeout(adaptiveDemoteTimer);
      adaptiveDemoteTimer = null;
    }
    const cfg = bridge.getConfig?.() || {};
    if (!cfg.adaptiveHiDPI) return;
    adaptiveDemoteTimer = setTimeout(() => {
      adaptiveDemoteTimer = null;
      demoteOffscreenAdaptivePages(0);
    }, ADAPTIVE_DEMOTE_DELAY_MS);
  }

  function makeCancelledError(pageNumber) {
    const Ctor = window.pdfjsLib?.RenderingCancelledException;
    if (Ctor) {
      return new Ctor(`Rendering cancelled, page ${pageNumber}`, "canvas");
    }
    const err = new Error(`Rendering cancelled, page ${pageNumber}`);
    err.name = "RenderingCancelledException";
    return err;
  }

  function patchPagePrototype(page) {
    if (!page) return;
    const proto = Object.getPrototypeOf(page);
    if (!proto || typeof proto.render !== "function") return;
    if (patchedPageProto === proto) return;

    origPageRender = proto.render;
    const capturedPageRender = origPageRender;
    patchedPageProto = proto;

    wrappedPageRender = function zotMuPDFRender(params) {
      const invokeTimedOrigRender = () => {
        const tStart = performance.now();
        const origTask = capturedPageRender.call(this, params);
        if (origTask && origTask.promise && typeof origTask.promise.then === "function") {
          origTask.promise.then(
            () => {
              try {
                bridge.reportPdfJsTiming?.(performance.now() - tStart);
              } catch {}
            },
            () => {}
          );
        }
        return origTask;
      };

      try {
        if (!bridge.isEnabled()) {
          return invokeTimedOrigRender();
        }
        if (!params || !params.viewport) {
          return invokeTimedOrigRender();
        }
        if (params.intent === "print" || params.isEditing || params.annotationCanvasMap) {
          return invokeTimedOrigRender();
        }

        const targetCanvas = params.canvas || params.canvasContext?.canvas;
        if (!targetCanvas) {
          return invokeTimedOrigRender();
        }
        const origWidth = targetCanvas.width | 0;
        const origHeight = targetCanvas.height | 0;
        let width = origWidth;
        let height = origHeight;
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) {
          return invokeTimedOrigRender();
        }

        const ctxAlreadyProvided = !!params.canvasContext;
        const isThumb = isThumbnailCanvas(targetCanvas, ctxAlreadyProvided, width, height);
        const cfg = bridge.getConfig();
        if (!cfg.renderThumbnails && isThumb) {
          return invokeTimedOrigRender();
        }

        const baseVp = this.getViewport({ scale: 1 });
        const invBase = invert2D(baseVp.transform);
        if (!invBase) {
          return invokeTimedOrigRender();
        }

        const pageIndex = this._pageIndex != null ? this._pageIndex : this.pageNumber - 1;
        const pageNumber = this.pageNumber;
        const includeAnnots = params.annotationMode !== 0;
        const isMainPage = !isThumb && (width > 450 || height > 450);
        const isVisible = isMainPage ? isPageVisibleInViewer(pageNumber, pageIndex) : true;

        const skipBlender = !!(params.canvasContext && params.canvasContext.skipBlender);
        let theme = null;
        if (!skipBlender && window.theme && window.theme.background && window.theme.foreground) {
          theme = {
            background: String(window.theme.background),
            foreground: String(window.theme.foreground),
            invertImages: !!window.theme.invertImages,
          };
        }

        const origTotalT = params.transform
          ? multiply2D(params.transform, params.viewport.transform)
          : params.viewport.transform;
        let totalT = origTotalT;

        // Clear any stale adaptive metadata before re-rendering into this canvas
        delete targetCanvas._zotAdaptiveSpec;
        delete targetCanvas._zotAdaptiveFullSpec;

        // Optional user-configured maxOutputScale & 4K maxPageMegapixels / Adaptive HiDPI strategy.
        // Applies only to full main-page renders (never zoomed PDFDetailView tiles or thumbnails),
        // keeping CSS page dimensions, highlights, and textLayer coordinates 100% identical!
        // In Adaptive HiDPI mode:
        //   - Off-screen pre-rendered pages (!isVisible) & pages drawn mid-scroll (isScrolling) cap to 3.6 MP;
        //   - Settled displayed page(s) (isVisible && !isScrolling) render with UNLIMITED native pixels,
        //     and previously capped visible pages atomically swap to unlimited native once scrolling settles!
        let resizedForMaxScale = false;
        let pendingAdaptiveSpec = null;
        let pendingFullSpec = null;
        const maxOutScale = Number(cfg.maxOutputScale) || 0;
        const adaptiveHiDPI = !!cfg.adaptiveHiDPI;
        const maxPageMP = Number(cfg.maxPageMegapixels) || 0;
        const isFullPageTransform =
          !params.transform || (Math.abs(params.transform[4]) < 1 && Math.abs(params.transform[5]) < 1);
        if (
          isMainPage &&
          !ctxAlreadyProvided &&
          isFullPageTransform &&
          (maxOutScale >= 0.75 || maxPageMP >= 1.5 || adaptiveHiDPI)
        ) {
          // Step 1: Apply optional explicit DPR cap first to obtain target settled (unlimited-MP) dimensions
          let fullW = origWidth;
          let fullH = origHeight;
          let fullTotalT = origTotalT;
          if (maxOutScale >= 0.75 && params.transform) {
            const curScale = Math.hypot(params.transform[0], params.transform[1]);
            if (Number.isFinite(curScale) && curScale > maxOutScale + 0.02) {
              const dprRatio = maxOutScale / curScale;
              if (dprRatio < 0.99) {
                const scaledW = Math.max(1, Math.round(origWidth * dprRatio));
                const scaledH = Math.max(1, Math.round(origHeight * dprRatio));
                if (scaledW < origWidth && scaledH < origHeight) {
                  fullW = scaledW;
                  fullH = scaledH;
                  fullTotalT = multiply2D([fullW / origWidth, 0, 0, fullH / origHeight, 0, 0], origTotalT);
                }
              }
            }
          }

          // Step 2: Apply either Adaptive two-tier HiDPI or fixed megapixel cap
          let renderW = fullW;
          let renderH = fullH;
          totalT = fullTotalT;

          if (adaptiveHiDPI) {
            const fastCapMP = maxPageMP >= 1.5 ? maxPageMP : ADAPTIVE_DEFAULT_FAST_MP;
            const fastCapPixels = fastCapMP * 1000000;
            const fullPixels = fullW * fullH;
            if (fullPixels > fastCapPixels * 1.03) {
              const mpRatio = Math.sqrt(fastCapPixels / fullPixels);
              const fastW = Math.max(1, Math.round(fullW * mpRatio));
              const fastH = Math.max(1, Math.round(fullH * mpRatio));
              if (fastW < fullW && fastH < fullH) {
                const fullMatrix = multiply2D(fullTotalT, invBase);
                let fullMatrixValid = true;
                for (let i = 0; i < 6; i++) {
                  if (!Number.isFinite(fullMatrix[i])) {
                    fullMatrixValid = false;
                    break;
                  }
                }
                if (fullMatrixValid) {
                  const adaptiveSpec = {
                    pageIndex,
                    pageNumber,
                    origWidth: fullW,
                    origHeight: fullH,
                    fastW,
                    fastH,
                    baseW: baseVp.width,
                    baseH: baseVp.height,
                    fullMatrix,
                    includeAnnots,
                    aaLevel: cfg.aaLevel || 8,
                    theme,
                  };
                  const useFastTier =
                    !isVisible ||
                    isScrolling ||
                    isInFastFlipCooldown() ||
                    !isPrimaryVisiblePage(pageNumber, pageIndex);
                  if (useFastTier) {
                    renderW = fastW;
                    renderH = fastH;
                    totalT = multiply2D([fastW / origWidth, 0, 0, fastH / origHeight, 0, 0], origTotalT);
                    pendingAdaptiveSpec = adaptiveSpec;
                  } else {
                    pendingFullSpec = adaptiveSpec;
                  }
                }
              }
            }
          } else if (maxPageMP >= 1.5) {
            const maxPixels = maxPageMP * 1000000;
            const fullPixels = fullW * fullH;
            if (fullPixels > maxPixels * 1.03) {
              const mpRatio = Math.sqrt(maxPixels / fullPixels);
              const capW = Math.max(1, Math.round(fullW * mpRatio));
              const capH = Math.max(1, Math.round(fullH * mpRatio));
              if (capW < fullW && capH < fullH) {
                renderW = capW;
                renderH = capH;
                totalT = multiply2D([capW / origWidth, 0, 0, capH / origHeight, 0, 0], origTotalT);
              }
            }
          }

          if (renderW < origWidth || renderH < origHeight) {
            targetCanvas.width = renderW;
            targetCanvas.height = renderH;
            width = renderW;
            height = renderH;
            resizedForMaxScale = true;
          }
        }

        const muMatrix = multiply2D(totalT, invBase);
        for (let i = 0; i < 6; i++) {
          if (!Number.isFinite(muMatrix[i])) {
            if (resizedForMaxScale) {
              targetCanvas.width = origWidth;
              targetCanvas.height = origHeight;
            }
            return invokeTimedOrigRender();
          }
        }

        const pageSelf = this;
        const reqId = nextReqId++;
        let cancelled = false;
        let settled = false;
        let started = false;
        let fallbackTask = null;

        let resolvePromise;
        let rejectPromise;
        const promise = new Promise((resolve, reject) => {
          resolvePromise = resolve;
          rejectPromise = reject;
        });

        const task = {
          onContinue: null,
          onError: null,
          separateAnnots: false,
          recordedBBoxes: null,
          imageCoordinates: null,
          get promise() {
            return promise;
          },
          cancel(extraDelay = 0) {
            if (cancelled || settled) return;
            cancelled = true;
            if (fallbackTask) {
              try {
                fallbackTask.cancel(extraDelay);
              } catch {}
              return;
            }
            if (started) {
              try {
                bridge.cancelRequest(reqId);
              } catch {}
            }
            settled = true;
            const err = makeCancelledError(pageNumber);
            try {
              task.onError?.(err);
            } catch {}
            rejectPromise(err);
          },
        };

        const runFallback = reason => {
          if (cancelled || settled) return;
          if (resizedForMaxScale) {
            try {
              targetCanvas.width = origWidth;
              targetCanvas.height = origHeight;
              resizedForMaxScale = false;
            } catch {}
          }
          try {
            bridge.reportFallback(String(reason || "unknown"));
          } catch {}
          try {
            const tFb0 = performance.now();
            fallbackTask = capturedPageRender.call(pageSelf, params);
            fallbackTask.onContinue = task.onContinue;
            fallbackTask.onError = task.onError;
            fallbackTask.promise.then(
              val => {
                try {
                  bridge.reportPdfJsTiming?.(performance.now() - tFb0);
                } catch {}
                if (!settled) {
                  settled = true;
                  resolvePromise(val);
                }
              },
              err => {
                if (!settled) {
                  settled = true;
                  rejectPromise(err);
                }
              }
            );
          } catch (fbErr) {
            if (!settled) {
              settled = true;
              try {
                task.onError?.(fbErr);
              } catch {}
              rejectPromise(fbErr);
            }
          }
        };

        const beginMuPDFRender = () => {
          if (cancelled || settled) return;
          started = true;
          const tE2EStart = performance.now();

          const payload = JSON.stringify({
            reqId,
            pageIndex,
            width,
            height,
            baseW: baseVp.width,
            baseH: baseVp.height,
            matrix: muMatrix,
            includeAnnots,
            skipBgPrerender: !!pendingFullSpec,
            aaLevel: cfg.aaLevel || 8,
            theme,
            isMainPage,
            isVisible,
            hasProvidedCtx: ctxAlreadyProvided,
          });

          bridge.renderPage(
            payload,
            targetCanvas,
            ctxAlreadyProvided ? params.canvasContext : null,
            () => cancelled || settled,
            (paintMs, paintMode, yieldMs = 0) => {
              if (cancelled || settled) return;
              const activePaint = Number(paintMs) || 0;
              const e2eMs = Math.max(activePaint, performance.now() - tE2EStart - (Number(yieldMs) || 0));
              settled = true;
              if (pendingAdaptiveSpec) {
                targetCanvas._zotAdaptiveSpec = pendingAdaptiveSpec;
              } else if (pendingFullSpec) {
                targetCanvas._zotAdaptiveFullSpec = pendingFullSpec;
                targetCanvas._zotFullAt = performance.now();
              }
              try {
                bridge.reportMuPDFPaint?.(e2eMs, activePaint, paintMode || "skia", isMainPage);
              } catch {}
              resolvePromise();
            },
            (rgbaU8, respW, respH, cloneMs) => {
              if (cancelled || settled) return;
              try {
                if (
                  !targetCanvas ||
                  targetCanvas.width !== respW ||
                  targetCanvas.height !== respH ||
                  !rgbaU8 ||
                  rgbaU8.byteLength !== respW * respH * 4
                ) {
                  runFallback("canvas-size-mismatch");
                  return;
                }
                const tPaint0 = performance.now();
                const ctx = ctxAlreadyProvided
                  ? params.canvasContext
                  : targetCanvas.getContext("2d", {
                      alpha: false,
                      willReadFrequently: cfg.softwareCanvas !== false,
                    });
                if (!ctx) {
                  runFallback("no-2d-context");
                  return;
                }
                const clamped = new Uint8ClampedArray(rgbaU8.buffer, rgbaU8.byteOffset, rgbaU8.byteLength);
                const imgData = new ImageData(clamped, respW, respH);
                ctx.putImageData(imgData, 0, 0);
                const paintMs = performance.now() - tPaint0 + (Number(cloneMs) || 0);
                const e2eMs = performance.now() - tE2EStart;
                settled = true;
                if (pendingAdaptiveSpec) {
                  targetCanvas._zotAdaptiveSpec = pendingAdaptiveSpec;
                } else if (pendingFullSpec) {
                  targetCanvas._zotAdaptiveFullSpec = pendingFullSpec;
                  targetCanvas._zotFullAt = performance.now();
                }
                try {
                  bridge.reportMuPDFPaint?.(e2eMs, paintMs, "clone", isMainPage);
                } catch {}
                resolvePromise();
              } catch (drawErr) {
                runFallback(drawErr && drawErr.message ? drawErr.message : String(drawErr));
              }
            },
            (errMsg, isCancelled) => {
              if (settled) return;
              if (cancelled || isCancelled) {
                cancelled = true;
                settled = true;
                const err = makeCancelledError(pageNumber);
                try {
                  task.onError?.(err);
                } catch {}
                rejectPromise(err);
                return;
              }
              runFallback(errMsg);
            }
          );
        };

        // Defer by one microtask so PDFPageView._drawCanvas attaches renderTask.onContinue & onError first.
        Promise.resolve().then(() => {
          if (cancelled || settled) return;
          beginMuPDFRender();
        });

        return task;
      } catch (outerErr) {
        try {
          bridge.reportFallback(outerErr && outerErr.message ? outerErr.message : String(outerErr));
        } catch {}
        return invokeTimedOrigRender();
      }
    };
    proto.render = wrappedPageRender;
  }

  function hookPdfDocument(pdfDoc) {
    if (!pdfDoc) return;
    const proto = Object.getPrototypeOf(pdfDoc);
    if (proto && patchedDocProto !== proto) {
      patchedDocProto = proto;
      if (typeof proto.getPage === "function") {
        origGetPage = proto.getPage;
        const capturedGetPage = origGetPage;
        wrappedGetPage = function zotMuPDFGetPage(pageNumber) {
          const p = capturedGetPage.call(this, pageNumber);
          return Promise.resolve(p).then(page => {
            patchPagePrototype(page);
            return page;
          });
        };
        proto.getPage = wrappedGetPage;
      }
    }

    let patchedFromExisting = false;
    try {
      const pages = window.PDFViewerApplication?.pdfViewer?._pages;
      if (Array.isArray(pages)) {
        for (const pv of pages) {
          if (pv && pv.pdfPage) {
            patchPagePrototype(pv.pdfPage);
            patchedFromExisting = true;
            break;
          }
        }
      }
    } catch {}

    // If pdfDocument exists before page 1 is attached to pdfViewer._pages, grab page 1 handle
    // immediately so PDFPageProxy.prototype.render is patched even if pagesinit already raced!
    if (!patchedFromExisting && !patchedPageProto && typeof pdfDoc.getPage === "function") {
      try {
        Promise.resolve(pdfDoc.getPage(1))
          .then(p => {
            if (p) patchPagePrototype(p);
          })
          .catch(() => {});
      } catch {}
    }
  }

  function attachToViewerApp() {
    const app = window.PDFViewerApplication;
    if (!app) return false;

    if (!origOpen && typeof app.open === "function") {
      origOpen = app.open;
      const capturedOpen = origOpen;
      wrappedOpen = function zotMuPDFOpen(args) {
        try {
          if (args && typeof args === "object" && typeof args.password === "string") {
            bridge.setPassword(args.password);
          }
        } catch {}
        return capturedOpen.apply(this, arguments);
      };
      app.open = wrappedOpen;
    }

    if (app.pdfDocument) {
      hookPdfDocument(app.pdfDocument);
    }
    applyRuntimeOpts();
    attachScrollWatcher();
    patchTextAndStructPrototypes();

    const bindBus = () => {
      if (!app.eventBus || docLoadedListener) return;
      docLoadedListener = () => {
        cancelAllAdaptiveUpgrades();
        applyRuntimeOpts();
        attachScrollWatcher();
        if (app.pdfDocument) {
          hookPdfDocument(app.pdfDocument);
        }
        patchTextAndStructPrototypes();
      };

      scaleChangeListener = () => {
        cancelAllAdaptiveUpgrades();
      };

      pageChangeListener = () => {
        if (!isScrolling && adaptiveUpgradeTimer === null) {
          scheduleAdaptiveUpgrade(Math.max(0, getAdaptiveDwellMs(false) - SCROLL_SETTLE_MS));
          scheduleOffscreenAdaptiveDemote();
        }
      };

      // Decouple PDFRenderingQueue from PDF.js textLayer/annotationLayer stalls:
      // kick renderHighestPriority() as soon as MuPDF finishes painting the canvas!
      pageRenderedListener = ev => {
        patchTextAndStructPrototypes();
        if (!ev || ev.error || ev.cssTransform) return;
        if (ev.pageNumber != null && !ev.isDetailView) {
          pageRenderEndTimes.set(ev.pageNumber, performance.now());
        }
        if (!bridge.isEnabled()) return;
        Promise.resolve().then(() => {
          try {
            window.PDFViewerApplication?.pdfRenderingQueue?.renderHighestPriority();
          } catch {}
          // Only upgrade right away if dwell cooldown has already elapsed (never bypass fast-flip dwell!)
          if (!isScrolling && adaptiveUpgradeTimer === null) {
            upgradeVisibleAdaptivePages();
          }
        });
      };

      textLayerRenderedListener = ev => {
        if (!ev || ev.pageNumber == null) return;
        const t0 = pageRenderEndTimes.get(ev.pageNumber);
        if (t0 != null) {
          pageRenderEndTimes.delete(ev.pageNumber);
          try {
            bridge.reportTextLayerTiming?.(performance.now() - t0);
          } catch {}
        }
      };

      app.eventBus.on("documentloaded", docLoadedListener);
      app.eventBus.on("pagesinit", docLoadedListener);
      app.eventBus.on("pagesdestroy", scaleChangeListener);
      app.eventBus.on("scalechanging", scaleChangeListener);
      app.eventBus.on("rotationchanging", scaleChangeListener);
      app.eventBus.on("pagechanging", pageChangeListener);
      app.eventBus.on("pagerendered", pageRenderedListener);
      app.eventBus.on("textlayerrendered", textLayerRenderedListener);
    };

    if (app.eventBus) {
      bindBus();
    } else if (app.initializedPromise) {
      app.initializedPromise.then(() => {
        bindBus();
        applyRuntimeOpts();
        attachScrollWatcher();
        if (app.pdfDocument) {
          hookPdfDocument(app.pdfDocument);
        }
        patchTextAndStructPrototypes();
      });
    }
    return true;
  }

  function refreshAllPages(coldReset = false) {
    try {
      cancelAllAdaptiveUpgrades();
      const app = window.PDFViewerApplication;
      const viewer = app?.pdfViewer;
      if (!viewer) return;
      if (Array.isArray(viewer._pages)) {
        for (const pv of viewer._pages) {
          if (coldReset && pv?.pdfPage?._intentStates?.clear) {
            try {
              pv.pdfPage._intentStates.clear();
            } catch {}
          }
          if (pv && typeof pv.reset === "function") {
            pv.reset({ keepTextLayer: true, keepAnnotationLayer: true });
          }
        }
      }
      viewer.update();
    } catch {}
  }

  function ensureAttached() {
    if (attachToViewerApp()) {
      if (attachRetryTimer) {
        clearTimeout(attachRetryTimer);
        attachRetryTimer = null;
      }
      return true;
    }
    if (!attachRetryTimer && attachRetryTries < 80) {
      attachRetryTries++;
      attachRetryTimer = setTimeout(() => {
        attachRetryTimer = null;
        ensureAttached();
      }, 25);
    }
    return false;
  }

  function uninstall() {
    try {
      cancelAllAdaptiveUpgrades();
      if (attachRetryTimer) {
        clearTimeout(attachRetryTimer);
        attachRetryTimer = null;
      }
      if (scrollIdleTimer) {
        clearTimeout(scrollIdleTimer);
        scrollIdleTimer = null;
      }
      isScrolling = false;
      flushScrollWaiters();
      if (scrollContainer && scrollListener) {
        try {
          scrollContainer.removeEventListener("scroll", scrollListener, { passive: true });
          if (pointerDownListener) {
            scrollContainer.removeEventListener("pointerdown", pointerDownListener, { passive: true });
          }
          scrollContainer.classList?.remove(SCROLL_CLASS);
        } catch {}
      }
      if (selectionChangeListener && typeof document.removeEventListener === "function") {
        try {
          document.removeEventListener("selectionchange", selectionChangeListener);
        } catch {}
      }
      scrollContainer = null;
      scrollListener = null;
      pointerDownListener = null;
      selectionChangeListener = null;
      try {
        document.getElementById(OPT_STYLE_ID)?.remove();
      } catch {}
      pageRenderEndTimes.clear();
      if (patchedTextLayerProto) {
        if (origTextLayerRender && patchedTextLayerProto.render === wrappedTextLayerRender) {
          patchedTextLayerProto.render = origTextLayerRender;
        }
        if (origTextLayerCancel && patchedTextLayerProto.cancel === wrappedTextLayerCancel) {
          patchedTextLayerProto.cancel = origTextLayerCancel;
        }
      }
      if (patchedStructTreeProto && origStructTreeRender && patchedStructTreeProto.render === wrappedStructTreeRender) {
        patchedStructTreeProto.render = origStructTreeRender;
      }
      if (patchedPageProto && origPageRender && patchedPageProto.render === wrappedPageRender) {
        patchedPageProto.render = origPageRender;
      }
      if (patchedDocProto) {
        if (origGetPage && patchedDocProto.getPage === wrappedGetPage) {
          patchedDocProto.getPage = origGetPage;
        }
      }
      if (window.PDFViewerApplication && origOpen && window.PDFViewerApplication.open === wrappedOpen) {
        window.PDFViewerApplication.open = origOpen;
      }
      if (window.PDFViewerApplication?.eventBus) {
        if (docLoadedListener) {
          window.PDFViewerApplication.eventBus.off("documentloaded", docLoadedListener);
          window.PDFViewerApplication.eventBus.off("pagesinit", docLoadedListener);
        }
        if (scaleChangeListener) {
          window.PDFViewerApplication.eventBus.off("pagesdestroy", scaleChangeListener);
          window.PDFViewerApplication.eventBus.off("scalechanging", scaleChangeListener);
          window.PDFViewerApplication.eventBus.off("rotationchanging", scaleChangeListener);
        }
        if (pageChangeListener) {
          window.PDFViewerApplication.eventBus.off("pagechanging", pageChangeListener);
        }
        if (pageRenderedListener) {
          window.PDFViewerApplication.eventBus.off("pagerendered", pageRenderedListener);
        }
        if (textLayerRenderedListener) {
          window.PDFViewerApplication.eventBus.off("textlayerrendered", textLayerRenderedListener);
        }
      }
    } catch {}
    patchedPageProto = null;
    origPageRender = null;
    wrappedPageRender = null;
    patchedTextLayerProto = null;
    origTextLayerRender = null;
    wrappedTextLayerRender = null;
    origTextLayerCancel = null;
    wrappedTextLayerCancel = null;
    patchedStructTreeProto = null;
    origStructTreeRender = null;
    wrappedStructTreeRender = null;
    patchedDocProto = null;
    origGetPage = null;
    wrappedGetPage = null;
    origOpen = null;
    wrappedOpen = null;
    docLoadedListener = null;
    scaleChangeListener = null;
    pageChangeListener = null;
    pageRenderedListener = null;
    textLayerRenderedListener = null;
    delete window.__zotMuPDFPatched;
    delete window.__zotMuPDFControl;
    delete window.__zotMuPDFBridge;
  }

  window.__zotMuPDFControl = {
    ensureAttached,
    applyRuntimeOpts,
    refreshAllPages,
    uninstall,
  };

  ensureAttached();
})();
