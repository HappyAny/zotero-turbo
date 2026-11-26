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
  let attachRetryTimer = null;
  let attachRetryTries = 0;

  // 4K 120Hz & long-document runtime optimizations (CSS isolation, blend-free scroll, scroll-settled textLayer)
  const OPT_STYLE_ID = "zot-turbo-4k-style";
  const SCROLL_CLASS = "zot-turbo-scrolling";
  const SCROLL_SETTLE_MS = 140;
  let scrollContainer = null;
  let scrollListener = null;
  let scrollIdleTimer = null;
  let isScrolling = false;
  let scrollSettleWaiters = [];

  const pageRenderEndTimes = new Map(); // pageNumber -> performance.now()

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
          scrollContainer.classList?.remove(SCROLL_CLASS);
        } catch {}
      }
      scrollContainer = container;
      scrollListener = () => {
        if (!isScrolling) {
          isScrolling = true;
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
          flushScrollWaiters();
        }, SCROLL_SETTLE_MS);
      };
      scrollContainer.addEventListener("scroll", scrollListener, { passive: true });
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

        let totalT = params.transform
          ? multiply2D(params.transform, params.viewport.transform)
          : params.viewport.transform;

        // Optional user-configured maxOutputScale & 4K maxPageMegapixels cap.
        // Applies only to full main-page renders (never zoomed PDFDetailView tiles or thumbnails),
        // keeping CSS page dimensions, highlights, and textLayer coordinates 100% identical!
        let resizedForMaxScale = false;
        const maxOutScale = Number(cfg.maxOutputScale) || 0;
        const maxPageMP = Number(cfg.maxPageMegapixels) || 0;
        const isFullPageTransform =
          !params.transform || (Math.abs(params.transform[4]) < 1 && Math.abs(params.transform[5]) < 1);
        if (isMainPage && !ctxAlreadyProvided && isFullPageTransform && (maxOutScale >= 0.75 || maxPageMP >= 1.5)) {
          let downRatio = 1;
          if (maxOutScale >= 0.75 && params.transform) {
            const curScale = Math.hypot(params.transform[0], params.transform[1]);
            if (Number.isFinite(curScale) && curScale > maxOutScale + 0.02) {
              downRatio = Math.min(downRatio, maxOutScale / curScale);
            }
          }
          if (maxPageMP >= 1.5) {
            const maxPixels = maxPageMP * 1000000;
            const origPixels = origWidth * origHeight;
            if (origPixels > maxPixels * 1.03) {
              downRatio = Math.min(downRatio, Math.sqrt(maxPixels / origPixels));
            }
          }
          if (downRatio < 0.99) {
            const newW = Math.max(1, Math.round(origWidth * downRatio));
            const newH = Math.max(1, Math.round(origHeight * downRatio));
            if (newW < origWidth && newH < origHeight) {
              targetCanvas.width = newW;
              targetCanvas.height = newH;
              width = newW;
              height = newH;
              totalT = multiply2D([newW / origWidth, 0, 0, newH / origHeight, 0, 0], totalT);
              resizedForMaxScale = true;
            }
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
        applyRuntimeOpts();
        attachScrollWatcher();
        if (app.pdfDocument) {
          hookPdfDocument(app.pdfDocument);
        }
        patchTextAndStructPrototypes();
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
          scrollContainer.classList?.remove(SCROLL_CLASS);
        } catch {}
      }
      scrollContainer = null;
      scrollListener = null;
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
