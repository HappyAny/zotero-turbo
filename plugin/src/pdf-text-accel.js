/* global Zotero, Services, Components, ChromeUtils */
"use strict";

var ZotTurboPDFTextAccel = (function () {
  const Cu = Components.utils;
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  class PDFTextAccelerator {
    constructor({ rootURI, nativeClient, getPref }) {
      this.rootURI = rootURI;
      this.native = nativeClient;
      this.getPref = getPref;
      this._origGetFullText = null;
      this._wrappedGetFullText = null;
      this._origGetRecognizerData = null;
      this._wrappedGetRecognizerData = null;
      this._origHasAnnotations = null;
      this._wrappedHasAnnotations = null;
      this._origIndexItems = null;
      this._wrappedIndexItems = null;
      this._origReaderOpen = null;
      this._wrappedReaderOpen = null;
      this._batchPrefetch = new Map(); // itemID -> { maxPages, seq, promise }
      this._activeBatchCursor = null; // { posById: Map<itemID, idx>, minIdx: number }
      this._notifierID = null;
      this._patchSource = "";
      this._patchedIframes = new WeakSet();
      this._viewerEntries = new Set(); // { rawWin, path, viewerWin, onUnload }
      this._destroyed = false;

      this.stats = {
        fulltextNativeCount: 0,
        fulltextFallbackCount: 0,
        fulltextTotalMs: 0,
        fulltextTotalPages: 0,
        batchPrefetchHits: 0,
        recognizerNativeCount: 0,
        recognizerFallbackCount: 0,
        recognizerTotalMs: 0,
        hasAnnotsNativeCount: 0,
        readerPageHits: 0,
        readerPageFallbacks: 0,
        readerPageTotalMs: 0,
        readerCharsExtracted: 0,
        ctrlfPages: 0,
        outlineHits: 0,
        outlineFallbacks: 0,
        outlineTotalMs: 0,
        pdfjsCleanups: 0,
      };
    }

    async init() {
      this._patchSource = await Zotero.File.getResourceAsync(this.rootURI + "src/reader-text-patch.js");
      this._hookPDFWorker();
      this._hookBatchIndexItems();
      this._hookReaders();
    }

    _hookPDFWorker() {
      if (!Zotero.PDFWorker) return;
      const self = this;

      // 1. Native getFullText
      if (typeof Zotero.PDFWorker.getFullText === "function") {
        const origGetFullText = Zotero.PDFWorker.getFullText;
        this._origGetFullText = origGetFullText;
        const wrappedGetFullText = async function zotTurboGetFullText(itemID, maxPages, isPriority, password) {
          if (
            self._destroyed ||
            !self.getPref("pdfFulltextEnabled", true) ||
            password
          ) {
            return origGetFullText.call(this, itemID, maxPages, isPriority, password);
          }

          try {
            const attachment = await Zotero.Items.getAsync(itemID);
            if (!attachment || !attachment.isPDFAttachment()) {
              return origGetFullText.call(this, itemID, maxPages, isPriority, password);
            }
            const path = await attachment.getFilePathAsync();
            if (!path) {
              return origGetFullText.call(this, itemID, maxPages, isPriority, password);
            }

            if (self._activeBatchCursor && self._activeBatchCursor.posById.has(itemID)) {
              const curIdx = self._activeBatchCursor.posById.get(itemID);
              if (curIdx > self._activeBatchCursor.minIdx) {
                self._activeBatchCursor.minIdx = curIdx;
                for (const [k, entry] of self._batchPrefetch) {
                  if (entry.seq < curIdx) self._batchPrefetch.delete(k);
                }
              }
            }

            let res;
            const prefetched = self._batchPrefetch.get(itemID);
            if (prefetched && prefetched.maxPages === (Number.isInteger(maxPages) ? maxPages : 0)) {
              self._batchPrefetch.delete(itemID);
              res = await prefetched.promise;
              if (res && res.ok) self.stats.batchPrefetchHits++;
            } else {
              res = await self.native.extractFulltext(path, Number.isInteger(maxPages) ? maxPages : 0);
            }
            if (res && res.ok && typeof res.text === "string") {
              const normalized = res.text.trim().normalize("NFC");
              self.stats.fulltextNativeCount++;
              self.stats.fulltextTotalMs += res.ms || 0;
              self.stats.fulltextTotalPages += res.extractedPages || 0;
              Zotero.debug(
                `[ZotTurbo] Native fulltext extracted ${res.extractedPages}/${res.totalPages} pages in ${(res.ms || 0).toFixed(1)} ms`
              );
              return {
                text: normalized,
                extractedPages: res.extractedPages,
                totalPages: res.totalPages,
              };
            }
          } catch (err) {
            Zotero.debug("[ZotTurbo] Native fulltext fallback: " + (err?.message || String(err)));
          }

          self.stats.fulltextFallbackCount++;
          return origGetFullText.call(this, itemID, maxPages, isPriority, password);
        };
        this._wrappedGetFullText = wrappedGetFullText;
        Zotero.PDFWorker.getFullText = wrappedGetFullText;
      }

      // 2. Native getRecognizerData (drag-and-drop PDF metadata recognition!)
      if (typeof Zotero.PDFWorker.getRecognizerData === "function") {
        const origGetRec = Zotero.PDFWorker.getRecognizerData;
        this._origGetRecognizerData = origGetRec;
        const wrappedGetRec = async function zotTurboGetRecognizerData(itemID, isPriority, password) {
          if (
            self._destroyed ||
            !self.getPref("pdfRecognizerEnabled", true) ||
            password
          ) {
            return origGetRec.call(this, itemID, isPriority, password);
          }

          try {
            const attachment = await Zotero.Items.getAsync(itemID);
            if (!attachment || !attachment.isPDFAttachment()) {
              return origGetRec.call(this, itemID, isPriority, password);
            }
            const path = await attachment.getFilePathAsync();
            if (!path) {
              return origGetRec.call(this, itemID, isPriority, password);
            }

            const res = await self.native.extractRecognizerData(path, 5);
            if (res && res.ok && typeof res.json === "string") {
              const parsed = JSON.parse(res.json);
              if (parsed && Array.isArray(parsed.pages) && parsed.pages.length > 0) {
                self.stats.recognizerNativeCount++;
                self.stats.recognizerTotalMs += res.ms || 0;
                Zotero.debug(
                  `[ZotTurbo] Native recognizer extracted ${parsed.pages.length}/${parsed.totalPages} pages in ${(res.ms || 0).toFixed(1)} ms`
                );
                return parsed;
              }
            }
          } catch (err) {
            Zotero.debug("[ZotTurbo] Native recognizer fallback: " + (err?.message || String(err)));
          }

          self.stats.recognizerFallbackCount++;
          return origGetRec.call(this, itemID, isPriority, password);
        };
        this._wrappedGetRecognizerData = wrappedGetRec;
        Zotero.PDFWorker.getRecognizerData = wrappedGetRec;
      }

      // 3. Native hasAnnotations (< 0.5ms MuPDF scan vs reading entire PDF into PDF.js Worker)
      if (typeof Zotero.PDFWorker.hasAnnotations === "function") {
        const origHasAnnots = Zotero.PDFWorker.hasAnnotations;
        this._origHasAnnotations = origHasAnnots;
        const wrappedHasAnnots = async function zotTurboHasAnnotations(itemID, isPriority, password) {
          if (self._destroyed || !self.getPref("pdfFulltextEnabled", true) || password) {
            return origHasAnnots.call(this, itemID, isPriority, password);
          }
          try {
            const attachment = await Zotero.Items.getAsync(itemID);
            if (!attachment || !attachment.isPDFAttachment()) {
              return origHasAnnots.call(this, itemID, isPriority, password);
            }
            const path = await attachment.getFilePathAsync();
            if (!path) {
              return origHasAnnots.call(this, itemID, isPriority, password);
            }
            const res = await self.native.hasAnnotations(path);
            if (res && res.ok && typeof res.hasAnnotations === "boolean") {
              self.stats.hasAnnotsNativeCount++;
              return res.hasAnnotations;
            }
          } catch (err) {
            Zotero.debug("[ZotTurbo] Native hasAnnotations fallback: " + (err?.message || String(err)));
          }
          return origHasAnnots.call(this, itemID, isPriority, password);
        };
        this._wrappedHasAnnotations = wrappedHasAnnots;
        Zotero.PDFWorker.hasAnnotations = wrappedHasAnnots;
      }
    }

    _hookBatchIndexItems() {
      const ft = Zotero.Fulltext || Zotero.FullText;
      if (!ft || typeof ft.indexItems !== "function") return;
      const origIndexItems = ft.indexItems;
      this._origIndexItems = origIndexItems;
      const self = this;

      const wrappedIndexItems = async function zotTurboIndexItems(itemIDs, options = {}) {
        if (
          self._destroyed ||
          !self.getPref("pdfFulltextEnabled", true) ||
          !self.getPref("batchIndexParallelEnabled", true) ||
          !Array.isArray(itemIDs) ||
          itemIDs.length < 3
        ) {
          return origIndexItems.call(this, itemIDs, options);
        }

        const complete = typeof options === "boolean" ? options : !!options?.complete;
        const prefMaxPages = Zotero.Prefs?.get?.("fulltext.pdfMaxPages");
        if (prefMaxPages === 0) {
          return origIndexItems.call(this, itemIDs, options);
        }
        const maxPages = complete ? 0 : Number(prefMaxPages) || 0;
        const posById = new Map();
        for (let i = 0; i < itemIDs.length; i++) posById.set(itemIDs[i], i);
        const cursor = { posById, minIdx: -1 };
        const prevCursor = self._activeBatchCursor;
        self._activeBatchCursor = cursor;
        const batchKeys = [];
        let aborted = false;

        // Sliding-window background producer: keeps 3 PDFs extracting in parallel across native ChromeWorkers
        const producer = (async () => {
          try {
            const items = await Zotero.Items.getAsync(itemIDs);
            const CONCURRENCY = 3;
            const inFlight = new Set();

            for (let idx = 0; idx < items.length; idx++) {
              const item = items[idx];
              if (aborted || self._destroyed) break;
              if (idx <= cursor.minIdx) continue;
              if (!item || !item.isAttachment?.() || item.attachmentContentType !== "application/pdf") continue;
              if (typeof ft.getSyncedContentCacheFile === "function" && typeof IOUtils !== "undefined") {
                try {
                  const syncedPath = ft.getSyncedContentCacheFile(item)?.path;
                  if (syncedPath && (await IOUtils.exists(syncedPath))) continue;
                } catch {}
              }
              const p = await item.getFilePathAsync();
              if (!p || aborted || self._destroyed || idx <= cursor.minIdx) continue;

              // Backpressure: don't buffer more than 6 prefetched results in memory
              while (!aborted && !self._destroyed && self._batchPrefetch.size >= 6) {
                await new Promise((r) => setTimeout(r, 15));
              }
              if (aborted || self._destroyed || idx <= cursor.minIdx) continue;

              const task = self.native.extractFulltext(p, maxPages).catch(() => ({ ok: false }));
              self._batchPrefetch.set(item.id, { maxPages, seq: idx, promise: task });
              batchKeys.push(item.id);
              inFlight.add(task);
              task.finally(() => inFlight.delete(task));

              if (inFlight.size >= CONCURRENCY) {
                await Promise.race(inFlight);
              }
            }
          } catch {}
        })();

        try {
          return await origIndexItems.call(this, itemIDs, options);
        } finally {
          aborted = true;
          await producer.catch(() => {});
          for (const k of batchKeys) {
            self._batchPrefetch.delete(k);
          }
          if (self._activeBatchCursor === cursor) {
            self._activeBatchCursor = prevCursor;
          }
        }
      };
      this._wrappedIndexItems = wrappedIndexItems;
      ft.indexItems = wrappedIndexItems;
    }

    _hookReaders() {
      if (Zotero.Reader && typeof Zotero.Reader.open === "function") {
        const origReaderOpen = Zotero.Reader.open;
        this._origReaderOpen = origReaderOpen;
        const self = this;
        const wrappedReaderOpen = async function zotTurboWrappedReaderOpen(...args) {
          const reader = await origReaderOpen.apply(this, args);
          if (reader && !self._destroyed) {
            self._attachReader(reader);
          }
          return reader;
        };
        this._wrappedReaderOpen = wrappedReaderOpen;
        Zotero.Reader.open = wrappedReaderOpen;
      }

      this._notifierID = Zotero.Notifier.registerObserver(
        {
          notify: (event, type) => {
            if (this._destroyed) return;
            if (type === "tab" && event === "close") {
              this._pruneClosedViewers();
              return;
            }
            if (type === "tab" && (event === "add" || event === "select")) {
              this.scanAllReaders();
              setTimeout(() => !this._destroyed && this.scanAllReaders(), 250);
            }
          },
        },
        ["tab"],
        "zotero-turbo-pdf-text"
      );

      this.scanAllReaders();
    }

    scanAllReaders() {
      if (this._destroyed || !Zotero.Reader || !Array.isArray(Zotero.Reader._readers)) return;
      for (const reader of Zotero.Reader._readers) {
        this._attachReader(reader);
      }
    }

    async _resolveReaderPath(reader) {
      try {
        if (!reader?.itemID) return null;
        const item = await Zotero.Items.getAsync(reader.itemID);
        if (!item || !item.isPDFAttachment()) return null;
        return await item.getFilePathAsync();
      } catch {
        return null;
      }
    }

    _attachReader(reader) {
      if (this._destroyed || !reader || reader.type !== "pdf") return;
      const tryInject = async (attempt = 0) => {
        if (this._destroyed) return;
        try {
          const outerWin = reader._iframeWindow;
          const innerIframe = outerWin?.document?.querySelector?.("iframe");
          const viewerWin = innerIframe?.contentWindow;
          if (!viewerWin || viewerWin.closed) {
            if (attempt < 20) setTimeout(() => tryInject(attempt + 1), 150);
            return;
          }
          const rawWin = viewerWin.wrappedJSObject || viewerWin;
          if (this._patchedIframes.has(rawWin)) return;

          const path = await this._resolveReaderPath(reader);
          if (!path || viewerWin.closed || this._destroyed) return;

          this._patchedIframes.add(rawWin);
          const self = this;

          const bridgeObj = Cu.cloneInto(
            {
              isEnabled() {
                return !self._destroyed && !!self.getPref("readerTextLayerEnabled", true);
              },
              isCtrlFAccelEnabled() {
                return !self._destroyed && !!self.getPref("ctrlfAccelEnabled", true);
              },
              isOutlineEnabled() {
                return !self._destroyed && !!self.getPref("readerOutlineEnabled", true);
              },
              isPdfjsCleanupEnabled() {
                return !self._destroyed && !!self.getPref("pdfjsCleanupEnabled", true);
              },
              getProcessedDataDelayMs() {
                return Math.max(0, Math.min(10000, Number(self.getPref("processedDataDelayMs", 1500)) || 0));
              },
              getProcessedDataMaxPages() {
                const v = Number(self.getPref("processedDataMaxPages", 100));
                return Number.isFinite(v) ? v : 100;
              },
              requestPageData(pageIndex) {
                return new rawWin.Promise((resolve) => {
                  self.native
                    .extractPageData(path, pageIndex)
                    .then((res) => resolve(Cu.cloneInto(res || { ok: false }, rawWin)))
                    .catch(() => resolve(Cu.cloneInto({ ok: false }, rawWin)));
                });
              },
              requestOutline() {
                return new rawWin.Promise((resolve) => {
                  self.native
                    .extractOutline(path)
                    .then((res) => resolve(Cu.cloneInto(res || { ok: false }, rawWin)))
                    .catch(() => resolve(Cu.cloneInto({ ok: false }, rawWin)));
                });
              },
              reportHit(ms, charCount, isCtrlFSweep = false) {
                self.stats.readerPageHits++;
                self.stats.readerPageTotalMs += Number(ms) || 0;
                self.stats.readerCharsExtracted += Number(charCount) || 0;
                if (isCtrlFSweep) self.stats.ctrlfPages++;
              },
              reportFallback() {
                self.stats.readerPageFallbacks++;
              },
              reportOutlineHit(ms) {
                self.stats.outlineHits++;
                self.stats.outlineTotalMs += Number(ms) || 0;
              },
              reportOutlineFallback() {
                self.stats.outlineFallbacks++;
              },
              reportPdfjsCleanup() {
                self.stats.pdfjsCleanups++;
              },
            },
            rawWin,
            { cloneFunctions: true }
          );

          rawWin.__zotTurboTextBridge = bridgeObj;
          rawWin.eval(this._patchSource);

          const entry = { rawWin, path, viewerWin, onUnload: null };
          entry.onUnload = () => {
            this._viewerEntries.delete(entry);
            this.native.evictPath(path).catch(() => {});
          };
          viewerWin.addEventListener("unload", entry.onUnload, { once: true });
          this._viewerEntries.add(entry);
        } catch (err) {
          if (attempt < 15) {
            setTimeout(() => tryInject(attempt + 1), 200);
          } else {
            Zotero.debug("[ZotTurbo] Reader text patch attach skipped: " + (err?.message || String(err)));
          }
        }
      };
      tryInject(0);
    }

    cleanupAllPdfjsWorkers() {
      this._pruneClosedViewers();
      let count = 0;
      for (const entry of this._viewerEntries) {
        try {
          if (entry.rawWin && !Cu.isDeadWrapper(entry.rawWin) && typeof entry.rawWin.__zotTurboCleanupPdfjs === "function") {
            if (entry.rawWin.__zotTurboCleanupPdfjs()) count++;
          }
        } catch {}
      }
      return count;
    }

    _pruneClosedViewers() {
      for (const entry of [...this._viewerEntries]) {
        let dead = false;
        try {
          dead = !entry.viewerWin || entry.viewerWin.closed || Cu.isDeadWrapper(entry.rawWin);
        } catch {
          dead = true;
        }
        if (dead) {
          this._viewerEntries.delete(entry);
          this.native.evictPath(entry.path).catch(() => {});
        }
      }
    }

    getStats() {
      return {
        ...this.stats,
        avgFulltextMs:
          this.stats.fulltextNativeCount > 0 ? this.stats.fulltextTotalMs / this.stats.fulltextNativeCount : 0,
        avgRecognizerMs:
          this.stats.recognizerNativeCount > 0 ? this.stats.recognizerTotalMs / this.stats.recognizerNativeCount : 0,
        avgReaderPageMs:
          this.stats.readerPageHits > 0 ? this.stats.readerPageTotalMs / this.stats.readerPageHits : 0,
        avgOutlineMs:
          this.stats.outlineHits > 0 ? this.stats.outlineTotalMs / this.stats.outlineHits : 0,
      };
    }

    async benchmarkOrigGetFullText(itemID, maxPages) {
      if (!this._origGetFullText) {
        return Zotero.PDFWorker.getFullText(itemID, maxPages);
      }
      return this._origGetFullText.call(Zotero.PDFWorker, itemID, maxPages, true);
    }

    async benchmarkOrigGetRecognizerData(itemID) {
      if (!this._origGetRecognizerData) {
        return Zotero.PDFWorker.getRecognizerData(itemID, true);
      }
      return this._origGetRecognizerData.call(Zotero.PDFWorker, itemID, true);
    }

    shutdown() {
      this._destroyed = true;
      if (this._origGetFullText && Zotero.PDFWorker) {
        if (Zotero.PDFWorker.getFullText === this._wrappedGetFullText) {
          Zotero.PDFWorker.getFullText = this._origGetFullText;
        }
        this._origGetFullText = null;
        this._wrappedGetFullText = null;
      }
      if (this._origGetRecognizerData && Zotero.PDFWorker) {
        if (Zotero.PDFWorker.getRecognizerData === this._wrappedGetRecognizerData) {
          Zotero.PDFWorker.getRecognizerData = this._origGetRecognizerData;
        }
        this._origGetRecognizerData = null;
        this._wrappedGetRecognizerData = null;
      }
      if (this._origHasAnnotations && Zotero.PDFWorker) {
        if (Zotero.PDFWorker.hasAnnotations === this._wrappedHasAnnotations) {
          Zotero.PDFWorker.hasAnnotations = this._origHasAnnotations;
        }
        this._origHasAnnotations = null;
        this._wrappedHasAnnotations = null;
      }
      const ft = Zotero.Fulltext || Zotero.FullText;
      if (this._origIndexItems && ft) {
        if (ft.indexItems === this._wrappedIndexItems) {
          ft.indexItems = this._origIndexItems;
        }
        this._origIndexItems = null;
        this._wrappedIndexItems = null;
      }
      this._batchPrefetch.clear();
      this._activeBatchCursor = null;
      if (this._origReaderOpen && Zotero.Reader) {
        if (Zotero.Reader.open === this._wrappedReaderOpen) {
          Zotero.Reader.open = this._origReaderOpen;
        }
        this._origReaderOpen = null;
        this._wrappedReaderOpen = null;
      }
      if (this._notifierID) {
        try {
          Zotero.Notifier.unregisterObserver(this._notifierID);
        } catch {}
        this._notifierID = null;
      }
      for (const entry of [...this._viewerEntries]) {
        try {
          if (entry.viewerWin && !entry.viewerWin.closed && entry.onUnload) {
            entry.viewerWin.removeEventListener("unload", entry.onUnload);
          }
          if (entry.rawWin && !Cu.isDeadWrapper(entry.rawWin)) {
            if (typeof entry.rawWin.__zotTurboUnpatchText === "function") {
              entry.rawWin.__zotTurboUnpatchText();
            }
            delete entry.rawWin.__zotTurboTextBridge;
          }
        } catch {}
      }
      this._viewerEntries.clear();
    }
  }

  return { PDFTextAccelerator };
})();
