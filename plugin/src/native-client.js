/* global Zotero, Services, Components, ChromeUtils, ChromeWorker, IOUtils, PathUtils */
"use strict";

var ZotTurboNativeClient = (function () {
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  const PREF_PREFIX = "extensions.zotero-turbo.";
  const WORKER_URL = "chrome://zoturbo/content/native-worker.js";
  const IDLE_TRIM_MS = 25000;
  const DEFAULT_MIN_WORKERS = 1;
  const DEFAULT_MAX_WORKERS = 3;
  const DEFAULT_BURST_REAP_MS = 60000;
  const WORKER_STORE_MB = 32;

  function getNativeBinarySpec() {
    const os = String(Services.appinfo?.OS || "").toLowerCase();
    const abi = String(Services.appinfo?.XPCOMABI || "").toLowerCase();
    if (os === "winnt") {
      return {
        platformKey: "win-x64",
        filename: "zotero-turbo-native-win-x64.dll",
      };
    }
    if (os === "darwin") {
      const isArm = abi.includes("aarch64") || abi.includes("arm64");
      return {
        platformKey: isArm ? "darwin-arm64" : "darwin-x64",
        filename: isArm ? "zotero-turbo-native-darwin-arm64.dylib" : "zotero-turbo-native-darwin-x64.dylib",
      };
    }
    if (os === "linux") {
      return {
        platformKey: "linux-x64",
        filename: "zotero-turbo-native-linux-x64.so",
      };
    }
    return null;
  }

  class NativeWorkerSlot {
    constructor(index) {
      this.index = index;
      this.worker = null;
      this.ready = false;
      this.inFlight = 0;
      this.pending = new Map();
      this.nextId = 1;
    }

    start(dllPath, storeMB) {
      return new Promise((resolve, reject) => {
        const w = new ChromeWorker(WORKER_URL);
        this.worker = w;
        w.onmessage = (ev) => {
          const msg = ev.data;
          if (!msg || typeof msg.id === "undefined") return;
          const req = this.pending.get(msg.id);
          if (!req) return;
          this.pending.delete(msg.id);
          if (req.counted) this.inFlight = Math.max(0, this.inFlight - 1);
          if (msg.ok) req.resolve(msg.result);
          else req.reject(new Error(msg.error || "Native worker error"));
        };
        w.onerror = (ev) => {
          const msg = ev?.message || "ChromeWorker crashed";
          this.ready = false;
          for (const [, req] of this.pending) {
            req.reject(new Error(msg));
          }
          this.pending.clear();
          this.inFlight = 0;
        };
        this.call("init", { dllPath, storeMB }, false)
          .then((res) => {
            this.ready = true;
            resolve(res);
          })
          .catch((err) => {
            try {
              w.terminate();
            } catch {}
            this.worker = null;
            this.ready = false;
            reject(err);
          });
      });
    }

    call(op, payload, countLoad = true) {
      if (!this.worker) {
        return Promise.reject(new Error("Native worker not running"));
      }
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        if (countLoad) this.inFlight++;
        this.pending.set(id, { resolve, reject, counted: countLoad });
        try {
          this.worker.postMessage({ id, op, ...payload });
        } catch (err) {
          this.pending.delete(id);
          if (countLoad) this.inFlight = Math.max(0, this.inFlight - 1);
          reject(err);
        }
      });
    }

    async shutdown() {
      if (!this.worker) return;
      const w = this.worker;
      this.ready = false;
      try {
        await Promise.race([
          this.call("shutdown", {}, false),
          new Promise((r) => setTimeout(r, 800)),
        ]);
      } catch {}
      try {
        w.terminate();
      } catch {}
      this.worker = null;
      this.pending.clear();
      this.inFlight = 0;
    }
  }

  class NativeClient {
    constructor({ rootURI, version, minWorkers = DEFAULT_MIN_WORKERS, maxWorkers = DEFAULT_MAX_WORKERS, burstReapMs = DEFAULT_BURST_REAP_MS }) {
      this.rootURI = rootURI;
      this.version = version;
      this.minWorkers = Math.max(1, minWorkers);
      this.maxWorkers = Math.max(this.minWorkers, maxWorkers);
      this.burstReapMs = Math.max(50, burstReapMs);
      this.slots = [];
      this.dllPath = null;
      this.nativeVersion = null;
      this.platformKey = null;
      this.available = false;
      this.initError = null;
      this._extractPromise = null;
      this._startPromise = null;
      this._spawningBurst = false;
      this._idleTimer = null;
      this._reapTimer = null;
      this._destroyed = false;
      this._nextSlotIndex = 0;
      this._rr = 0;
    }

    ensureBinaryPath() {
      if (this.dllPath) return Promise.resolve(this.dllPath);
      if (this._extractPromise) return this._extractPromise;
      this._extractPromise = this._extractNativeBinary()
        .then((p) => {
          this.dllPath = p;
          return p;
        })
        .finally(() => {
          this._extractPromise = null;
        });
      return this._extractPromise;
    }

    getPref(key, fallback) {
      const full = PREF_PREFIX + key;
      try {
        const t = Services.prefs.getPrefType(full);
        if (t === Services.prefs.PREF_BOOL) return Services.prefs.getBoolPref(full);
        if (t === Services.prefs.PREF_INT) return Services.prefs.getIntPref(full);
        if (t === Services.prefs.PREF_STRING) return Services.prefs.getStringPref(full);
      } catch {}
      return fallback;
    }

    async _extractNativeBinary() {
      const spec = getNativeBinarySpec();
      if (!spec) {
        throw new Error("Unsupported OS/ABI for native library");
      }
      this.platformKey = spec.platformKey;

      const profileDir = PathUtils.profileDir || Zotero.Profile.dir;
      const binDir = PathUtils.join(profileDir, "zotero-turbo-bin", `v${this.version}`);
      await IOUtils.makeDirectory(binDir, { createAncestors: true, ignoreExisting: true });
      const targetPath = PathUtils.join(binDir, spec.filename);

      const binURI = `${this.rootURI}bin/${spec.filename}`;
      let exists = false;
      try {
        const stat = await IOUtils.stat(targetPath);
        exists = stat && stat.size > 4096;
      } catch {}

      if (!exists) {
        const channel = Services.io.newChannel(
          binURI,
          null,
          null,
          null,
          Services.scriptSecurityManager.getSystemPrincipal(),
          null,
          Components.interfaces.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
          Components.interfaces.nsIContentPolicy.TYPE_OTHER
        );
        const bytes = await new Promise((resolve, reject) => {
          const chunks = [];
          let total = 0;
          const listener = {
            onStartRequest() {},
            onDataAvailable(_req, stream, _off, count) {
              const bis = Components.classes["@mozilla.org/binaryinputstream;1"]
                .createInstance(Components.interfaces.nsIBinaryInputStream);
              bis.setInputStream(stream);
              const arr = new Uint8Array(count);
              bis.readArrayBuffer(count, arr.buffer);
              chunks.push(arr);
              total += count;
            },
            onStopRequest(_req, status) {
              if (!Components.isSuccessCode(status)) {
                reject(new Error(`Failed to read native binary ${binURI} (0x${status.toString(16)})`));
                return;
              }
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                merged.set(c, off);
                off += c.byteLength;
              }
              resolve(merged);
            },
          };
          channel.asyncOpen(listener);
        });
        if (!bytes || bytes.byteLength < 1000000) {
          throw new Error(`Native binary ${binURI} appears truncated (${bytes?.byteLength || 0} bytes)`);
        }
        const tmpPath = targetPath + ".tmp";
        await IOUtils.write(tmpPath, bytes);
        if (Services.appinfo?.OS !== "WINNT") {
          try {
            await IOUtils.setPermissions(tmpPath, 0o755);
          } catch {}
        }
        await IOUtils.move(tmpPath, targetPath);

        // Best-effort cleanup of older versioned DLL folders (saves ~8.5 MB per past upgrade)
        try {
          const parentBinRoot = PathUtils.join(profileDir, "zotero-turbo-bin");
          const siblings = await IOUtils.getChildren(parentBinRoot);
          for (const child of siblings || []) {
            if (child !== binDir && PathUtils.filename(child).startsWith("v")) {
              IOUtils.remove(child, { recursive: true, ignoreAbsent: true }).catch(() => {});
            }
          }
        } catch {}
      }

      return targetPath;
    }

    async ensureStarted() {
      if (this._destroyed) return false;
      if (this.available && this.slots.some((s) => s.ready)) return true;
      if (this._startPromise) return this._startPromise;

      this._startPromise = (async () => {
        try {
          const dllPath = await this.ensureBinaryPath();
          this.dllPath = dllPath;
          // Elastic worker pool: start lean with 1 baseline worker (~32 MB MuPDF store)
          // and dynamically burst up to maxWorkers (3) only under concurrent load.
          const created = [];
          for (let i = 0; i < this.minWorkers; i++) {
            const slot = new NativeWorkerSlot(this._nextSlotIndex++);
            const res = await slot.start(dllPath, WORKER_STORE_MB);
            this.nativeVersion = res?.version || this.version;
            created.push(slot);
          }
          if (this._destroyed) {
            await Promise.all(created.map((s) => s.shutdown().catch(() => {})));
            return false;
          }
          this.slots = created;
          this.available = true;
          this.initError = null;
          return true;
        } catch (err) {
          this.available = false;
          this.initError = err?.message || String(err);
          Zotero.debug("[ZotTurbo] Native DLL init unavailable (falling back to JS): " + this.initError);
          return false;
        } finally {
          this._startPromise = null;
        }
      })();

      return this._startPromise;
    }

    _maybeSpawnBurstWorker() {
      if (this._destroyed || this._spawningBurst || !this.dllPath || this.slots.length >= this.maxWorkers) {
        return;
      }
      this._spawningBurst = true;
      const slot = new NativeWorkerSlot(this._nextSlotIndex++);
      slot
        .start(this.dllPath, WORKER_STORE_MB)
        .then(() => {
          if (this._destroyed || this.slots.length >= this.maxWorkers) {
            slot.shutdown().catch(() => {});
            return;
          }
          this.slots.push(slot);
          this._touchBurstReap();
        })
        .catch((err) => {
          Zotero.debug("[ZotTurbo] Elastic burst worker spawn skipped: " + (err?.message || String(err)));
        })
        .finally(() => {
          this._spawningBurst = false;
        });
    }

    _touchBurstReap() {
      if (this._reapTimer) {
        clearTimeout(this._reapTimer);
        this._reapTimer = null;
      }
      if (this._destroyed || this.slots.length <= this.minWorkers) return;
      this._reapTimer = setTimeout(() => {
        this._reapTimer = null;
        this._reapIdleBurstWorkers();
      }, this.burstReapMs);
    }

    _reapIdleBurstWorkers() {
      if (this._destroyed || this.slots.length <= this.minWorkers) return;
      const keep = [];
      const toClose = [];
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (keep.length < this.minWorkers) {
          keep.push(s);
        } else if (s.inFlight === 0 && s.pending.size === 0) {
          toClose.push(s);
        } else {
          keep.push(s);
        }
      }
      if (toClose.length > 0) {
        this.slots = keep;
        for (const s of toClose) {
          s.shutdown().catch(() => {});
        }
      }
      if (this.slots.length > this.minWorkers) {
        this._touchBurstReap();
      }
    }

    _pickSlot() {
      const readySlots = this.slots.filter((s) => s.ready);
      if (readySlots.length === 0) return null;
      let best = readySlots[0];
      for (let i = 1; i < readySlots.length; i++) {
        if (readySlots[i].inFlight < best.inFlight) {
          best = readySlots[i];
        }
      }
      if (best.inFlight > 0 && this.slots.length < this.maxWorkers) {
        this._maybeSpawnBurstWorker();
      }
      if (readySlots.every((s) => s.inFlight === best.inFlight)) {
        best = readySlots[this._rr++ % readySlots.length];
      }
      if (this.slots.length > this.minWorkers) {
        this._touchBurstReap();
      }
      return best;
    }

    _touchIdleTrim() {
      if (this._idleTimer) {
        clearTimeout(this._idleTimer);
      }
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        this.trim(false).catch(() => {});
      }, IDLE_TRIM_MS);
    }

    async extractFulltext(path, maxPages = 0) {
      const ok = await this.ensureStarted();
      if (!ok) return { ok: false, errCode: -10 };
      const slot = this._pickSlot();
      if (!slot) return { ok: false, errCode: -10 };
      this._touchIdleTrim();
      return slot.call("fulltext", { path, maxPages: maxPages || 0 });
    }

    async extractPageData(path, pageIndex) {
      const ok = await this.ensureStarted();
      if (!ok) return { ok: false, errCode: -10 };
      const slot = this._pickSlot();
      if (!slot) return { ok: false, errCode: -10 };
      this._touchIdleTrim();
      return slot.call("pageData", { path, pageIndex });
    }

    async extractOutline(path) {
      const ok = await this.ensureStarted();
      if (!ok) return { ok: false, errCode: -10 };
      const slot = this._pickSlot();
      if (!slot) return { ok: false, errCode: -10 };
      this._touchIdleTrim();
      return slot.call("outline", { path });
    }

    async extractRecognizerData(path, maxPages = 5) {
      const ok = await this.ensureStarted();
      if (!ok) return { ok: false, errCode: -10 };
      const slot = this._pickSlot();
      if (!slot) return { ok: false, errCode: -10 };
      this._touchIdleTrim();
      return slot.call("recognizerData", { path, maxPages });
    }

    async hasAnnotations(path) {
      const ok = await this.ensureStarted();
      if (!ok) return { ok: false, errCode: -10 };
      const slot = this._pickSlot();
      if (!slot) return { ok: false, errCode: -10 };
      this._touchIdleTrim();
      return slot.call("hasAnnots", { path });
    }

    async scanFiles(paths, needle, { caseSensitive = false, normalizeWhitespace = true, maxBytes = 500000, threads = 0 } = {}) {
      const ok = await this.ensureStarted();
      if (!ok) return { ok: false, errCode: -10 };
      const slot = this._pickSlot();
      if (!slot) return { ok: false, errCode: -10 };
      const flags = (caseSensitive ? 1 : 0) | (normalizeWhitespace ? 2 : 0);
      const pathsBlob = paths.join("\n");
      return slot.call("scanFiles", { pathsBlob, needle, flags, maxBytes, threads });
    }

    async evictPath(path) {
      if (!path || !this.available) return;
      await Promise.all(
        this.slots.filter((s) => s.ready).map((s) => s.call("evictPath", { path }, false).catch(() => {}))
      );
    }

    async trim(aggressive = false) {
      if (!this.available) return;
      await Promise.all(
        this.slots.filter((s) => s.ready).map((s) => s.call("trim", { aggressive: !!aggressive }, false).catch(() => {}))
      );
    }

    async osTrimMemory(trimWorkingSet = true) {
      const ok = await this.ensureStarted();
      if (!ok) return false;
      const slot = this._pickSlot();
      if (!slot) return false;
      try {
        await slot.call("osTrim", { trimWorkingSet: !!trimWorkingSet }, false);
        return true;
      } catch {
        return false;
      }
    }

    async shutdown() {
      this._destroyed = true;
      if (this._idleTimer) {
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
      }
      if (this._reapTimer) {
        clearTimeout(this._reapTimer);
        this._reapTimer = null;
      }
      const list = this.slots.splice(0);
      await Promise.all(list.map((s) => s.shutdown().catch(() => {})));
      this.available = false;
    }
  }

  return { NativeClient, getNativeBinarySpec };
})();
