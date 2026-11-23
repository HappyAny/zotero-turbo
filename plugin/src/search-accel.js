/* global Zotero, OS */
"use strict";

var ZotTurboSearchAccel = (function () {
  const MAX_CACHE_ENTRIES = 64;
  const CACHE_TTL_MS = 30 * 1000;

  class SearchAccelerator {
    constructor({ nativeClient, getPref }) {
      this.native = nativeClient;
      this.getPref = getPref;
      this._origFindTextInItems = null;
      this._origSearch = null;
      this._notifierID = null;
      this._searchCache = new Map(); // key -> { ids, ts }
      this._destroyed = false;

      this.stats = {
        nativeScans: 0,
        nativeFilesScanned: 0,
        nativeScanTotalMs: 0,
        nativeFallbacks: 0,
        searchCacheHits: 0,
        searchCacheMisses: 0,
      };
    }

    init() {
      this._hookFulltextScan();
      this._hookSearchCache();

      this._notifierID = Zotero.Notifier.registerObserver(
        {
          notify: () => {
            if (!this._destroyed && this._searchCache.size > 0) {
              this._searchCache.clear();
            }
          },
        },
        ["item", "collection", "collection-item", "item-tag", "tag", "trash", "search"],
        "zotero-turbo-search"
      );
    }

    _hookFulltextScan() {
      const ft = Zotero.FullText || Zotero.Fulltext;
      if (!ft || typeof ft.findTextInItems !== "function") return;
      const origFindTextInItems = ft.findTextInItems;
      this._origFindTextInItems = origFindTextInItems;
      const self = this;

      const wrappedFindText = async function zotTurboFindTextInItems(items, searchText, mode) {
        if (
          self._destroyed ||
          !self.getPref("searchNativeScanEnabled", true) ||
          !searchText ||
          !items ||
          (mode && (mode.includes("regexp") || mode.includes("Binary")))
        ) {
          return origFindTextInItems.call(this, items, searchText, mode);
        }

        try {
          const itemObjs = await Zotero.Items.getAsync(items);
          if (!Array.isArray(itemObjs) || itemObjs.length === 0) return [];

          const maxLength = Zotero.Prefs.get("fulltext.textMaxLength") || 500000;
          const nativeCandidates = []; // { itemID, path }
          const fallbackItems = [];

          for (let i = 0; i < itemObjs.length; i++) {
            const item = itemObjs[i];
            if (!item || !item.isAttachment()) continue;
            const mime = item.attachmentContentType;
            if (typeof this.isCachedMIMEType === "function" && this.isCachedMIMEType(mime)) {
              const cacheFile = this.getItemCacheFile(item);
              if (cacheFile && cacheFile.path) {
                nativeCandidates.push({ itemID: item.id, path: cacheFile.path });
              }
            } else if (Zotero.MIME?.isTextType?.(mime)) {
              fallbackItems.push(item);
            }
          }

          const found = [];

          if (nativeCandidates.length > 0) {
            const caseSensitive = mode === "phraseCaseSensitive";
            const res = await self.native.scanFiles(
              nativeCandidates.map((c) => c.path),
              String(searchText),
              {
                caseSensitive,
                normalizeWhitespace: true,
                maxBytes: Math.max(65536, Math.min(8 * 1024 * 1024, maxLength * 2)),
              }
            );

            if (res && res.ok && typeof res.indicesJson === "string") {
              const matchedIndices = JSON.parse(res.indicesJson);
              for (let i = 0; i < matchedIndices.length; i++) {
                const idx = matchedIndices[i];
                if (idx >= 0 && idx < nativeCandidates.length) {
                  found.push({ id: nativeCandidates[idx].itemID });
                }
              }
              self.stats.nativeScans++;
              self.stats.nativeFilesScanned += res.scanned || nativeCandidates.length;
              self.stats.nativeScanTotalMs += res.ms || 0;
            } else {
              self.stats.nativeFallbacks++;
              const fb = await origFindTextInItems.call(
                this,
                nativeCandidates.map((c) => c.itemID),
                searchText,
                mode
              );
              found.push(...fb);
            }
          }

          if (fallbackItems.length > 0) {
            const fbText = await origFindTextInItems.call(this, fallbackItems, searchText, mode);
            found.push(...fbText);
          }

          return found;
        } catch (err) {
          Zotero.debug("[ZotTurbo] Native scan fallback: " + (err?.message || String(err)));
          self.stats.nativeFallbacks++;
          return origFindTextInItems.call(this, items, searchText, mode);
        }
      };
      this._wrappedFindTextInItems = wrappedFindText;
      ft.findTextInItems = wrappedFindText;
    }

    _buildSearchCacheKey(searchObj) {
      try {
        if (!searchObj || searchObj._scope) return null; // skip scoped/nested sub-searches
        const conds = searchObj._conditions;
        if (!conds || typeof conds !== "object") return null;
        const keys = Object.keys(conds).sort((a, b) => Number(a) - Number(b));
        if (keys.length === 0) return null;
        const norm = [];
        for (const k of keys) {
          const c = conds[k];
          if (!c) continue;
          if (c.condition === "savedSearch" || c.condition === "dateAdded" || c.condition === "dateModified") {
            return null;
          }
          norm.push([c.condition, c.operator, c.value, c.mode || "", c.required ? 1 : 0]);
        }
        const recCol = Zotero.Prefs?.get?.("recursiveCollections") ? 1 : 0;
        return JSON.stringify([
          searchObj.libraryID,
          searchObj._scopeIncludeChildren ? 1 : 0,
          recCol,
          searchObj._name || "",
          norm,
        ]);
      } catch {
        return null;
      }
    }

    _hookSearchCache() {
      if (!Zotero.Search || !Zotero.Search.prototype || typeof Zotero.Search.prototype.search !== "function") return;
      const origSearch = Zotero.Search.prototype.search;
      this._origSearch = origSearch;
      const self = this;

      const wrappedSearch = async function zotTurboSearch(asTempTable) {
        if (self._destroyed || asTempTable || !self.getPref("searchCacheEnabled", true)) {
          return origSearch.call(this, asTempTable);
        }

        const key = self._buildSearchCacheKey(this);
        if (!key) {
          return origSearch.call(this, asTempTable);
        }

        const now = Date.now();
        const cached = self._searchCache.get(key);
        if (cached && now - cached.ts <= CACHE_TTL_MS) {
          self._searchCache.delete(key);
          self._searchCache.set(key, cached);
          self.stats.searchCacheHits++;
          return cached.ids.slice();
        }

        self.stats.searchCacheMisses++;
        const ids = await origSearch.call(this, asTempTable);
        if (Array.isArray(ids) && !self._destroyed) {
          if (self._searchCache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = self._searchCache.keys().next().value;
            self._searchCache.delete(oldestKey);
          }
          self._searchCache.set(key, { ids: ids.slice(), ts: Date.now() });
        }
        return ids;
      };
      this._wrappedSearch = wrappedSearch;
      Zotero.Search.prototype.search = wrappedSearch;
    }

    async benchmarkOrigFindTextInItems(items, searchText, mode) {
      const ft = Zotero.FullText || Zotero.Fulltext;
      if (!this._origFindTextInItems) {
        return ft.findTextInItems(items, searchText, mode);
      }
      return this._origFindTextInItems.call(ft, items, searchText, mode);
    }

    clearCache() {
      this._searchCache.clear();
    }

    getStats() {
      const totalQ = this.stats.searchCacheHits + this.stats.searchCacheMisses;
      return {
        ...this.stats,
        avgNativeScanMs:
          this.stats.nativeScans > 0 ? this.stats.nativeScanTotalMs / this.stats.nativeScans : 0,
        cacheSize: this._searchCache.size,
        cacheHitRate: totalQ > 0 ? (this.stats.searchCacheHits / totalQ) * 100 : 0,
      };
    }

    shutdown() {
      this._destroyed = true;
      const ft = Zotero.FullText || Zotero.Fulltext;
      if (this._origFindTextInItems && ft) {
        if (ft.findTextInItems === this._wrappedFindTextInItems) {
          ft.findTextInItems = this._origFindTextInItems;
        }
        this._origFindTextInItems = null;
        this._wrappedFindTextInItems = null;
      }
      if (this._origSearch && Zotero.Search?.prototype) {
        if (Zotero.Search.prototype.search === this._wrappedSearch) {
          Zotero.Search.prototype.search = this._origSearch;
        }
        this._origSearch = null;
        this._wrappedSearch = null;
      }
      if (this._notifierID) {
        try {
          Zotero.Notifier.unregisterObserver(this._notifierID);
        } catch {}
        this._notifierID = null;
      }
      this._searchCache.clear();
    }
  }

  return { SearchAccelerator };
})();
