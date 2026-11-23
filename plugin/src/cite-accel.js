/* global Zotero, structuredClone */
"use strict";

var ZotTurboCiteAccel = (function () {
  const MAX_CSL_CACHE = 4096;
  const MAX_ABBREV_CACHE = 4096;

  function cloneCSL(obj) {
    if (typeof structuredClone === "function") {
      return structuredClone(obj);
    }
    return JSON.parse(JSON.stringify(obj));
  }

  class CiteAccelerator {
    constructor({ getPref }) {
      this.getPref = getPref;
      this._origRetrieveItem = null;
      this._origGetAbbreviation = null;
      this._origGetCiteProc = null;
      this._notifierID = null;
      this._cslCache = new Map(); // itemID -> { sig, csl }
      this._abbrevCache = new Map(); // key -> abbreviation string
      this._destroyed = false;

      this.stats = {
        cslCacheHits: 0,
        cslCacheMisses: 0,
        abbrevCacheHits: 0,
        abbrevCacheMisses: 0,
        citeprocRsFallbacks: 0,
      };
    }

    init() {
      this._hookRetrieveItem();
      this._hookAbbreviation();
      this._hookStyleCiteProc();
      // Only activate citeproc-rs on startup if user explicitly enabled it in Zotero Turbo
      if (this.getPref("citeUseCiteprocRs", false)) {
        this.applyCiteprocRsPref();
      }

      this._notifierID = Zotero.Notifier.registerObserver(
        {
          notify: (event, type, ids) => {
            if (this._destroyed || type !== "item") return;
            if (event === "modify" || event === "delete" || event === "trash" || event === "refresh") {
              for (const id of ids) {
                this._cslCache.delete(id);
              }
            }
          },
        },
        ["item"],
        "zotero-turbo-cite"
      );
    }

    _hookRetrieveItem() {
      if (!Zotero.Cite?.System?.prototype || typeof Zotero.Cite.System.prototype.retrieveItem !== "function") {
        return;
      }
      const origRetrieveItem = Zotero.Cite.System.prototype.retrieveItem;
      this._origRetrieveItem = origRetrieveItem;
      const self = this;

      const wrappedRetrieveItem = function zotTurboRetrieveItem(item) {
        if (self._destroyed || !self.getPref("citeCacheEnabled", true)) {
          return origRetrieveItem.call(this, item);
        }

        if (typeof item === "string" && item.includes("/")) {
          return origRetrieveItem.call(this, item);
        }

        let zoteroItem = null;
        if (item && typeof item === "object" && item instanceof Zotero.Item) {
          zoteroItem = item;
        } else {
          try {
            zoteroItem = Zotero.Items.get(item);
          } catch {}
        }

        if (!zoteroItem || !zoteroItem.id) {
          return origRetrieveItem.call(this, item);
        }

        const citePaperURL = Zotero.Prefs.get("export.citePaperJournalArticleURL") ? 1 : 0;
        const sig = `${zoteroItem.dateModified || ""}|${zoteroItem.version || 0}|${citePaperURL}`;
        const hit = self._cslCache.get(zoteroItem.id);
        if (hit && hit.sig === sig) {
          self._cslCache.delete(zoteroItem.id);
          self._cslCache.set(zoteroItem.id, hit);
          self.stats.cslCacheHits++;
          return cloneCSL(hit.csl);
        }

        self.stats.cslCacheMisses++;
        const cslItem = origRetrieveItem.call(this, zoteroItem);
        if (cslItem && typeof cslItem === "object") {
          if (self._cslCache.size >= MAX_CSL_CACHE) {
            const oldestKey = self._cslCache.keys().next().value;
            self._cslCache.delete(oldestKey);
          }
          self._cslCache.set(zoteroItem.id, { sig, csl: cloneCSL(cslItem) });
        }
        return cslItem;
      };
      this._wrappedRetrieveItem = wrappedRetrieveItem;
      Zotero.Cite.System.prototype.retrieveItem = wrappedRetrieveItem;
    }

    _hookAbbreviation() {
      if (!Zotero.Cite || typeof Zotero.Cite.getAbbreviation !== "function") return;
      const origGetAbbreviation = Zotero.Cite.getAbbreviation;
      this._origGetAbbreviation = origGetAbbreviation;
      const self = this;

      const wrappedGetAbbreviation = function zotTurboGetAbbreviation(listname, obj, jurisdiction, category, key) {
        if (self._destroyed || !self.getPref("citeCacheEnabled", true) || !key) {
          return origGetAbbreviation.call(this, listname, obj, jurisdiction, category, key);
        }
        const cacheKey = `${jurisdiction || "default"}|${category}|${key}`;
        if (self._abbrevCache.has(cacheKey)) {
          const abbr = self._abbrevCache.get(cacheKey);
          if (abbr !== null && obj) {
            if (!obj[jurisdiction]) {
              obj[jurisdiction] = new Zotero.CiteProc.CSL.AbbreviationSegments();
            }
            obj[jurisdiction][category][key] = abbr;
          }
          self.stats.abbrevCacheHits++;
          return;
        }

        self.stats.abbrevCacheMisses++;
        origGetAbbreviation.call(this, listname, obj, jurisdiction, category, key);
        const computed = obj?.[jurisdiction]?.[category]?.[key];
        if (self._abbrevCache.size >= MAX_ABBREV_CACHE) {
          const oldest = self._abbrevCache.keys().next().value;
          self._abbrevCache.delete(oldest);
        }
        self._abbrevCache.set(cacheKey, typeof computed === "string" ? computed : null);
      };
      this._wrappedGetAbbreviation = wrappedGetAbbreviation;
      Zotero.Cite.getAbbreviation = wrappedGetAbbreviation;
    }

    _hookStyleCiteProc() {
      if (!Zotero.Style?.prototype || typeof Zotero.Style.prototype.getCiteProc !== "function") return;
      const origGetCiteProc = Zotero.Style.prototype.getCiteProc;
      this._origGetCiteProc = origGetCiteProc;
      const self = this;

      const wrappedGetCiteProc = function zotTurboGetCiteProc(locale, format, options = {}) {
        if (self._destroyed) {
          return origGetCiteProc.call(this, locale, format, options);
        }
        try {
          return origGetCiteProc.call(this, locale, format, options);
        } catch (err) {
          if (Zotero.Prefs.get("cite.useCiteprocRs")) {
            self.stats.citeprocRsFallbacks++;
            Zotero.debug("[ZotTurbo] citeproc-rs failed on style, falling back to citeproc-js: " + (err?.message || err));
            Zotero.Prefs.set("cite.useCiteprocRs", false);
            try {
              return origGetCiteProc.call(this, locale, format, options);
            } finally {
              if (self.getPref("citeUseCiteprocRs", false)) {
                Zotero.Prefs.set("cite.useCiteprocRs", true);
              }
            }
          }
          throw err;
        }
      };
      this._wrappedGetCiteProc = wrappedGetCiteProc;
      Zotero.Style.prototype.getCiteProc = wrappedGetCiteProc;
    }

    async applyCiteprocRsPref() {
      if (!Zotero.CiteprocRs || typeof Zotero.CiteprocRs.init !== "function") return false;
      const wantRs = !!this.getPref("citeUseCiteprocRs", false);
      try {
        if (wantRs) {
          await Zotero.CiteprocRs.init();
          Zotero.Prefs.set("cite.useCiteprocRs", true);
        } else if (Zotero.Prefs.get("cite.useCiteprocRs")) {
          // Only turn off if user explicitly toggled off in Zotero Turbo
          Zotero.Prefs.set("cite.useCiteprocRs", false);
        }
        return wantRs;
      } catch (err) {
        Zotero.debug("[ZotTurbo] Failed to toggle citeproc-rs: " + (err?.message || err));
        Zotero.Prefs.set("cite.useCiteprocRs", false);
        return false;
      }
    }

    benchmarkOrigRetrieveItem(sys, item) {
      if (!this._origRetrieveItem) return sys.retrieveItem(item);
      return this._origRetrieveItem.call(sys, item);
    }

    clearCache() {
      this._cslCache.clear();
      this._abbrevCache.clear();
    }

    getStats() {
      const totalCsl = this.stats.cslCacheHits + this.stats.cslCacheMisses;
      return {
        ...this.stats,
        cslCacheSize: this._cslCache.size,
        cslHitRate: totalCsl > 0 ? (this.stats.cslCacheHits / totalCsl) * 100 : 0,
        abbrevCacheSize: this._abbrevCache.size,
        citeprocRsSupported: !!(Zotero.CiteprocRs && typeof Zotero.CiteprocRs.init === "function"),
        citeprocRsActive: !!Zotero.Prefs.get("cite.useCiteprocRs"),
      };
    }

    shutdown() {
      this._destroyed = true;
      if (this._origRetrieveItem && Zotero.Cite?.System?.prototype) {
        if (Zotero.Cite.System.prototype.retrieveItem === this._wrappedRetrieveItem) {
          Zotero.Cite.System.prototype.retrieveItem = this._origRetrieveItem;
        }
        this._origRetrieveItem = null;
        this._wrappedRetrieveItem = null;
      }
      if (this._origGetAbbreviation && Zotero.Cite) {
        if (Zotero.Cite.getAbbreviation === this._wrappedGetAbbreviation) {
          Zotero.Cite.getAbbreviation = this._origGetAbbreviation;
        }
        this._origGetAbbreviation = null;
        this._wrappedGetAbbreviation = null;
      }
      if (this._origGetCiteProc && Zotero.Style?.prototype) {
        if (Zotero.Style.prototype.getCiteProc === this._wrappedGetCiteProc) {
          Zotero.Style.prototype.getCiteProc = this._origGetCiteProc;
        }
        this._origGetCiteProc = null;
        this._wrappedGetCiteProc = null;
      }
      if (this._notifierID) {
        try {
          Zotero.Notifier.unregisterObserver(this._notifierID);
        } catch {}
        this._notifierID = null;
      }
      this._cslCache.clear();
      this._abbrevCache.clear();
    }
  }

  return { CiteAccelerator };
})();
