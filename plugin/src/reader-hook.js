/* global Zotero, Services, Components, ChromeUtils */
"use strict";

var ZotMuPDFReaderHook = (function () {
  const Cu = Components.utils;
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  function nowMs() {
    try {
      if (typeof ChromeUtils.now === "function") {
        return ChromeUtils.now();
      }
    } catch {}
    return Date.now();
  }

  class ReaderHook {
    constructor({ pluginID, rootURI, engineClient }) {
      this.pluginID = pluginID;
      this.rootURI = rootURI;
      this.engine = engineClient;
      this.pagePatchSource = "";
      this.readerStates = new Map(); // stableReaderKey -> state
      this.viewerEntries = new Set(); // { viewerWin, rawWin, viewerKey, onUnload }
      this.toolbarButtons = new Set(); // { doc, btn, dot, nameEl, metricEl }
      this.thumbHooks = new Set(); // { rawPv, origInitThumbnails, rawThumbs, origRender, origConcurrency }
      this._hookedPvs = new WeakSet();
      this._hookedThumbs = new WeakSet();
      this._thumbScratchCanvas = null;
      this._thumbScratchCtx = null;
      this.nextViewerId = 1;
      this.nextThumbReqId = 1;
      this._notifierID = null;
      this._toolbarHandler = null;
      this._menuCleanups = new WeakMap();
      this._origReaderOpen = null;
      this._origReaderOpenPreview = null;
      this._unsubStats = null;
      this._destroyed = false;
    }

    _getReaderKey(reader) {
      if (!reader) return null;
      return reader.tabID || reader._instanceID || reader._iframeWindow || reader;
    }

    async init() {
      // IMPORTANT: Use Zotero.File.getResourceAsync (nsIChannel) instead of getContentsFromURL (XHR),
      // because Firefox ESR 140 / Zotero 10 rejects jar: URLs containing '@' in XMLHttpRequest!
      this.pagePatchSource = await Zotero.File.getResourceAsync(this.rootURI + "src/page-patch.js");

      // Subscribe to live stats updates to refresh toolbar pills
      this._unsubStats = this.engine.onStatsChange(summary => {
        this._updateAllToolbarButtons(summary);
      });

      // Hook Zotero.Reader.open and openPreview using crash-proof local closures + identity-checked unwrap
      if (Zotero.Reader && typeof Zotero.Reader.open === "function") {
        const origOpen = Zotero.Reader.open;
        this._origReaderOpen = origOpen;
        const self = this;
        const wrappedOpen = async function zotMuPDFWrappedOpen(...args) {
          const reader = await origOpen.apply(this, args);
          if (reader && !self._destroyed) {
            self.attachReader(reader);
            self._scanAllReaders();
          }
          return reader;
        };
        this._wrappedReaderOpen = wrappedOpen;
        Zotero.Reader.open = wrappedOpen;
      }

      if (Zotero.Reader && typeof Zotero.Reader.openPreview === "function") {
        const origPreview = Zotero.Reader.openPreview;
        this._origReaderOpenPreview = origPreview;
        const self = this;
        const wrappedPreview = async function zotMuPDFWrappedOpenPreview(...args) {
          const reader = await origPreview.apply(this, args);
          if (reader && !self._destroyed) {
            self.attachReader(reader);
            self._scanAllReaders();
          }
          return reader;
        };
        this._wrappedReaderOpenPreview = wrappedPreview;
        Zotero.Reader.openPreview = wrappedPreview;
      }

      // Catch session-restored, tab-selected, and tab-closed readers via Zotero.Notifier
      this._notifierID = Zotero.Notifier.registerObserver(
        {
          notify: (event, type) => {
            if (this._destroyed) return;
            if (type === "tab" && event === "close") {
              this._pruneClosedReaders();
              setTimeout(() => {
                if (!this._destroyed) this._pruneClosedReaders();
              }, 150);
              return;
            }
            if (type === "tab" && (event === "add" || event === "select")) {
              this._scanAllReaders();
              setTimeout(() => this._scanAllReaders(), 200);
              setTimeout(() => this._scanAllReaders(), 800);
            }
          },
        },
        ["tab"],
        "zotero-turbo-render"
      );

      // Register compact fixed-width toolbar toggle button for all newly mounted PDF reader tabs
      if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
        this._toolbarHandler = event => {
          if (this._destroyed) return;
          if (!event?.reader || event.reader.type !== "pdf") return;
          this.attachReader(event.reader);
          this._renderToolbarButton(event);
        };
        Zotero.Reader.registerEventListener("renderToolbar", this._toolbarHandler, this.pluginID);
      }

      // Attach to any PDF readers already open when the plugin starts (mid-session install)
      this._scanAllReaders();
    }

    _scanAllReaders() {
      if (this._destroyed) return;
      this._pruneClosedReaders();
      const list = Zotero.Reader?._readers;
      if (!Array.isArray(list)) return;
      for (const reader of list) {
        if (reader && reader.type === "pdf" && !reader._isUninitialized && !reader._isTabClosed) {
          this.attachReader(reader);
        }
      }
    }

    _pruneClosedReaders() {
      for (const [key, state] of Array.from(this.readerStates.entries())) {
        let dead = false;
        try {
          if (!state.reader || state.reader._isUninitialized || state.reader._isTabClosed) {
            dead = true;
          } else if (state.iframeWin && state.iframeWin.closed) {
            dead = true;
          }
        } catch {
          dead = true;
        }
        if (dead) {
          this._detachReader(key);
        }
      }
      for (const th of Array.from(this.thumbHooks)) {
        try {
          if (!th.iframeWin || th.iframeWin.closed) {
            this._disposeThumbHook(th, false);
          }
        } catch {
          this._disposeThumbHook(th, false);
        }
      }
      for (const entry of Array.from(this.viewerEntries)) {
        try {
          if (!entry.viewerWin || entry.viewerWin.closed) {
            this.viewerEntries.delete(entry);
          }
        } catch {
          this.viewerEntries.delete(entry);
        }
      }
    }

    _disposeThumbHook(th, restoreOrig = true) {
      if (!th) return;
      this.thumbHooks.delete(th);
      if (restoreOrig) {
        try {
          const alive = th.iframeWin && !th.iframeWin.closed;
          if (alive) {
            if (th.rawPv && th.origInitThumbnails && (!th.wrappedInitThumbnails || th.rawPv._initThumbnails === th.wrappedInitThumbnails)) {
              th.rawPv._initThumbnails = th.origInitThumbnails;
            }
            if (th.rawThumbs) {
              if (th.origRender && (!th.wrappedRender || th.rawThumbs._render === th.wrappedRender)) {
                th.rawThumbs._render = th.origRender;
              }
              if (th.rawThumbs._renderQueue) {
                th.rawThumbs._renderQueue.concurrency = th.origConcurrency || 1;
              }
            }
          }
        } catch {}
      }
      th.rawPv = null;
      th.origInitThumbnails = null;
      th.wrappedInitThumbnails = null;
      th.rawThumbs = null;
      th.origRender = null;
      th.wrappedRender = null;
      th.iframeWin = null;
    }

    attachReader(reader) {
      if (this._destroyed || !reader || reader.type !== "pdf") return;
      const key = this._getReaderKey(reader);
      if (this.readerStates.has(key)) {
        const existing = this.readerStates.get(key);
        this._scanReaderViews(existing);
        this._ensureToolbarButtonPresent(existing);
        return;
      }

      const state = {
        key,
        reader,
        filePath: "",
        filePathPromise: null,
        password: "",
        iframeWin: null,
        webViewerHandler: null,
        unloadHandler: null,
        attachedWins: new WeakSet(),
        thumbHooks: new Set(),
        viewerEntries: new Set(),
      };
      this.readerStates.set(key, state);

      // Resolve file path eagerly
      state.filePathPromise = this._resolveFilePath(reader)
        .then(p => {
          state.filePath = p || "";
          return state.filePath;
        })
        .catch(() => "");

      this._waitForReaderIframe(state);
    }

    async _resolveFilePath(reader) {
      try {
        const item =
          reader._item ||
          (reader.itemID
            ? typeof Zotero.Items.getAsync === "function"
              ? await Zotero.Items.getAsync(reader.itemID)
              : Zotero.Items.get(reader.itemID)
            : null);
        if (!item) return "";
        return (await item.getFilePathAsync()) || "";
      } catch {
        return "";
      }
    }

    async _waitForReaderIframe(state) {
      let tries = 0;
      while (!this._destroyed && !state.reader._isUninitialized && !state.reader._iframeWindow && tries < 200) {
        await new Promise(r => setTimeout(r, 25));
        tries++;
      }
      if (this._destroyed || state.reader._isUninitialized || !state.reader._iframeWindow) {
        return;
      }

      const iframeWin = state.reader._iframeWindow;
      state.iframeWin = iframeWin;

      // Capture-phase listener on reader.html's document fires synchronously right when viewer.mjs
      // dispatches "webviewerloaded" BEFORE PDFViewerApplication.run() / open() starts rendering!
      state.webViewerHandler = event => {
        if (this._destroyed) return;
        try {
          const detail = event?.detail?.wrappedJSObject || event?.detail;
          const viewerWin = detail?.source || null;
          if (viewerWin) {
            this._attachViewerWindow(state, viewerWin);
          } else {
            this._scanReaderViews(state);
          }
          this._hookPrimaryThumbnails(state);
        } catch (e) {
          Zotero.logError(e);
        }
      };

      state.unloadHandler = () => {
        this._detachReader(state.key);
      };

      try {
        iframeWin.document.addEventListener("webviewerloaded", state.webViewerHandler, true);
        iframeWin.addEventListener("unload", state.unloadHandler);
      } catch (e) {
        Zotero.logError(e);
      }

      // Attach to already-loaded views, thumbnails & inject toolbar button for already-open PDF tabs
      this._scanReaderViews(state);
      this._ensureToolbarButtonPresent(state);
      for (const delay of [150, 500, 1500]) {
        setTimeout(() => {
          if (!this._destroyed && this.readerStates.has(state.key)) {
            this._scanReaderViews(state);
            this._ensureToolbarButtonPresent(state);
          }
        }, delay);
      }
    }

    _ensureToolbarButtonPresent(state) {
      try {
        const doc = state?.iframeWin?.document;
        if (!doc || doc.defaultView?.closed) return;
        const box = doc.querySelector(".toolbar .custom-sections");
        if (!box) return;
        const existingBtn = box.querySelector(".zot-mupdf-toggle");
        if (existingBtn && Array.from(this.toolbarButtons).some(r => r.btn === existingBtn)) return;
        this._renderToolbarButton({
          reader: state.reader,
          doc,
          append: (...nodes) => {
            const section = doc.createElement("div");
            section.className = "section zot-mupdf-section";
            section.append(...nodes);
            box.append(section);
          },
        });
      } catch {}
    }

    _scanReaderViews(state) {
      if (!state || !state.reader || state.reader._isUninitialized) return;
      try {
        const internal = state.reader._internalReader;
        const candidates = [];
        if (internal?._primaryView?._iframeWindow) {
          candidates.push(internal._primaryView._iframeWindow);
        }
        if (internal?._secondaryView?._iframeWindow) {
          candidates.push(internal._secondaryView._iframeWindow);
        }
        const doc = state.iframeWin?.document;
        if (doc) {
          for (const ifr of doc.querySelectorAll("iframe")) {
            try {
              const cw = ifr.contentWindow;
              if (cw && (cw.wrappedJSObject?.PDFViewerApplication || String(ifr.src || "").includes("viewer.html"))) {
                candidates.push(cw);
              }
            } catch {}
          }
        }

        for (const win of candidates) {
          if (win && !win.closed) {
            this._attachViewerWindow(state, win);
          }
        }
        this._hookPrimaryThumbnails(state);
      } catch (e) {
        this.engine.log("scanReaderViews error:", e?.message || String(e));
      }
    }

    /* ---------------- Native 3-Thread MuPDF Sidebar Thumbnail Accelerator ---------------- */

    _hookPrimaryThumbnails(state) {
      if (this._destroyed || !state?.iframeWin || state.iframeWin.closed) return;
      try {
        const rawInternal =
          state.reader._internalReader?.wrappedJSObject || state.reader._internalReader;
        const rawPv = rawInternal?._primaryView?.wrappedJSObject || rawInternal?._primaryView;
        if (!rawPv) return;

        // Intercept _initThumbnails first so newly created PDFThumbnails share a single hookEntry per view
        let hookEntry = null;
        if (!this._hookedPvs.has(rawPv) && typeof rawPv._initThumbnails === "function") {
          this._hookedPvs.add(rawPv);
          const origInitThumbnails = rawPv._initThumbnails;
          hookEntry = {
            iframeWin: state.iframeWin,
            rawPv,
            origInitThumbnails,
            rawThumbs: null,
            origRender: null,
            origConcurrency: 1,
          };
          this.thumbHooks.add(hookEntry);
          state.thumbHooks.add(hookEntry);
          const self = this;
          const iframeWin = state.iframeWin;
          const wrappedInit = Cu.exportFunction(function zotMuPDFWrappedInitThumbnails() {
            const pvSelf = this?.wrappedJSObject || this || rawPv;
            const ret = origInitThumbnails.apply(pvSelf, arguments);
            try {
              const thumbsInst = pvSelf._pdfThumbnails || rawPv._pdfThumbnails;
              if (!self._destroyed && thumbsInst) {
                self._patchThumbnailsInstance(state, pvSelf, thumbsInst, hookEntry);
              }
            } catch (e) {
              self.engine.log("initThumbnails hook error:", e?.message || String(e));
            }
            return ret;
          }, iframeWin);
          hookEntry.wrappedInitThumbnails = wrappedInit;
          rawPv._initThumbnails = wrappedInit;
        }

        // Attach immediately if _pdfThumbnails already exists (reusing hookEntry when present)
        if (rawPv._pdfThumbnails) {
          this._patchThumbnailsInstance(state, rawPv, rawPv._pdfThumbnails, hookEntry);
        }
      } catch (e) {
        this.engine.log("hookPrimaryThumbnails error:", e?.message || String(e));
      }
    }

    _patchThumbnailsInstance(state, rawPv, thumbsObj, existingEntry = null) {
      const rawThumbs = thumbsObj?.wrappedJSObject || thumbsObj;
      if (!rawThumbs || this._hookedThumbs.has(rawThumbs) || typeof rawThumbs._render !== "function") {
        return;
      }
      const iframeWin = state.iframeWin;
      if (!iframeWin || iframeWin.closed) return;

      this._hookedThumbs.add(rawThumbs);
      const origRender = rawThumbs._render;
      const origConcurrency = Number(rawThumbs._renderQueue?.concurrency) || 1;
      const entry = existingEntry || {
        iframeWin,
        rawPv,
        origInitThumbnails: null,
        rawThumbs: null,
        origRender: null,
        origConcurrency: 1,
      };
      entry.iframeWin = iframeWin;
      entry.rawThumbs = rawThumbs;
      entry.origRender = origRender;
      entry.origConcurrency = origConcurrency;
      this.thumbHooks.add(entry);
      state.thumbHooks.add(entry);

      // Match Zotero's thumbnail queue concurrency to our active lock-free foreground MuPDF workers!
      try {
        if (rawThumbs._renderQueue) {
          rawThumbs._renderQueue.concurrency = Math.max(1, Math.min(3, this.engine.workerCount || 2));
        }
      } catch {}

      const self = this;
      const wrappedThumbRender = Cu.exportFunction(function zotMuPDFRenderThumb(pageIndex) {
        const thumbsSelf = this?.wrappedJSObject || this || rawThumbs;
        return new iframeWin.Promise((resolve, reject) => {
          self
            ._renderThumbnailFast(state, rawPv, thumbsSelf, origRender, pageIndex | 0)
            .then(() => resolve(), err => reject(err));
        });
      }, iframeWin);
      entry.wrappedRender = wrappedThumbRender;
      rawThumbs._render = wrappedThumbRender;
    }

    _getThumbScratchContext(width, height) {
      const chromeWin =
        Services.wm.getMostRecentWindow("navigator:browser") || Services.wm.getMostRecentWindow(null);
      if (!chromeWin || !chromeWin.document || typeof chromeWin.ImageData !== "function") {
        return null;
      }
      if (!this._thumbScratchCanvas || this._thumbScratchCanvas.ownerDocument?.defaultView?.closed) {
        this._thumbScratchCanvas = chromeWin.document.createElement("canvas");
        this._thumbScratchCtx = this._thumbScratchCanvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });
      }
      if (this._thumbScratchCanvas.width !== width) this._thumbScratchCanvas.width = width;
      if (this._thumbScratchCanvas.height !== height) this._thumbScratchCanvas.height = height;
      return {
        chromeWin,
        canvas: this._thumbScratchCanvas,
        ctx: this._thumbScratchCtx,
      };
    }

    async _encodeThumbJpegAsync(rgbaBuf, width, height) {
      const chromeWin =
        Services.wm.getMostRecentWindow("navigator:browser") || Services.wm.getMostRecentWindow(null);
      if (!chromeWin || typeof chromeWin.ImageData !== "function") {
        return null;
      }
      const byteLen = width * height * 4;
      const imgData = new chromeWin.ImageData(new Uint8ClampedArray(rgbaBuf, 0, byteLen), width, height);

      // Prefer OffscreenCanvas.convertToBlob() so JPEG encoding runs off the main UI thread!
      if (typeof chromeWin.OffscreenCanvas === "function" && typeof chromeWin.FileReader === "function") {
        try {
          const oc = new chromeWin.OffscreenCanvas(width, height);
          const ctx = oc.getContext("2d", { alpha: false });
          if (ctx && typeof oc.convertToBlob === "function") {
            ctx.putImageData(imgData, 0, 0);
            const blob = await oc.convertToBlob({ type: "image/jpeg", quality: 0.85 });
            if (blob && blob.size > 0) {
              const dataUrl = await new Promise((resolve, reject) => {
                const fr = new chromeWin.FileReader();
                fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
                fr.onerror = () => reject(fr.error || new Error("FileReader error"));
                fr.readAsDataURL(blob);
              });
              if (dataUrl) return dataUrl;
            }
          }
        } catch {}
      }

      // Synchronous fallback when OffscreenCanvas/convertToBlob is unavailable
      const scratch = this._getThumbScratchContext(width, height);
      if (!scratch || !scratch.ctx) return null;
      scratch.ctx.putImageData(imgData, 0, 0);
      return scratch.canvas.toDataURL("image/jpeg", 0.85);
    }

    async _renderThumbnailFast(state, rawPv, rawThumbs, origRender, pageIndex) {
      const cfg = this.engine.getConfig();
      if (this._destroyed || !this.engine.isEnabled() || !cfg.renderThumbnails) {
        return origRender.call(rawThumbs, pageIndex);
      }

      const iframeWin = state.iframeWin;
      if (!iframeWin || iframeWin.closed) return;

      // Keep Zotero's exact already-rendered fast-exit check
      const existing = rawThumbs._thumbnails?.[pageIndex];
      if (existing?.image && !existing.forceRerender) {
        if (rawThumbs._onRender) {
          rawThumbs._onRender(existing);
        }
        return;
      }

      // Pages that carry Zotero annotations (highlights/notes/ink/underlines) delegate cleanly to Zotero's
      // annotation overlay path (which still uses our MuPDF pdfPage.render hook for the base page!)
      try {
        const annots = rawPv._annotations;
        if (annots && annots.length > 0) {
          for (let i = 0; i < annots.length; i++) {
            if (annots[i]?.position?.pageIndex === pageIndex) {
              return origRender.call(rawThumbs, pageIndex);
            }
          }
        }
      } catch {}

      try {
        let path = state.filePath;
        if (!path) {
          path = await state.filePathPromise;
          if (!path) {
            path = await this._resolveFilePath(state.reader);
            state.filePath = path;
          }
        }
        if (!path) {
          return origRender.call(rawThumbs, pageIndex);
        }

        // Respect active light/dark/sepia theme for thumbnails too
        let theme = null;
        try {
          const viewerTheme = rawPv._iframeWindow?.theme;
          if (viewerTheme && viewerTheme.background && viewerTheme.foreground) {
            theme = {
              background: String(viewerTheme.background),
              foreground: String(viewerTheme.foreground),
              invertImages: !!viewerTheme.invertImages,
            };
          }
        } catch {}

        // Render at exact HiDPI resolution (120 * dpr <= 240px) — NO 4x DRAW_UPSCALE_FACTOR waste,
        // NO _reduceImage() downsampling, NO pdfDocument.getPage() stall behind getProcessedData()!
        const dpr = Math.min(2, Math.max(1, Number(iframeWin.devicePixelRatio) || 1));
        const targetW = Math.round(120 * dpr);
        const maxH = Math.round(targetW * 2.2);
        const reqKey = `thumb:${this.nextThumbReqId++}`;

        const res = await this.engine.renderThumb(reqKey, {
          path,
          password: state.password || "",
          pageIndex,
          targetW,
          maxH,
          aaLevel: 4,
          theme,
        });

        if (this._destroyed || iframeWin.closed || !res?.buf || res.width <= 0 || res.height <= 0) {
          return;
        }

        const dataUrl = await this._encodeThumbJpegAsync(res.buf, res.width, res.height);
        if (this._destroyed || iframeWin.closed) return;
        if (!dataUrl) {
          return origRender.call(rawThumbs, pageIndex);
        }

        const cssW = 120;
        const cssH = Math.max(20, Math.round((cssW * res.height) / Math.max(1, res.width)));
        const renderedThumbnail = Cu.cloneInto(
          {
            pageIndex,
            width: cssW,
            height: cssH,
            image: dataUrl,
          },
          iframeWin
        );

        if (!rawThumbs._thumbnails || typeof rawThumbs._thumbnails.slice !== "function") {
          return origRender.call(rawThumbs, pageIndex);
        }
        const nextArr = rawThumbs._thumbnails.slice();
        nextArr[pageIndex] = renderedThumbnail;
        rawThumbs._thumbnails = nextArr;

        try {
          const vWin = rawThumbs._window?.wrappedJSObject || rawThumbs._window;
          if (vWin?.PDFViewerApplication?.eventBus?.dispatch) {
            const evObj = new vWin.Object();
            evObj.source = rawThumbs;
            evObj.pageNumber = pageIndex + 1;
            vWin.PDFViewerApplication.eventBus.dispatch("thumbnailrendered", evObj);
          }
        } catch {}

        if (rawThumbs._onRender) {
          rawThumbs._onRender(renderedThumbnail);
        } else if (rawThumbs._onUpdate) {
          rawThumbs._onUpdate(rawThumbs._thumbnails);
        }
      } catch (e) {
        if (!e?.isCancelled) {
          this.engine.log("fast thumbnail fallback:", e?.message || String(e));
          return origRender.call(rawThumbs, pageIndex);
        }
      }
    }

    _attachViewerWindow(state, viewerWin) {
      if (this._destroyed || !viewerWin) return;
      const xrayWin = typeof Cu.unwaiveXrays === "function" ? Cu.unwaiveXrays(viewerWin) : viewerWin;
      if (xrayWin.closed) return;
      const rawWin = xrayWin.wrappedJSObject || viewerWin;
      if (rawWin.__zotMuPDFPatched) {
        try {
          rawWin.__zotMuPDFControl?.ensureAttached?.();
        } catch {}
        return;
      }
      if (state.attachedWins.has(rawWin)) {
        return;
      }
      // CRITICAL: Wait until viewer.mjs (<script type="module">) has finished executing and defined
      // window.PDFViewerApplication! Injecting before PDFViewerApplication exists would mark the window
      // patched while leaving PDFPageProxy.prototype.render completely unhooked on new documents!
      if (!rawWin.PDFViewerApplication || !xrayWin.document) {
        return;
      }

      state.attachedWins.add(rawWin);
      const viewerKey = `v${this.nextViewerId++}`;

      if (this.engine.isEnabled()) {
        this.engine.ensureStarted().catch(() => {});
      }

      const bridge = Cu.cloneInto(
        {
          isEnabled: () => this.engine.isEnabled(),
          getConfig: () => Cu.cloneInto(this.engine.getConfig(), xrayWin),
          setPassword: pw => {
            if (typeof pw === "string") {
              state.password = pw;
            }
          },
          cancelRequest: reqId => {
            this.engine.cancelRequest(`${viewerKey}:${reqId}`);
          },
          reportFallback: reason => {
            this.engine.reportFallback(reason);
          },
          reportMuPDFPaint: (e2eMs, paintMs, paintMode, isMainPage) => {
            this.engine.reportMuPDFPaint(Number(e2eMs), Number(paintMs), String(paintMode || ""), !!isMainPage);
          },
          reportTextLayerTiming: ms => {
            this.engine.reportTextLayerTiming(Number(ms));
          },
          reportPdfJsTiming: ms => {
            this.engine.reportPdfJsTiming(Number(ms));
          },
          renderPage: (reqJSON, targetCanvas, providedCtx, isCancelledFn, onPainted, onFallbackRgba, onError) => {
            let parsed;
            try {
              parsed = JSON.parse(String(reqJSON));
            } catch {
              try {
                onError("invalid request json", false);
              } catch {}
              return;
            }

            const reqKey = `${viewerKey}:${parsed.reqId}`;
            const checkCancelled = () => {
              if (this._destroyed || xrayWin.closed) return true;
              try {
                return !!isCancelledFn();
              } catch {
                return true;
              }
            };

            (async () => {
              let path = state.filePath;
              if (!path) {
                path = await state.filePathPromise;
                if (!path) {
                  path = await this._resolveFilePath(state.reader);
                  state.filePath = path;
                }
              }
              if (!path) {
                throw new Error("PDF local file path unavailable");
              }

              await this.engine.ensureStarted();
              if (checkCancelled()) return;

              const isMainPage = !!parsed.isMainPage;
              const priority = isMainPage ? 0 : 1;

              const payload = {
                path,
                password: state.password || "",
                pageIndex: parsed.pageIndex | 0,
                width: parsed.width | 0,
                height: parsed.height | 0,
                matrix: parsed.matrix,
                includeAnnots: !!parsed.includeAnnots,
                aaLevel: parsed.aaLevel || 8,
                theme: parsed.theme || null,
              };

              const res = await this.engine.renderPage(reqKey, payload, { priority });

              if (checkCancelled()) {
                if (res.buf) this.engine.recycleBuffer(res.buf);
                return;
              }

              // Validate page bounds before touching the canvas
              if (
                res.pageW > 0 &&
                res.pageH > 0 &&
                parsed.baseW > 0 &&
                parsed.baseH > 0 &&
                (Math.abs(res.pageW - parsed.baseW) > 2.5 || Math.abs(res.pageH - parsed.baseH) > 2.5)
              ) {
                if (res.buf) this.engine.recycleBuffer(res.buf);
                throw new Error(
                  `page-bounds-mismatch:${res.pageW.toFixed(1)}x${res.pageH.toFixed(1)}-vs-${parsed.baseW.toFixed(1)}x${parsed.baseH.toFixed(1)}`
                );
              }

              const xrayCanvas = targetCanvas
                ? typeof Cu.unwaiveXrays === "function"
                  ? Cu.unwaiveXrays(targetCanvas)
                  : targetCanvas
                : null;
              if (!xrayCanvas || xrayCanvas.width !== res.width || xrayCanvas.height !== res.height) {
                if (res.buf) this.engine.recycleBuffer(res.buf);
                throw new Error("canvas-size-mismatch");
              }

              const useSwCanvas = this.engine.useSoftwareCanvas();
              const xrayCtx = providedCtx
                ? typeof Cu.unwaiveXrays === "function"
                  ? Cu.unwaiveXrays(providedCtx)
                  : providedCtx
                : xrayCanvas.getContext("2d", { alpha: false, willReadFrequently: useSwCanvas });

              // PATH 1 (Zero-copy Chrome direct putImageData onto Skia surface -> async WebRender GPU upload!)
              // Visible pages paint in 1 shot (zero tearing); large offscreen pre-render pages (+1) paint in
              // 4 horizontal strips (~7ms each, <1 frame) with 4ms yields so scrolling NEVER hits a 31ms jank spike!
              if (res.buf && xrayCtx) {
                const chromeWin =
                  Services.wm.getMostRecentWindow("navigator:browser") || Services.wm.getMostRecentWindow(null);
                if (chromeWin && typeof chromeWin.ImageData === "function") {
                  let paintedOk = false;
                  let paintMs = 0;
                  let yieldMs = 0;
                  const shouldSlice =
                    parsed.isVisible === false &&
                    isMainPage &&
                    res.height >= 800 &&
                    res.width * res.height >= 1500000;
                  try {
                    const imgData = new chromeWin.ImageData(
                      new Uint8ClampedArray(res.buf),
                      res.width,
                      res.height
                    );
                    if (shouldSlice) {
                      // Use 6 strips for giant 2.8K/4K canvases (>4.5MP) so each strip stays <5ms inside 120Hz frames
                      const STRIPS = res.width * res.height >= 4500000 ? 6 : 4;
                      const yieldNextFrame = () =>
                        new Promise(resolve => {
                          let done = false;
                          const finish = () => {
                            if (done) return;
                            done = true;
                            resolve();
                          };
                          const tId = setTimeout(finish, 16);
                          try {
                            if (typeof xrayWin.requestAnimationFrame === "function") {
                              xrayWin.requestAnimationFrame(() => {
                                clearTimeout(tId);
                                finish();
                              });
                            }
                          } catch {}
                        });
                      let abortedMidSlice = false;
                      for (let s = 0; s < STRIPS; s++) {
                        if (checkCancelled() || xrayCanvas.width !== res.width || xrayCanvas.height !== res.height) {
                          abortedMidSlice = true;
                          break;
                        }
                        const y0 = Math.floor((s * res.height) / STRIPS);
                        const y1 = Math.floor(((s + 1) * res.height) / STRIPS);
                        const sh = y1 - y0;
                        if (sh > 0) {
                          const ts0 = nowMs();
                          xrayCtx.putImageData(imgData, 0, 0, 0, y0, res.width, sh);
                          paintMs += nowMs() - ts0;
                        }
                        if (s + 1 < STRIPS) {
                          const ty0 = nowMs();
                          await yieldNextFrame();
                          yieldMs += nowMs() - ty0;
                        }
                      }
                      if (abortedMidSlice || checkCancelled()) {
                        this.engine.recycleBuffer(res.buf);
                        return;
                      }
                      paintedOk = true;
                    } else {
                      const tPaint0 = nowMs();
                      xrayCtx.putImageData(imgData, 0, 0);
                      paintMs = nowMs() - tPaint0;
                      paintedOk = true;
                    }
                  } catch (directErr) {
                    this.engine.log("direct Chrome putImageData fallback:", directErr?.message || String(directErr));
                  }
                  if (paintedOk) {
                    this.engine.recycleBuffer(res.buf);
                    const mode = shouldSlice
                      ? useSwCanvas
                        ? "skia-sliced"
                        : "direct-sliced"
                      : useSwCanvas
                        ? "skia"
                        : "direct";
                    try {
                      onPainted(paintMs, mode, yieldMs);
                    } catch {}
                    return;
                  }
                }
              }

              // PATH 2 (Guaranteed safe fallback): Cu.cloneInto + page-side putImageData (still recycles warm buf!)
              if (res.buf) {
                const tClone0 = nowMs();
                const clonedU8 = Cu.cloneInto(new Uint8Array(res.buf), xrayWin);
                const cloneMs = nowMs() - tClone0;
                this.engine.recycleBuffer(res.buf);
                onFallbackRgba(clonedU8, res.width, res.height, cloneMs);
                return;
              }

              throw new Error("empty-render-buffer");
            })().catch(err => {
              if (this._destroyed || xrayWin.closed) return;
              try {
                onError(String(err?.message || err), !!err?.isCancelled);
              } catch {}
            });
          },
        },
        xrayWin,
        { cloneFunctions: true }
      );

      rawWin.__zotMuPDFBridge = bridge;

      const doc = xrayWin.document;
      const script = doc.createElement("script");
      script.textContent = this.pagePatchSource;
      (doc.head || doc.documentElement).appendChild(script);
      script.remove();

      const entry = {
        viewerWin: xrayWin,
        rawWin,
        viewerKey,
        onUnload: null,
      };
      entry.onUnload = () => {
        this.viewerEntries.delete(entry);
        state.viewerEntries.delete(entry);
      };
      try {
        xrayWin.addEventListener("unload", entry.onUnload);
      } catch {}
      this.viewerEntries.add(entry);
      state.viewerEntries.add(entry);

      try {
        if (this.engine.isEnabled() && rawWin.PDFViewerApplication?.pdfDocument) {
          rawWin.__zotMuPDFControl?.refreshAllPages?.();
        }
      } catch {}
    }

    _detachReader(key) {
      const state = this.readerStates.get(key);
      if (!state) return;
      this.readerStates.delete(key);

      const closedPath = state.filePath || "";

      // CRITICAL: Release all thumbHooks & viewerEntries belonging to this closed tab so Gecko GC/CC
      // immediately reclaims the closed PDFView, DOM canvases, and GPU WebRender textures!
      if (state.thumbHooks) {
        for (const th of Array.from(state.thumbHooks)) {
          this._disposeThumbHook(th, true);
        }
        state.thumbHooks.clear();
      }

      if (state.viewerEntries) {
        for (const entry of Array.from(state.viewerEntries)) {
          this.viewerEntries.delete(entry);
          try {
            if (entry.viewerWin && !entry.viewerWin.closed && entry.onUnload) {
              entry.viewerWin.removeEventListener("unload", entry.onUnload);
            }
          } catch {}
        }
        state.viewerEntries.clear();
      }

      try {
        if (state.iframeWin && !state.iframeWin.closed) {
          if (state.webViewerHandler) {
            state.iframeWin.document.removeEventListener("webviewerloaded", state.webViewerHandler, true);
          }
          if (state.unloadHandler) {
            state.iframeWin.removeEventListener("unload", state.unloadHandler);
          }
        }
      } catch {}

      state.reader = null;
      state.iframeWin = null;
      state.webViewerHandler = null;
      state.unloadHandler = null;

      // Immediately evict native MuPDF caches & release file handles for closed PDF if no other tab uses it
      if (closedPath && !this._destroyed) {
        let stillOpen = false;
        for (const other of this.readerStates.values()) {
          if (other.filePath === closedPath) {
            stillOpen = true;
            break;
          }
        }
        if (!stillOpen) {
          try {
            this.engine.evictPath?.(closedPath);
          } catch {}
        }
      }
    }

    refreshAllViewers(coldReset = false) {
      for (const entry of Array.from(this.viewerEntries)) {
        try {
          if (entry.viewerWin.closed) {
            this.viewerEntries.delete(entry);
            continue;
          }
          entry.rawWin.__zotMuPDFControl?.refreshAllPages?.(coldReset);
        } catch {}
      }
    }

    _ensureToolbarStyles(doc) {
      try {
        const existing = doc.getElementById("zot-mupdf-toolbar-style");
        if (existing) existing.remove();
        const style = doc.createElement("style");
        style.id = "zot-mupdf-toolbar-style";
        style.textContent = `
          .toolbar .custom-sections {
            align-items: center;
          }
          .toolbar .custom-sections .section:has(.zot-mupdf-toggle) {
            display: inline-flex;
            align-items: center;
            flex: 0 0 auto;
          }
          button.zot-mupdf-toggle {
            appearance: none;
            display: inline-flex;
            align-items: center;
            justify-content: space-between;
            gap: 4px;
            width: 114px !important;
            min-width: 114px !important;
            max-width: 114px !important;
            height: 24px;
            padding: 0 7px;
            margin: 0 4px;
            box-sizing: border-box;
            flex: 0 0 114px;
            overflow: hidden;
            border-radius: 5px;
            border: 1px solid var(--fill-quinary, rgba(128, 128, 128, 0.28));
            background: transparent;
            color: var(--fill-secondary, inherit);
            font-family: inherit;
            font-size: 11px;
            font-weight: 600;
            line-height: 1;
            white-space: nowrap;
            cursor: pointer;
            user-select: none;
            -moz-window-dragging: no-drag;
            transition: background-color 120ms ease, border-color 120ms ease;
          }
          button.zot-mupdf-toggle:hover {
            background-color: var(--fill-quinary, rgba(128, 128, 128, 0.12));
          }
          button.zot-mupdf-toggle:active {
            background-color: var(--fill-quaternary, rgba(128, 128, 128, 0.22));
          }
          button.zot-mupdf-toggle .zot-mupdf-left,
          button.zot-mupdf-toggle .zot-mupdf-dot,
          button.zot-mupdf-toggle .zot-mupdf-name,
          button.zot-mupdf-toggle .zot-mupdf-metric {
            pointer-events: none;
          }
          button.zot-mupdf-toggle .zot-mupdf-left {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            flex: 0 0 auto;
          }
          button.zot-mupdf-toggle .zot-mupdf-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            display: inline-block;
            flex: 0 0 auto;
            transition: background-color 150ms ease;
          }
          button.zot-mupdf-toggle .zot-mupdf-name {
            display: inline-block;
            white-space: nowrap;
          }
          button.zot-mupdf-toggle .zot-mupdf-metric {
            display: inline-block;
            flex: 1 1 auto;
            text-align: right;
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
            opacity: 0.92;
          }
          .zot-mupdf-ctxmenu {
            position: fixed;
            z-index: 99999;
            min-width: 196px;
            padding: 5px;
            border-radius: 8px;
            border: 1px solid var(--material-border, rgba(128, 128, 128, 0.3));
            background: var(--material-menu, var(--material-background, #ffffff));
            color: var(--fill-primary, #1f2937);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
            font-family: inherit;
            font-size: 12px;
            user-select: none;
          }
          @media (prefers-color-scheme: dark) {
            .zot-mupdf-ctxmenu {
              background: var(--material-menu, var(--material-background, #262626));
              color: var(--fill-primary, #f3f4f6);
            }
          }
          .zot-mupdf-ctxheader {
            padding: 4px 8px 6px;
            font-size: 11px;
            opacity: 0.72;
            font-variant-numeric: tabular-nums;
            border-bottom: 1px solid var(--material-border, rgba(128, 128, 128, 0.22));
            margin-bottom: 4px;
            white-space: nowrap;
          }
          .zot-mupdf-ctxitem {
            display: flex;
            align-items: center;
            width: 100%;
            box-sizing: border-box;
            padding: 5px 8px;
            border: none;
            border-radius: 5px;
            background: transparent;
            color: inherit;
            font: inherit;
            text-align: left;
            cursor: pointer;
            white-space: nowrap;
          }
          .zot-mupdf-ctxitem:hover {
            background: var(--fill-quinary, rgba(128, 128, 128, 0.16));
          }
          .zot-mupdf-ctxsep {
            height: 1px;
            background: var(--material-border, rgba(128, 128, 128, 0.22));
            margin: 4px 4px;
          }
        `;
        (doc.head || doc.documentElement).appendChild(style);
      } catch {}
    }

    _closeCapsuleMenu(doc) {
      try {
        const existing = doc?.querySelector?.(".zot-mupdf-ctxmenu");
        if (existing) {
          const cleanup = this._menuCleanups.get(existing);
          if (cleanup) {
            this._menuCleanups.delete(existing);
            cleanup();
          }
          existing.remove();
        }
      } catch {}
    }

    _flashCapsuleMetric(rec, label, durationMs = 2400) {
      try {
        rec._flashText = label;
        rec._flashUntil = Date.now() + durationMs;
        if (rec.metricEl) rec.metricEl.textContent = label;
        setTimeout(() => {
          if (rec._flashUntil <= Date.now()) {
            rec._flashText = "";
            rec._flashUntil = 0;
            this._applyButtonState(rec, this.engine.getSummary());
          }
        }, durationMs + 40);
      } catch {}
    }

    _toggleEngineMode(rec, coldReset = false) {
      const next = !this.engine.isEnabled();
      this.engine.setEnabled(next);
      if (coldReset) {
        this._flashCapsuleMetric(rec, next ? "冷启Mu" : "冷切JS", 1500);
      }
      const runRefresh = () => this.refreshAllViewers(coldReset);
      if (coldReset) {
        this.engine.evictCache().finally(() => {
          if (next) {
            this.engine.ensureStarted().then(runRefresh).catch(runRefresh);
          } else {
            runRefresh();
          }
        });
      } else if (next) {
        this.engine.ensureStarted().then(runRefresh).catch(runRefresh);
      } else {
        runRefresh();
      }
    }

    _openCapsuleMenu(rec, ev = null) {
      const doc = rec?.doc;
      const win = doc?.defaultView;
      if (!doc || !win || win.closed) return;
      const now = Date.now();
      if (rec._lastMenuAt && now - rec._lastMenuAt < 180) return;
      rec._lastMenuAt = now;
      this._closeCapsuleMenu(doc);

      const turbo = Zotero.ZotTurbo || null;
      let statusLabel = "Zotero Turbo 快捷控制";
      try {
        const mem = turbo?.systemAccel?.getMemorySnapshot?.();
        const tabs = turbo?.tabHibernator?.getStats?.();
        const rssStr = mem?.ok ? `主进程 RSS ${mem.residentMB.toFixed(0)} MB` : "Zotero Turbo";
        const tabStr = tabs ? ` · ${tabs.activeReaders} 活跃 / ${tabs.hibernatedTabs} 休眠` : "";
        statusLabel = rssStr + tabStr;
      } catch {}

      const actionDeepReclaim = async () => {
        if (!turbo?.deepReclaimMemory) return;
        this._flashCapsuleMetric(rec, "释放中", 6000);
        try {
          const res = await turbo.deepReclaimMemory();
          const freed = Math.round(res?.freedMB || 0);
          this._flashCapsuleMetric(rec, freed > 0 ? `-${freed}M` : "已释放", 2600);
        } catch {
          this._flashCapsuleMetric(rec, "已释放", 1800);
        }
      };

      const actionHibernateOthers = () => {
        const n = turbo?.tabHibernator?.hibernateAllBackground?.({ includeNotes: false }) || 0;
        this._flashCapsuleMetric(rec, n > 0 ? `休眠${n}` : "无后台", 2200);
      };

      const actionTrimCache = async () => {
        if (turbo?.trimRenderCache) {
          await turbo.trimRenderCache().catch(() => {});
        } else {
          this.engine.trimMemory(true);
        }
        this._flashCapsuleMetric(rec, "已清缓存", 2000);
      };

      const actionColdToggle = () => {
        this._toggleEngineMode(rec, true);
      };

      const actionOpenPrefs = () => {
        turbo?.openPreferences?.();
      };

      const openHtmlFallback = () => {
        if (!doc.body) return;
        const menu = doc.createElement("div");
        menu.className = "zot-mupdf-ctxmenu";

        const header = doc.createElement("div");
        header.className = "zot-mupdf-ctxheader";
        header.textContent = statusLabel;
        menu.appendChild(header);

        const addItem = (label, onClick) => {
          const item = doc.createElement("button");
          item.type = "button";
          item.className = "zot-mupdf-ctxitem";
          item.textContent = label;
          item.addEventListener("click", clickEv => {
            clickEv.stopPropagation();
            this._closeCapsuleMenu(doc);
            try {
              onClick();
            } catch {}
          });
          menu.appendChild(item);
        };

        addItem("🧠 深度释放内存", actionDeepReclaim);
        addItem("💤 休眠其他后台标签", actionHibernateOthers);
        addItem("🧹 仅清 MuPDF 缓存", actionTrimCache);
        addItem(
          this.engine.isEnabled() ? "🔄 冷切换到 PDF.js" : "🔄 冷启动回 MuPDF",
          actionColdToggle
        );

        const sep = doc.createElement("div");
        sep.className = "zot-mupdf-ctxsep";
        menu.appendChild(sep);

        addItem("⚙️ 打开 Zotero Turbo 设置", actionOpenPrefs);

        doc.body.appendChild(menu);

        try {
          const rect = rec.btn.getBoundingClientRect();
          const menuW = menu.offsetWidth || 204;
          const menuH = menu.offsetHeight || 180;
          const vw = win.innerWidth || 800;
          const vh = win.innerHeight || 600;
          const left = Math.max(8, Math.min(rect.right - menuW, vw - menuW - 8));
          const top = Math.max(8, Math.min(rect.bottom + 4, vh - menuH - 8));
          menu.style.left = `${Math.round(left)}px`;
          menu.style.top = `${Math.round(top)}px`;
        } catch {}

        const onOutside = mEv => {
          if (!menu.contains(mEv.target)) this._closeCapsuleMenu(doc);
        };
        const onKey = kEv => {
          if (kEv.key === "Escape") this._closeCapsuleMenu(doc);
        };
        const onBlur = () => this._closeCapsuleMenu(doc);
        this._menuCleanups.set(menu, () => {
          try {
            doc.removeEventListener("mousedown", onOutside, true);
            doc.removeEventListener("keydown", onKey, true);
            win.removeEventListener("blur", onBlur);
          } catch {}
        });
        doc.addEventListener("mousedown", onOutside, true);
        doc.addEventListener("keydown", onKey, true);
        win.addEventListener("blur", onBlur, { once: true });
      };

      // Primary path: Zotero 10's native XUL <menupopup> via reader._openContextMenu()!
      if (rec.reader && typeof rec.reader._openContextMenu === "function") {
        try {
          const rect = rec.btn.getBoundingClientRect();
          const x = ev && Number.isFinite(ev.clientX) && ev.clientX > 0 ? ev.clientX : rect.left;
          const y = ev && Number.isFinite(ev.clientY) && ev.clientY > 0 ? ev.clientY : rect.bottom + 4;
          const itemGroups = [
            [{ label: statusLabel, disabled: true, onCommand: () => {} }],
            [
              { label: "🧠 深度释放内存", disabled: false, onCommand: actionDeepReclaim },
              { label: "💤 休眠其他后台标签", disabled: false, onCommand: actionHibernateOthers },
              { label: "🧹 仅清 MuPDF 缓存", disabled: false, onCommand: actionTrimCache },
              {
                label: this.engine.isEnabled() ? "🔄 冷切换到 PDF.js (清缓存对比)" : "🔄 冷启动回 MuPDF (清缓存对比)",
                disabled: false,
                onCommand: actionColdToggle,
              },
            ],
            [{ label: "⚙️ 打开 Zotero Turbo 设置", disabled: false, onCommand: actionOpenPrefs }],
          ];
          Promise.resolve(rec.reader._openContextMenu({ x: Math.round(x), y: Math.round(y), itemGroups })).catch(
            err => {
              Zotero.debug("[ZotTurbo] Native capsule menu fallback: " + (err?.message || String(err)));
              openHtmlFallback();
            }
          );
          return;
        } catch (err) {
          Zotero.debug("[ZotTurbo] Native capsule menu error: " + (err?.message || String(err)));
        }
      }

      openHtmlFallback();
    }

    _renderToolbarButton(event) {
      const rawDoc = event?.doc;
      const append = event?.append;
      if (!rawDoc || !append) return;
      // CRITICAL: Zotero 10 dispatches renderToolbar with event.detail.wrappedJSObject (Xray-waived!).
      // Unwaiving Xrays ensures Chrome click/contextmenu listeners & DOM APIs never hit Xray permission blocks!
      const doc = typeof Cu.unwaiveXrays === "function" ? Cu.unwaiveXrays(rawDoc) : rawDoc;

      try {
        const existingBtn = doc.querySelector(".toolbar .zot-mupdf-toggle");
        if (existingBtn) {
          const ownedByUs = Array.from(this.toolbarButtons).some(r => r.btn === existingBtn);
          if (ownedByUs) return;
          const oldSec = existingBtn.closest?.(".zot-mupdf-section");
          if (oldSec) oldSec.remove();
          else existingBtn.remove();
        }
      } catch {}

      this._ensureToolbarStyles(doc);

      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "zot-mupdf-toggle";

      const left = doc.createElement("span");
      left.className = "zot-mupdf-left";

      const dot = doc.createElement("span");
      dot.className = "zot-mupdf-dot";

      const nameEl = doc.createElement("span");
      nameEl.className = "zot-mupdf-name";

      left.appendChild(dot);
      left.appendChild(nameEl);

      const metricEl = doc.createElement("span");
      metricEl.className = "zot-mupdf-metric";

      btn.appendChild(left);
      btn.appendChild(metricEl);

      const rec = { reader: event.reader || null, doc, btn, dot, nameEl, metricEl };

      btn.addEventListener("click", ev => {
        const coldReset = !!ev.shiftKey;
        this._toggleEngineMode(rec, coldReset);
      });

      // CRITICAL: Zotero 10's reader.js:81605 calls event.preventDefault() on bubbling `pointerdown` for
      // toolbar buttons, which in Firefox/Gecko suppresses `mousedown` & `contextmenu` completely!
      // Stopping right-click `pointerdown` propagation BEFORE it reaches window restores `contextmenu` 100%,
      // and handling `auxclick` (button===2) guarantees even touch/remote-desktop right-clicks always open it!
      btn.addEventListener(
        "pointerdown",
        ev => {
          if (ev.button === 2) {
            ev.stopPropagation();
          }
        },
        true
      );

      btn.addEventListener(
        "contextmenu",
        ev => {
          ev.preventDefault();
          ev.stopPropagation();
          this._openCapsuleMenu(rec, ev);
        },
        true
      );

      btn.addEventListener(
        "auxclick",
        ev => {
          if (ev.button === 2) {
            ev.preventDefault();
            ev.stopPropagation();
            this._openCapsuleMenu(rec, ev);
          }
        },
        true
      );

      // Append to DOM FIRST so rec.btn.isConnected === true before _applyButtonState runs!
      append(btn);
      this.toolbarButtons.add(rec);
      this._applyButtonState(rec, this.engine.getSummary());
      try {
        doc.defaultView?.addEventListener("unload", () => {
          this._closeCapsuleMenu(doc);
          this.toolbarButtons.delete(rec);
        });
      } catch {}
    }

    _applyButtonState(rec, summary) {
      if (!rec.btn || !rec.btn.isConnected || !rec.doc || rec.doc.defaultView?.closed) {
        this.toolbarButtons.delete(rec);
        return;
      }
      const fmtMs = v => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
      const fmtCompact = v => {
        if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
        if (v < 10) return `${v.toFixed(1)}ms`;
        return `${Math.round(v)}ms`;
      };
      const compareLine =
        summary.pdfjsRenders > 0
          ? `\n对比 PDF.js 实测: 最近 ${fmtMs(summary.pdfjsLastMs)}ms | 均值 ${fmtMs(summary.pdfjsAvgMs)}ms (${summary.pdfjsRenders} 次)`
          : "";
      const textLayerLine =
        summary.lastTextLayerMs > 0
          ? `\nPDF.js 文本层耗时: 最近 ${fmtMs(summary.lastTextLayerMs)}ms（后台异步，不阻塞翻页绘制）`
          : "";
      const thumbLine =
        summary.thumbCount > 0
          ? `\n侧栏缩略图加速: 已渲染 ${summary.thumbCount} 张（最近 ${fmtMs(summary.thumbLastMs)}ms · ${summary.fgWorkers || 2}线程直出）`
          : "";

      const applyDom = (nameText, dotColor, metricText, titleText) => {
        if (rec._lastName !== nameText) {
          rec._lastName = nameText;
          rec.nameEl.textContent = nameText;
        }
        if (rec._lastDot !== dotColor) {
          rec._lastDot = dotColor;
          rec.dot.style.backgroundColor = dotColor;
        }
        if (rec._lastMetric !== metricText) {
          rec._lastMetric = metricText;
          rec.metricEl.textContent = metricText;
        }
        if (rec._lastTitle !== titleText) {
          rec._lastTitle = titleText;
          rec.btn.title = titleText;
        }
      };

      if (summary.enabled) {
        if (summary.lastError && !summary.ready) {
          applyDom(
            "MuPDF",
            "#dc2626",
            "ERR",
            `Zotero MuPDF Engine 启动失败（已自动回退 PDF.js）\n错误: ${summary.lastError}`
          );
          return;
        }
        let dotColor = summary.ready ? "#16a34a" : "#eab308";
        let metricText = summary.ready ? "就绪" : "…";
        if (rec._flashText && rec._flashUntil > Date.now()) {
          dotColor = "#16a34a";
          metricText = rec._flashText;
        } else if (summary.busy) {
          dotColor = "#f59e0b";
          metricText = "⏳";
        } else if (summary.totalRenders > 0) {
          const shownMs = summary.lastE2EMs > 0 ? summary.lastE2EMs : summary.lastRenderMs;
          const tag = summary.lastCacheTier === "pix" ? "⚡" : "";
          metricText = `${tag}${fmtCompact(shownMs)}`;
        }
        const pixPct = summary.totalRenders > 0 ? Math.round((summary.pixHits / summary.totalRenders) * 100) : 0;
        const verStr = summary.mupdfVersion ? `MuPDF ${summary.mupdfVersion} 进程内无锁 DLL` : "MuPDF 进程内";
        const workerStr = summary.workers ? `, ${summary.workers} 线程` : "";
        const modeLabel =
          summary.paintMode === "skia"
            ? "Skia零拷贝"
            : summary.paintMode === "skia-sliced"
              ? "Skia分帧"
              : summary.paintMode === "direct"
                ? "GPU零拷贝"
                : summary.paintMode === "direct-sliced"
                  ? "GPU分帧"
                  : summary.paintMode === "clone"
                    ? "克隆回退"
                    : "";
        const sizeLabel =
          summary.lastWidth > 0 && summary.lastHeight > 0 ? ` ${summary.lastWidth}×${summary.lastHeight}` : "";
        const modeSuffix = modeLabel ? ` · ${modeLabel}${sizeLabel}` : "";
        const ipcTotalMs = (summary.lastQueueMs || 0) + (summary.lastIpcMs || 0);
        const titleText =
          `Zotero MuPDF Engine (${verStr}${workerStr})\n` +
          `状态: 已启用（单击切换 PDF.js；右键快捷内存菜单；Shift+单击清缓存冷启动对比）\n` +
          `最近端到端: ${fmtMs(summary.lastE2EMs)}ms（引擎 ${fmtMs(summary.lastRenderMs)}ms · 通信 ${fmtMs(ipcTotalMs)}ms · 绘制 ${fmtMs(summary.lastPaintMs)}ms${modeSuffix}）\n` +
          `总渲染: ${summary.totalRenders} 次 | 预渲染位图命中: ${pixPct}% | 均值: ${fmtMs(summary.avgE2EMs || summary.avgRenderMs)}ms | 取消: ${summary.cancelledRenders || 0} | 回退: ${summary.fallbacks}` +
          thumbLine +
          textLayerLine +
          compareLine +
          (summary.lastFallbackReason ? `\n最近回退原因: ${summary.lastFallbackReason}` : "");
        applyDom("MuPDF", dotColor, metricText, titleText);
      } else {
        const metricText =
          rec._flashText && rec._flashUntil > Date.now()
            ? rec._flashText
            : summary.pdfjsRenders > 0
              ? fmtCompact(summary.pdfjsLastMs)
              : "原生";
        const titleText =
          `Zotero MuPDF Engine\n` +
          `状态: 已暂停（当前使用原生 PDF.js，单击切回 MuPDF；右键快捷内存菜单；Shift+单击冷启动对比）` +
          compareLine;
        applyDom("PDF.js", "#9ca3af", metricText, titleText);
      }
    }

    _updateAllToolbarButtons(summary) {
      for (const rec of Array.from(this.toolbarButtons)) {
        let alive = false;
        try {
          alive = !!(rec.btn && rec.btn.isConnected && rec.doc && !rec.doc.defaultView?.closed);
        } catch {
          alive = false;
        }
        if (!alive) {
          this.toolbarButtons.delete(rec);
          continue;
        }
        try {
          this._applyButtonState(rec, summary);
        } catch (e) {
          // Never orphan a still-connected button on a transient DOM/Xray error!
          this.engine.log("toolbar button update skipped:", e?.message || String(e));
        }
      }
    }

    shutdown() {
      this._destroyed = true;

      if (this._unsubStats) {
        this._unsubStats();
        this._unsubStats = null;
      }

      if (this._notifierID != null) {
        try {
          Zotero.Notifier.unregisterObserver(this._notifierID);
        } catch {}
        this._notifierID = null;
      }

      if (this._toolbarHandler && Zotero.Reader?.unregisterEventListener) {
        try {
          Zotero.Reader.unregisterEventListener("renderToolbar", this._toolbarHandler);
        } catch {}
        this._toolbarHandler = null;
      }

      if (this._origReaderOpen && Zotero.Reader) {
        if (Zotero.Reader.open === this._wrappedReaderOpen) {
          Zotero.Reader.open = this._origReaderOpen;
        }
        this._origReaderOpen = null;
        this._wrappedReaderOpen = null;
      }

      if (this._origReaderOpenPreview && Zotero.Reader) {
        if (Zotero.Reader.openPreview === this._wrappedReaderOpenPreview) {
          Zotero.Reader.openPreview = this._origReaderOpenPreview;
        }
        this._origReaderOpenPreview = null;
        this._wrappedReaderOpenPreview = null;
      }

      // Restore Zotero's original PDFThumbnails methods & concurrency
      for (const th of Array.from(this.thumbHooks)) {
        this._disposeThumbHook(th, true);
      }
      this.thumbHooks.clear();

      if (this._thumbScratchCanvas) {
        try {
          this._thumbScratchCanvas.width = 0;
          this._thumbScratchCanvas.height = 0;
        } catch {}
        this._thumbScratchCanvas = null;
        this._thumbScratchCtx = null;
      }

      for (const entry of Array.from(this.viewerEntries)) {
        try {
          if (!entry.viewerWin.closed) {
            entry.viewerWin.removeEventListener("unload", entry.onUnload);
            entry.rawWin.__zotMuPDFControl?.uninstall?.();
          }
        } catch {}
      }
      this.viewerEntries.clear();

      for (const key of Array.from(this.readerStates.keys())) {
        this._detachReader(key);
      }
      this.readerStates.clear();

      for (const rec of Array.from(this.toolbarButtons)) {
        try {
          this._closeCapsuleMenu(rec.doc);
          rec.doc?.getElementById("zot-mupdf-toolbar-style")?.remove();
          const sec = rec.btn.closest?.(".zot-mupdf-section");
          if (sec) sec.remove();
          else rec.btn.remove();
        } catch {}
      }
      this.toolbarButtons.clear();
    }
  }

  return { ReaderHook };
})();
