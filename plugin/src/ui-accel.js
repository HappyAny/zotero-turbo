/* global Zotero, ChromeUtils */
"use strict";

var ZotTurboUIAccel = (function () {
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  class UIAccelerator {
    constructor({ getPref }) {
      this.getPref = getPref;
      this._winStates = new Map(); // win -> state
      this._notifierID = null;
      this._destroyed = false;

      this.stats = {
        immediateSelections: 0,
        coalescedSelections: 0,
        activeOverscan: 2,
        attachedWindows: 0,
      };
    }

    init() {
      for (const win of Zotero.getMainWindows?.() || []) {
        this.attachWindow(win);
      }

      if (Zotero.Notifier && typeof Zotero.Notifier.registerObserver === "function") {
        this._notifierID = Zotero.Notifier.registerObserver(
          {
            notify: (event, type) => {
              if (this._destroyed || type !== "tab") return;
              if (event === "select" || event === "add") {
                setTimeout(() => {
                  if (!this._destroyed) this.applySettings();
                }, 120);
              }
            },
          },
          ["tab"],
          "zotero-turbo-ui"
        );
      }
    }

    attachWindow(win) {
      if (this._destroyed || !win || win.closed || this._winStates.has(win)) return;
      const pane = win.ZoteroPane;
      if (!pane) return;

      const state = {
        pane,
        origItemSelected: null,
        wrappedItemSelected: null,
        pendingTimer: null,
        pendingResolvers: [],
        pendingArgs: null,
        pendingThis: null,
        lastInvokeAt: 0,
        origOverscan: null,
        patchedJsWin: null,
        overscanRetryTimer: null,
        overscanTries: 0,
        onUnload: null,
      };
      this._winStates.set(win, state);
      this.stats.attachedWindows = this._winStates.size;

      // 1. Leading-edge + trailing-edge burst coalescing for ZoteroPane.itemSelected()
      if (typeof pane.itemSelected === "function") {
        const origItemSelected = pane.itemSelected;
        state.origItemSelected = origItemSelected;
        const self = this;

        const wrappedItemSelected = function zotTurboItemSelected(...args) {
          if (
            self._destroyed ||
            !self.getPref("itemSelectCoalesceEnabled", true) ||
            (win.Zotero_Tabs && win.Zotero_Tabs.selectedType && win.Zotero_Tabs.selectedType !== "library")
          ) {
            return origItemSelected.apply(this, args);
          }

          const debounceMs = Math.max(0, Math.min(300, Number(self.getPref("itemSelectDebounceMs", 75)) || 0));
          if (debounceMs <= 0) {
            return origItemSelected.apply(this, args);
          }

          const now = Date.now();
          // Single click / first keypress runs immediately (0ms added latency!)
          if (!state.pendingTimer && now - state.lastInvokeAt > debounceMs * 2) {
            state.lastInvokeAt = now;
            self.stats.immediateSelections++;
            return origItemSelected.apply(this, args);
          }

          // Rapid consecutive navigation (holding Up/Down arrows): coalesce intermediate ItemPane rebuilds
          if (state.pendingTimer) {
            clearTimeout(state.pendingTimer);
            state.pendingTimer = null;
          }
          if (state.pendingResolvers.length > 0) {
            const superseded = state.pendingResolvers.splice(0, state.pendingResolvers.length);
            for (const r of superseded) {
              self.stats.coalescedSelections++;
              try {
                r.resolve(false);
              } catch {}
            }
          }

          state.pendingArgs = args;
          state.pendingThis = this;
          state.lastInvokeAt = now;

          return new Promise((resolve, reject) => {
            state.pendingResolvers.push({ resolve, reject });
            state.pendingTimer = setTimeout(() => {
              state.pendingTimer = null;
              const waiters = state.pendingResolvers.splice(0, state.pendingResolvers.length);
              const callThis = state.pendingThis || pane;
              const callArgs = state.pendingArgs || [];
              state.pendingThis = null;
              state.pendingArgs = null;
              state.lastInvokeAt = Date.now();

              if (self._destroyed || win.closed) {
                for (const w of waiters) {
                  try {
                    w.resolve(false);
                  } catch {}
                }
                return;
              }

              Promise.resolve()
                .then(() => origItemSelected.apply(callThis, callArgs))
                .then(
                  (val) => {
                    for (const w of waiters) w.resolve(val);
                  },
                  (err) => {
                    for (const w of waiters) w.reject(err);
                  }
                );
            }, debounceMs);
          });
        };

        state.wrappedItemSelected = wrappedItemSelected;
        pane.itemSelected = wrappedItemSelected;
      }

      // 2. Apply smart virtualized-table overscan for 120Hz smooth scrolling
      this._applyOverscanToWindow(win, state);

      state.onUnload = () => this.detachWindow(win);
      try {
        win.addEventListener("unload", state.onUnload, { once: true });
      } catch {}
    }

    _applyOverscanToWindow(win, state) {
      if (this._destroyed || !win || win.closed || !state) return false;
      const targetOverscan = Math.max(2, Math.min(16, Number(this.getPref("itemTreeOverscan", 6)) || 6));
      const jsWin = win.ZoteroPane?.itemsView?.tree?._jsWindow || null;
      if (jsWin && typeof jsWin.overscanCount === "number") {
        if (state.patchedJsWin && state.patchedJsWin !== jsWin && state.origOverscan != null) {
          try {
            state.patchedJsWin.overscanCount = state.origOverscan;
          } catch {}
        }
        if (state.patchedJsWin !== jsWin) {
          state.patchedJsWin = jsWin;
          state.origOverscan = jsWin.overscanCount;
        }
        jsWin.overscanCount = targetOverscan;
        this.stats.activeOverscan = targetOverscan;
        if (state.overscanRetryTimer) {
          clearTimeout(state.overscanRetryTimer);
          state.overscanRetryTimer = null;
        }
        return true;
      }
      // ItemsView mounts asynchronously right after startup: bounded one-shot retry (max 10 tries, zero idle polling)
      if (!state.overscanRetryTimer && state.overscanTries < 10) {
        state.overscanTries++;
        state.overscanRetryTimer = setTimeout(() => {
          state.overscanRetryTimer = null;
          this._applyOverscanToWindow(win, state);
        }, 400);
      }
      return false;
    }

    applySettings() {
      for (const win of Zotero.getMainWindows?.() || []) {
        if (!this._winStates.has(win)) {
          this.attachWindow(win);
        } else {
          this._applyOverscanToWindow(win, this._winStates.get(win));
        }
      }
    }

    detachWindow(win) {
      const state = this._winStates.get(win);
      if (!state) return;
      this._winStates.delete(win);
      this.stats.attachedWindows = this._winStates.size;

      if (state.pendingTimer) {
        clearTimeout(state.pendingTimer);
        state.pendingTimer = null;
      }
      if (state.overscanRetryTimer) {
        clearTimeout(state.overscanRetryTimer);
        state.overscanRetryTimer = null;
      }
      for (const w of state.pendingResolvers.splice(0, state.pendingResolvers.length)) {
        try {
          w.resolve(false);
        } catch {}
      }
      try {
        if (state.pane && state.origItemSelected && state.pane.itemSelected === state.wrappedItemSelected) {
          state.pane.itemSelected = state.origItemSelected;
        }
      } catch {}
      try {
        if (state.patchedJsWin && state.origOverscan != null) {
          state.patchedJsWin.overscanCount = state.origOverscan;
        }
      } catch {}
      try {
        if (win && !win.closed && state.onUnload) {
          win.removeEventListener("unload", state.onUnload);
        }
      } catch {}
    }

    getStats() {
      return {
        ...this.stats,
        coalesceEnabled: !!this.getPref("itemSelectCoalesceEnabled", true),
        debounceMs: Math.max(0, Math.min(300, Number(this.getPref("itemSelectDebounceMs", 75)) || 0)),
        overscan: Math.max(2, Math.min(16, Number(this.getPref("itemTreeOverscan", 6)) || 6)),
      };
    }

    shutdown() {
      this._destroyed = true;
      if (this._notifierID != null) {
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

  return { UIAccelerator };
})();
