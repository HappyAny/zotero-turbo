/* global Zotero, Services, Components, ChromeUtils */
"use strict";

var ZotTurboTabHibernator = (function () {
  const { setTimeout, clearTimeout, setInterval, clearInterval } = ChromeUtils.importESModule(
    "resource://gre/modules/Timer.sys.mjs"
  );

  const STYLE_ID = "zot-turbo-tab-hibernate-style";

  class TabHibernator {
    constructor({ getPref, nativeClient, renderEngine = null, onBackgroundSlim = null }) {
      this.getPref = getPref;
      this.native = nativeClient;
      this.renderEngine = renderEngine;
      this.onBackgroundSlim = onBackgroundSlim;
      this._winStates = new Map(); // win -> { origUnloadUnusedTabs, cleanups: [] }
      this._sweepTimer = null;
      this._memObserver = null;
      this._notifierID = null;
      this._lastMemTrimAt = 0;
      this._inactiveSince = 0;
      this._slimmedCurrentIdle = false;
      this._destroyed = false;

      this.stats = {
        totalHibernated: 0,
        lastHibernateCount: 0,
        memoryPressureHibernations: 0,
        autoSlimCount: 0,
        lastSweepAt: 0,
      };
    }

    init() {
      for (const win of Zotero.getMainWindows()) {
        this.attachWindow(win);
      }

      // Sweep every 60s to enforce idleMinutes threshold & gentle background auto-slim
      this._sweepTimer = setInterval(() => {
        if (this._destroyed) return;
        if (this.getPref("tabHibernateEnabled", true)) {
          this.sweepAllWindows({ reason: "idle-timer" });
        }
        this._checkBackgroundAutoSlim();
      }, 60 * 1000);

      // Listen to Gecko memory-pressure signals to immediately hibernate background tabs
      this._memObserver = {
        observe: (_subj, topic) => {
          if (this._destroyed || topic !== "memory-pressure") return;
          if (!this.getPref("tabHibernateEnabled", true)) return;
          const count = this.hibernateAllBackground({ includeNotes: false, reason: "memory-pressure" });
          if (count > 0) {
            this.stats.memoryPressureHibernations += count;
          }
        },
      };
      try {
        Services.obs.addObserver(this._memObserver, "memory-pressure");
      } catch {}

      // Refresh visual unloaded indicators when tabs change
      this._notifierID = Zotero.Notifier.registerObserver(
        {
          notify: (_event, type) => {
            if (this._destroyed || type !== "tab") return;
            setTimeout(() => {
              if (!this._destroyed) this.refreshAllTabIndicators();
            }, 80);
          },
        },
        ["tab"],
        "zotero-turbo-tabs"
      );
    }

    attachWindow(win) {
      if (this._destroyed || !win || win.closed || this._winStates.has(win)) return;
      const zTabs = win.Zotero_Tabs;
      if (!zTabs || typeof zTabs.unload !== "function") return;

      const state = {
        origUnloadUnusedTabs: zTabs.unloadUnusedTabs,
        cleanups: [],
      };
      this._winStates.set(win, state);

      // Inject subtle visual indicator style for hibernated tabs
      const doc = win.document;
      if (doc && !doc.getElementById(STYLE_ID)) {
        const styleEl = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
        styleEl.id = STYLE_ID;
        styleEl.textContent = `
          #tab-bar-container .tab.zot-turbo-hibernated {
            opacity: 0.62 !important;
            font-style: italic;
          }
          #tab-bar-container .tab.zot-turbo-hibernated .tab-name::before {
            content: "💤 ";
            font-style: normal;
            font-size: 0.85em;
          }
        `;
        (doc.head || doc.documentElement).appendChild(styleEl);
        state.cleanups.push(() => {
          try {
            styleEl.remove();
          } catch {}
        });
      }

      // Override Zotero_Tabs.unloadUnusedTabs with configurable maxLoadedTabs & idleMinutes
      const self = this;
      const origUnload = state.origUnloadUnusedTabs;
      const wrappedUnload = function zotTurboUnloadUnusedTabs() {
        if (self._destroyed || !self.getPref("tabHibernateEnabled", true)) {
          return origUnload.call(this);
        }
        return self._enforceWindowPolicy(win, { reason: "tab-switch" });
      };
      state.wrappedUnloadUnusedTabs = wrappedUnload;
      zTabs.unloadUnusedTabs = wrappedUnload;

      // Hook tab-bar right-click menu via passive contextmenu + popupshowing on popupset
      let lastCtxTabID = null;
      let lastCtxAt = 0;

      const tabBar = doc?.getElementById("tab-bar-container");
      const popupset = doc?.querySelector("popupset");

      if (tabBar && popupset) {
        const onCtxMenu = (ev) => {
          const tabEl = ev.target?.closest?.(".tab[data-id]");
          if (tabEl) {
            lastCtxTabID = tabEl.getAttribute("data-id");
            lastCtxAt = Date.now();
          } else {
            lastCtxTabID = null;
          }
        };
        const onPopupShowing = (ev) => {
          const popup = ev.target;
          if (!popup || popup.tagName !== "menupopup" || popup.id) return;
          if (!lastCtxTabID || Date.now() - lastCtxAt > 800) return;
          if (popup.querySelector(".zot-turbo-tab-menu")) return;

          const targetId = lastCtxTabID;
          lastCtxTabID = null;

          const tabs = zTabs._tabs || [];
          const targetTab = tabs.find((t) => t.id === targetId);
          const canUnloadThis = targetTab && zTabs.canUnload(targetId);
          const otherLoaded = tabs.filter(
            (t) =>
              t.id !== targetId &&
              t.id !== zTabs.selectedID &&
              (t.type === "reader" || (self.getPref("tabHibernateNotes", false) && t.type === "note")) &&
              zTabs.canUnload(t.id)
          );

          if (!canUnloadThis && otherLoaded.length === 0) return;

          const sep = doc.createXULElement("menuseparator");
          sep.className = "zot-turbo-tab-menu";
          popup.appendChild(sep);

          if (canUnloadThis) {
            const miOne = doc.createXULElement("menuitem");
            miOne.className = "zot-turbo-tab-menu";
            miOne.setAttribute("label", "休眠此标签页 (释放内存)");
            miOne.addEventListener("command", () => {
              self.hibernateTab(win, targetId);
            });
            popup.appendChild(miOne);
          }

          if (otherLoaded.length > 0) {
            const miOthers = doc.createXULElement("menuitem");
            miOthers.className = "zot-turbo-tab-menu";
            miOthers.setAttribute("label", `休眠其他标签页 (${otherLoaded.length} 个)`);
            miOthers.addEventListener("command", () => {
              self.hibernateOtherTabs(win, targetId);
            });
            popup.appendChild(miOthers);
          }
        };

        tabBar.addEventListener("contextmenu", onCtxMenu, true);
        popupset.addEventListener("popupshowing", onPopupShowing, false);
        state.cleanups.push(() => {
          try {
            tabBar.removeEventListener("contextmenu", onCtxMenu, true);
            popupset.removeEventListener("popupshowing", onPopupShowing, false);
          } catch {}
        });
      }

      const onActivate = () => {
        this._inactiveSince = 0;
        this._slimmedCurrentIdle = false;
      };
      const onDeactivateOrSize = () => {
        this._updateAppInactiveState();
      };
      win.addEventListener("activate", onActivate);
      win.addEventListener("deactivate", onDeactivateOrSize);
      win.addEventListener("sizemodechange", onDeactivateOrSize);
      state.cleanups.push(() => {
        try {
          win.removeEventListener("activate", onActivate);
          win.removeEventListener("deactivate", onDeactivateOrSize);
          win.removeEventListener("sizemodechange", onDeactivateOrSize);
        } catch {}
      });

      const onUnloadWin = () => this.detachWindow(win);
      win.addEventListener("unload", onUnloadWin, { once: true });
      state.cleanups.push(() => {
        try {
          win.removeEventListener("unload", onUnloadWin);
        } catch {}
      });

      this._refreshWindowIndicators(win);
    }

    _isAppInactiveOrMinimized() {
      try {
        const wins = Zotero.getMainWindows() || [];
        const allMinimized =
          wins.length > 0 &&
          wins.every((w) => w && !w.closed && typeof w.STATE_MINIMIZED === "number" && w.windowState === w.STATE_MINIMIZED);
        if (allMinimized) return true;
        // If Services.focus.activeWindow is null, no Zotero window (including dialogs/Preferences) has OS focus
        if (typeof Services !== "undefined" && Services.focus && "activeWindow" in Services.focus) {
          return Services.focus.activeWindow === null;
        }
      } catch {}
      return false;
    }

    _updateAppInactiveState(nowMs = Date.now()) {
      if (this._isAppInactiveOrMinimized()) {
        if (this._inactiveSince === 0) {
          this._inactiveSince = nowMs;
        }
      } else {
        this._inactiveSince = 0;
        this._slimmedCurrentIdle = false;
      }
    }

    _checkBackgroundAutoSlim(nowMs = Date.now()) {
      if (this._destroyed || typeof this.onBackgroundSlim !== "function") return false;
      if (!this.getPref("autoBackgroundSlimEnabled", true)) return false;

      this._updateAppInactiveState(nowMs);
      if (this._slimmedCurrentIdle || this._inactiveSince === 0) return false;

      const minMinutes = Math.max(1, Math.min(240, Number(this.getPref("autoBackgroundSlimMin", 10)) || 10));
      if (nowMs - this._inactiveSince < minMinutes * 60 * 1000) return false;

      this._slimmedCurrentIdle = true;
      this.stats.autoSlimCount++;
      Zotero.debug(`[ZotTurbo] Background/minimized auto-slim triggered after ${minMinutes}m idle`);
      Promise.resolve(this.onBackgroundSlim()).catch(() => {});
      return true;
    }

    detachWindow(win) {
      const state = this._winStates.get(win);
      if (!state) return;
      this._winStates.delete(win);
      try {
        if (
          win &&
          !win.closed &&
          win.Zotero_Tabs &&
          state.origUnloadUnusedTabs &&
          win.Zotero_Tabs.unloadUnusedTabs === state.wrappedUnloadUnusedTabs
        ) {
          win.Zotero_Tabs.unloadUnusedTabs = state.origUnloadUnusedTabs;
        }
      } catch {}
      for (const fn of state.cleanups) {
        try {
          fn();
        } catch {}
      }
      try {
        const nodes = win?.document?.querySelectorAll?.("#tab-bar-container .tab.zot-turbo-hibernated");
        if (nodes) {
          for (const n of nodes) n.classList.remove("zot-turbo-hibernated");
        }
      } catch {}
    }

    _triggerMemoryReclaim() {
      const now = Date.now();
      if (now - this._lastMemTrimAt < 5000) return;
      this._lastMemTrimAt = now;

      // Trim our unified native engine (render + text) and coordinate with any standalone MuPDF plugin
      try {
        this.renderEngine?.trimMemory?.(true);
      } catch {}
      try {
        this.native?.trim?.(true)?.catch?.(() => {});
      } catch {}
      try {
        Zotero.ZotMuPDF?.engineClient?.trimMemory?.(true);
      } catch {}
      try {
        const mgr = Components.classes["@mozilla.org/memory-reporter-manager;1"].getService(
          Components.interfaces.nsIMemoryReporterManager
        );
        if (mgr && typeof mgr.minimizeMemoryUsage === "function") {
          setTimeout(() => {
            try {
              mgr.minimizeMemoryUsage(() => {});
            } catch {}
          }, 300);
        }
      } catch {}
    }

    _evictTabPath(tab) {
      const itemID = tab?.data?.itemID;
      if (!itemID) return;
      Promise.resolve()
        .then(async () => {
          const item = await Zotero.Items.getAsync(itemID);
          if (!item || !item.isPDFAttachment?.()) return;
          const p = await item.getFilePathAsync();
          if (!p) return;
          try {
            this.renderEngine?.evictPath?.(p);
          } catch {}
          try {
            this.native?.evictPath?.(p)?.catch?.(() => {});
          } catch {}
        })
        .catch(() => {});
    }

    hibernateTab(win, tabID) {
      const zTabs = win?.Zotero_Tabs;
      if (!zTabs || !zTabs.canUnload(tabID)) return false;
      try {
        const tab = (zTabs._tabs || []).find((t) => t.id === tabID);
        zTabs.unload(tabID);
        if (tab) this._evictTabPath(tab);
        this.stats.totalHibernated++;
        this.stats.lastHibernateCount = 1;
        this._refreshWindowIndicators(win);
        this._triggerMemoryReclaim();
        return true;
      } catch (err) {
        Zotero.debug("[ZotTurbo] hibernateTab error: " + (err?.message || String(err)));
        return false;
      }
    }

    hibernateOtherTabs(win, keepTabID) {
      const zTabs = win?.Zotero_Tabs;
      if (!zTabs) return 0;
      const includeNotes = !!this.getPref("tabHibernateNotes", false);
      const targets = (zTabs._tabs || []).filter(
        (t) =>
          t.id !== keepTabID &&
          t.id !== zTabs.selectedID &&
          (t.type === "reader" || (includeNotes && t.type === "note")) &&
          zTabs.canUnload(t.id)
      );
      let count = 0;
      for (const tab of targets) {
        try {
          zTabs.unload(tab.id);
          this._evictTabPath(tab);
          count++;
        } catch {}
      }
      if (count > 0) {
        this.stats.totalHibernated += count;
        this.stats.lastHibernateCount = count;
        this._refreshWindowIndicators(win);
        this._triggerMemoryReclaim();
      }
      return count;
    }

    hibernateAllBackground({ includeNotes = false } = {}) {
      let total = 0;
      for (const win of Zotero.getMainWindows()) {
        const zTabs = win?.Zotero_Tabs;
        if (!zTabs) continue;
        const targets = (zTabs._tabs || []).filter(
          (t) =>
            t.id !== zTabs.selectedID &&
            (t.type === "reader" || (includeNotes && t.type === "note")) &&
            zTabs.canUnload(t.id)
        );
        for (const tab of targets) {
          try {
            zTabs.unload(tab.id);
            this._evictTabPath(tab);
            total++;
          } catch {}
        }
        this._refreshWindowIndicators(win);
      }
      if (total > 0) {
        this.stats.totalHibernated += total;
        this.stats.lastHibernateCount = total;
        this._triggerMemoryReclaim();
      }
      return total;
    }

    _enforceWindowPolicy(win, { reason = "policy" } = {}) {
      const zTabs = win?.Zotero_Tabs;
      if (!zTabs || !Array.isArray(zTabs._tabs)) return 0;

      const maxLoaded = Math.max(1, Math.min(20, Number(this.getPref("tabHibernateMaxLoaded", 2)) || 2));
      const idleMin = Math.max(1, Math.min(1440, Number(this.getPref("tabHibernateIdleMin", 10)) || 10));
      const idleSec = idleMin * 60;
      const includeNotes = !!this.getPref("tabHibernateNotes", false);
      const nowSec = Zotero.Date.getUnixTimestamp();

      let count = 0;

      // 1. Unload tabs that exceeded idleMinutes
      for (const tab of [...zTabs._tabs]) {
        const eligibleType = tab.type === "reader" || (includeNotes && tab.type === "note");
        if (!eligibleType || !zTabs.canUnload(tab.id)) continue;
        const unselectedAt = Number(tab.timeUnselected) || 0;
        if (unselectedAt > 0 && nowSec - unselectedAt > idleSec) {
          try {
            zTabs.unload(tab.id);
            this._evictTabPath(tab);
            count++;
          } catch {}
        }
      }

      // 2. Enforce maxLoadedTabs across active reader tabs (keeping selected + most recently used)
      const loadedReaders = zTabs._tabs
        .filter((x) => x.type === "reader")
        .sort((a, b) => {
          if (a.id === zTabs.selectedID) return -1;
          if (b.id === zTabs.selectedID) return 1;
          return (Number(b.timeUnselected) || 0) - (Number(a.timeUnselected) || 0);
        });

      const overflow = loadedReaders.slice(maxLoaded);
      for (const tab of overflow) {
        if (!zTabs.canUnload(tab.id)) continue;
        try {
          zTabs.unload(tab.id);
          this._evictTabPath(tab);
          count++;
        } catch {}
      }

      if (count > 0) {
        this.stats.totalHibernated += count;
        this.stats.lastHibernateCount = count;
        this.stats.lastSweepAt = Date.now();
        Zotero.debug(`[ZotTurbo] Hibernated ${count} tab(s) (reason=${reason}, max=${maxLoaded}, idle=${idleMin}m)`);
        this._triggerMemoryReclaim();
      }
      this._refreshWindowIndicators(win);
      return count;
    }

    sweepAllWindows({ reason = "manual" } = {}) {
      let total = 0;
      for (const win of Zotero.getMainWindows()) {
        if (!this._winStates.has(win)) this.attachWindow(win);
        total += this._enforceWindowPolicy(win, { reason });
      }
      return total;
    }

    _refreshWindowIndicators(win) {
      try {
        const doc = win?.document;
        const zTabs = win?.Zotero_Tabs;
        if (!doc || !zTabs || !Array.isArray(zTabs._tabs)) return;
        const unloadedIDs = new Set(
          zTabs._tabs.filter((t) => typeof t.type === "string" && t.type.endsWith("-unloaded")).map((t) => t.id)
        );
        const tabNodes = doc.querySelectorAll("#tab-bar-container .tab[data-id]");
        for (const node of tabNodes) {
          const id = node.getAttribute("data-id");
          if (unloadedIDs.has(id)) {
            node.classList.add("zot-turbo-hibernated");
          } else {
            node.classList.remove("zot-turbo-hibernated");
          }
        }
      } catch {}
    }

    refreshAllTabIndicators() {
      for (const win of Zotero.getMainWindows()) {
        this._refreshWindowIndicators(win);
      }
    }

    getStats() {
      let activeReaders = 0;
      let hibernatedTabs = 0;
      let totalTabs = 0;
      for (const win of Zotero.getMainWindows()) {
        const tabs = win?.Zotero_Tabs?._tabs;
        if (!Array.isArray(tabs)) continue;
        totalTabs += tabs.length;
        for (const t of tabs) {
          if (t.type === "reader") activeReaders++;
          else if (typeof t.type === "string" && t.type.endsWith("-unloaded")) hibernatedTabs++;
        }
      }
      return {
        ...this.stats,
        activeReaders,
        hibernatedTabs,
        totalTabs,
      };
    }

    shutdown() {
      this._destroyed = true;
      if (this._sweepTimer) {
        clearInterval(this._sweepTimer);
        this._sweepTimer = null;
      }
      if (this._memObserver) {
        try {
          Services.obs.removeObserver(this._memObserver, "memory-pressure");
        } catch {}
        this._memObserver = null;
      }
      if (this._notifierID) {
        try {
          Zotero.Notifier.unregisterObserver(this._notifierID);
        } catch {}
        this._notifierID = null;
      }
      for (const win of [...this._winStates.keys()]) {
        this.detachWindow(win);
      }
      this._winStates.clear();
    }
  }

  return { TabHibernator };
})();
