/* global Zotero, Services, Components, ChromeUtils, ChromeWorker, IOUtils, PathUtils */
"use strict";

var ZotMuPDFEngineClient = (function () {
  const Cc = Components.classes;
  const Ci = Components.interfaces;
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const PREF_PREFIX = "extensions.zotero-turbo.mupdf.";
  const WORKER_URI = "chrome://zoturbo/content/render-worker.js";

  function nowMs() {
    try {
      if (typeof ChromeUtils.now === "function") {
        return ChromeUtils.now();
      }
    } catch {}
    return Date.now();
  }

  function getPref(name, fallback) {
    try {
      const v = Zotero.Prefs.get(PREF_PREFIX + name, true);
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function setPref(name, value) {
    try {
      Zotero.Prefs.set(PREF_PREFIX + name, value, true);
    } catch {}
  }

  // Copies any local/jar: URI (including jar: paths containing '@') directly to a file on disk in native C++.
  function extractUriToFile(uriStr, destPath) {
    return new Promise((resolve, reject) => {
      try {
        const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
        const channel = NetUtil.newChannel({
          uri: uriStr,
          loadUsingSystemPrincipal: true,
          securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
          contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
        });

        NetUtil.asyncFetch(channel, (inputStream, status) => {
          if (!Components.isSuccessCode(status)) {
            reject(new Error(`Failed to read ${uriStr}: status 0x${status.toString(16)}`));
            return;
          }
          try {
            const outFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            outFile.initWithPath(destPath);
            const fos = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
              Ci.nsIFileOutputStream
            );
            fos.init(outFile, 0x02 | 0x08 | 0x20, 0o755, 0);

            NetUtil.asyncCopy(inputStream, fos, copyStatus => {
              try {
                fos.close();
              } catch {}
              try {
                inputStream.close();
              } catch {}
              if (!Components.isSuccessCode(copyStatus)) {
                reject(new Error(`Failed writing ${destPath}: status 0x${copyStatus.toString(16)}`));
                return;
              }
              resolve();
            });
          } catch (e) {
            try {
              inputStream.close();
            } catch {}
            reject(e);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  class EngineClient {
    constructor({ rootURI, version, getBinaryPath = null }) {
      this.rootURI = rootURI;
      this.version = version || "0.2.0";
      this._getBinaryPath = getBinaryPath;
      this.dllPath = "";
      this.ctrlLib = null;
      this.ctrlEng = null;
      this.fnCtrlRelease = null;
      this.fnCtrlEvict = null;
      this.fnCtrlEvictPath = null;
      this.fnCtrlTrim = null;
      this.fnCtrlAbort = null;

      this.workers = []; // { worker, busy, activeJobId }
      this.queue = []; // pending render jobs
      this.pendingJobs = new Map(); // jobId -> job
      this.reqKeyToJobId = new Map(); // reqKey -> jobId
      this.nextJobId = 1;
      this.nextNativeReqId = 1;
      this._inFlightMain = 0;
      this._busyTimer = null;
      this._idleTrimTimer = null;
      this._statsEmitTimer = null;
      this._recycleIdx = 0;
      this._memPressureObserver = null;

      this.mupdfVersion = "";
      this.workerCount = 0;
      this.bgWorkerCount = 0;
      this.startPromise = null;
      this.ready = false;
      this.stopped = false;
      this.lastFailAt = 0;
      this.consecutiveFailures = 0;
      this.lastError = "";

      this.stats = {
        totalRenders: 0,
        cacheHits: 0,
        pixHits: 0,
        dlHits: 0,
        fallbacks: 0,
        cancelledRenders: 0,
        busy: false,
        paintMode: "",
        lastWidth: 0,
        lastHeight: 0,
        lastRenderMs: 0,
        lastQueueMs: 0,
        lastE2EMs: 0,
        lastIpcMs: 0,
        lastPaintMs: 0,
        lastTextLayerMs: 0,
        lastCacheTier: "",
        avgRenderMs: 0,
        avgE2EMs: 0,
        totalRenderMs: 0,
        totalE2EMs: 0,
        pdfjsRenders: 0,
        pdfjsLastMs: 0,
        pdfjsAvgMs: 0,
        pdfjsTotalMs: 0,
        thumbCount: 0,
        thumbLastMs: 0,
        lastFallbackReason: "",
        adaptiveUpgrades: 0,
        adaptiveDemotes: 0,
        lastAdaptiveTier: "",
      };
      this._listeners = new Set();
    }

    log(...args) {
      if (getPref("debugLog", false)) {
        Zotero.debug("[ZotMuPDF] " + args.join(" "));
      }
    }

    onStatsChange(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    }

    _flushStats() {
      if (this._statsEmitTimer) {
        clearTimeout(this._statsEmitTimer);
        this._statsEmitTimer = null;
      }
      const summary = this.getSummary();
      for (const fn of this._listeners) {
        try {
          fn(summary);
        } catch {}
      }
    }

    _emitStats(immediate = false) {
      if (immediate) {
        this._flushStats();
        return;
      }
      if (this._statsEmitTimer) return;
      this._statsEmitTimer = setTimeout(() => {
        this._statsEmitTimer = null;
        if (!this.stopped) {
          this._flushStats();
        }
      }, 80);
    }

    getSummary() {
      return {
        enabled: this.isEnabled(),
        ready: this.isReady(),
        adaptiveHiDPI: this.getConfig().adaptiveHiDPI,
        mupdfVersion: this.mupdfVersion,
        fgWorkers: this.workerCount,
        workers: this.workerCount + this.bgWorkerCount,
        lastError: this.lastError,
        ...this.stats,
      };
    }

    isEnabled() {
      return !!getPref("enabled", true);
    }

    setEnabled(val) {
      setPref("enabled", !!val);
      this._emitStats(true);
    }

    useSoftwareCanvas() {
      return !!getPref("softwareCanvas", true);
    }

    getConfig() {
      const rawMaxScale = Number(getPref("maxOutputScale", ""));
      const maxOutputScale = Number.isFinite(rawMaxScale) && rawMaxScale >= 0.75 ? rawMaxScale : 0;
      const rawMaxMP = String(getPref("maxPageMegapixels", "adaptive") ?? "adaptive").trim();
      const adaptiveHiDPI = rawMaxMP === "adaptive";
      const parsedMaxMP = rawMaxMP === "" || rawMaxMP === "native" || adaptiveHiDPI ? 0 : Number(rawMaxMP);
      const maxPageMegapixels = adaptiveHiDPI
        ? 3.6
        : Number.isFinite(parsedMaxMP) && parsedMaxMP >= 1.5
          ? parsedMaxMP
          : 0;
      const rawSlowDwell = Number(getPref("adaptiveSlowDwellMs", 400));
      const adaptiveSlowDwellMs = Number.isFinite(rawSlowDwell) && rawSlowDwell >= 140 ? rawSlowDwell : 400;
      const rawFastDwell = Number(getPref("adaptiveFastDwellMs", 1200));
      const adaptiveFastDwellMs = Number.isFinite(rawFastDwell) && rawFastDwell >= adaptiveSlowDwellMs ? rawFastDwell : 1200;
      const rawZoomDwell = Number(getPref("adaptiveZoomDwellMs", 250));
      const adaptiveZoomDwellMs = Number.isFinite(rawZoomDwell) && rawZoomDwell >= 80 ? rawZoomDwell : 250;
      return {
        renderThumbnails: !!getPref("renderThumbnails", true),
        aaLevel: Number(getPref("aaLevel", 8)) || 8,
        softwareCanvas: this.useSoftwareCanvas(),
        maxOutputScale,
        adaptiveHiDPI,
        maxPageMegapixels,
        adaptiveSlowDwellMs,
        adaptiveFastDwellMs,
        adaptiveZoomDwellMs,
        liteOverlayBlend: !!getPref("liteOverlayBlend", true),
        longDocCssOpt: !!getPref("longDocCssOpt", true),
        deferTextLayerOnScroll: !!getPref("deferTextLayerOnScroll", true),
        debugLog: !!getPref("debugLog", false),
      };
    }

    isReady() {
      return !this.stopped && this.ready && this.workers.length > 0;
    }

    recycleBuffer(buf) {
      if (this.stopped || !buf || this.workers.length === 0) return;
      try {
        // Keep <=32MB fast-tier scroll buffers (e.g. 14.4MB 3.6MP) warm in the worker pool while
        // letting one-shot 40-80MB unlimited 4K upgrade buffers release straight back to the OS!
        if (buf.byteLength < 1024 * 1024 || buf.byteLength > 32 * 1024 * 1024) return;
        const idx = this._recycleIdx++ % this.workers.length;
        const slot = this.workers[idx];
        slot.worker.postMessage({ cmd: "recycle", buf }, [buf]);
      } catch {}
    }

    _clearIdleTrim() {
      if (this._idleTrimTimer) {
        clearTimeout(this._idleTrimTimer);
        this._idleTrimTimer = null;
      }
    }

    _scheduleIdleTrim() {
      if (this.stopped) return;
      this._clearIdleTrim();
      this._idleTrimTimer = setTimeout(() => {
        this._idleTrimTimer = null;
        if (!this.stopped && this._inFlightMain === 0 && this.queue.length === 0) {
          this.trimMemory(false);
        }
      }, 20000);
    }

    _getNativeBinarySpec() {
      const os = String(Services.appinfo?.OS || "WINNT").toLowerCase();
      const abi = String(Services.appinfo?.XPCOMABI || "").toLowerCase();
      const isArm64 = abi.includes("aarch64") || abi.includes("arm64");
      const isX64 = abi.includes("x86_64") || abi.includes("amd64") || (!abi && os === "winnt");

      if (os === "winnt") {
        if (!isX64) {
          throw new Error(`Unsupported Windows architecture: ${abi || "unknown"} (x64 required)`);
        }
        return {
          ext: ".dll",
          tag: "win-x64",
          candidates: ["zotero-turbo-native-win-x64.dll"],
        };
      }
      if (os === "darwin") {
        if (isArm64) {
          return {
            ext: ".dylib",
            tag: "darwin-arm64",
            candidates: ["zotero-turbo-native-darwin-arm64.dylib"],
          };
        }
        if (isX64) {
          return {
            ext: ".dylib",
            tag: "darwin-x64",
            candidates: ["zotero-turbo-native-darwin-x64.dylib"],
          };
        }
        throw new Error(`Unsupported macOS architecture: ${abi || "unknown"}`);
      }
      if (os === "linux") {
        if (isX64) {
          return {
            ext: ".so",
            tag: "linux-x64",
            candidates: ["zotero-turbo-native-linux-x64.so"],
          };
        }
        throw new Error(`Unsupported Linux architecture: ${abi || "unknown"} (x86_64 required)`);
      }
      throw new Error(`Unsupported platform: ${os}/${abi}`);
    }

    async _ensureDLLExtracted() {
      if (typeof this._getBinaryPath === "function") {
        return await this._getBinaryPath();
      }
      const spec = this._getNativeBinarySpec();
      const binDir = PathUtils.join(Zotero.Profile.dir, "zotero-turbo-bin", `v${this.version}`);
      await IOUtils.makeDirectory(binDir, { ignoreExisting: true, createAncestors: true });

      const safeVer = String(this.version).replace(/[^0-9A-Za-z._-]/g, "_");
      const targetName = `zotero-turbo-native-${spec.tag}-${safeVer}${spec.ext}`;
      const targetPath = PathUtils.join(binDir, targetName);

      let needsExtract = true;
      try {
        const stat = await IOUtils.stat(targetPath);
        if (stat && stat.size > 1000000) {
          needsExtract = false;
        }
      } catch {}

      if (needsExtract) {
        const tmpPath = targetPath + ".tmp";
        let extracted = false;
        let lastErr = null;
        for (const cand of spec.candidates) {
          const srcURI = this.rootURI + "bin/" + cand;
          try {
            await extractUriToFile(srcURI, tmpPath);
            const tmpStat = await IOUtils.stat(tmpPath);
            if (!tmpStat || tmpStat.size < 1000000) {
              await IOUtils.remove(tmpPath).catch(() => {});
              throw new Error(`Extracted MuPDF native library invalid (${tmpStat?.size || 0} bytes) from ${srcURI}`);
            }
            extracted = true;
            break;
          } catch (e) {
            lastErr = e;
            await IOUtils.remove(tmpPath).catch(() => {});
          }
        }
        if (!extracted) {
          throw lastErr || new Error(`Native MuPDF binary not bundled for ${spec.tag}`);
        }
        await IOUtils.move(tmpPath, targetPath);

        // Clean up older versioned binaries best-effort
        try {
          const children = await IOUtils.getChildren(binDir);
          for (const child of children) {
            if (
              child !== targetPath &&
              (child.endsWith(".dll") ||
                child.endsWith(".dylib") ||
                child.endsWith(".so") ||
                child.endsWith(".exe"))
            ) {
              IOUtils.remove(child).catch(() => {});
            }
          }
        } catch {}
      }

      return targetPath;
    }

    async ensureStarted() {
      if (this.stopped) {
        throw new Error("EngineClient is shut down");
      }
      if (this.isReady()) {
        return;
      }
      if (this.startPromise) {
        return this.startPromise;
      }

      const now = Date.now();
      if (this.consecutiveFailures >= 3 && now - this.lastFailAt < 15000) {
        throw new Error(`Native MuPDF backoff: ${this.lastError || "init failed"}`);
      }

      this.startPromise = this._startInternal()
        .then(() => {
          this.ready = true;
          this.consecutiveFailures = 0;
          this.lastError = "";
          this._emitStats(true);
        })
        .catch(err => {
          this.consecutiveFailures++;
          this.lastFailAt = Date.now();
          this.lastError = String(err?.message || err);
          Zotero.logError(err);
          this._emitStats(true);
          throw err;
        })
        .finally(() => {
          this.startPromise = null;
        });

      return this.startPromise;
    }

    async _startInternal() {
      const dllPath = await this._ensureDLLExtracted();
      this.dllPath = dllPath;

      const storeMB = Number(getPref("storeMB", 96)) || 96;
      const pixCacheMB = Number(getPref("pixCacheMB", 128)) || 128;
      const bgPref = getPref("bgWorkers", 1);
      const bgWorkers = getPref("prerender", true) ? Math.max(0, Math.min(4, Number.isFinite(Number(bgPref)) ? Number(bgPref) : 1)) : 0;
      const fgWorkers = Math.max(1, Math.min(4, Number(getPref("workers", 2)) || 2));
      this.bgWorkerCount = bgWorkers;

      // Load control handle on chrome main thread for instant 0.001ms abort(), evict() & trim()
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      this.ctrlLib = ctypes.open(dllPath);
      const fnVer = this.ctrlLib.declare("zot_dll_version", ctypes.default_abi, ctypes.char.ptr);
      const fnAcquire = this.ctrlLib.declare(
        "zot_dll_engine_acquire",
        ctypes.default_abi,
        ctypes.voidptr_t,
        ctypes.int,
        ctypes.int,
        ctypes.int
      );
      this.fnCtrlRelease = this.ctrlLib.declare("zot_dll_engine_release", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
      this.fnCtrlEvict = this.ctrlLib.declare("zot_dll_engine_evict", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
      this.fnCtrlEvictPath = this.ctrlLib.declare(
        "zot_dll_engine_evict_path",
        ctypes.default_abi,
        ctypes.void_t,
        ctypes.voidptr_t,
        ctypes.char.ptr
      );
      this.fnCtrlTrim = this.ctrlLib.declare(
        "zot_dll_engine_trim",
        ctypes.default_abi,
        ctypes.void_t,
        ctypes.voidptr_t,
        ctypes.int
      );
      this.fnCtrlAbort = this.ctrlLib.declare(
        "zot_dll_engine_abort",
        ctypes.default_abi,
        ctypes.void_t,
        ctypes.voidptr_t,
        ctypes.int
      );

      this.ctrlEng = fnAcquire(storeMB, pixCacheMB, bgWorkers);
      if (!this.ctrlEng || this.ctrlEng.isNull()) {
        this.ctrlLib.close();
        this.ctrlLib = null;
        throw new Error("Failed to acquire native MuPDF engine singleton");
      }
      this.mupdfVersion = fnVer().readString();

      // Spawn ChromeWorker pool sharing the in-process lock-free DLL singleton
      const initPromises = [];
      for (let i = 0; i < fgWorkers; i++) {
        const w = new ChromeWorker(WORKER_URI);
        const slot = { worker: w, busy: false, activeJobId: 0 };
        const p = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("ChromeWorker MuPDF init timeout")), 8000);
          w.onmessage = ev => {
            const d = ev.data;
            if (!d) return;
            if (d.cmd === "init") {
              clearTimeout(timer);
              if (d.ok) {
                resolve();
              } else {
                reject(new Error(d.error || "worker init failed"));
              }
              return;
            }
            if (d.cmd === "render" || d.cmd === "thumb") {
              this._onWorkerRenderResult(slot, d);
            }
          };
          w.onerror = errEv => {
            clearTimeout(timer);
            const msg = errEv?.message || "ChromeWorker runtime error";
            Zotero.debug("[ZotMuPDF worker error] " + msg);
            if (!this.ready) {
              reject(new Error(msg));
            } else if (slot.activeJobId) {
              this._onWorkerRenderResult(slot, {
                jobId: slot.activeJobId,
                ok: false,
                isCancelled: false,
                error: msg,
              });
            }
          };
        });
        w.postMessage({
          cmd: "init",
          id: i + 1,
          dllPath,
          storeMB,
          pixCacheMB,
          bgWorkers,
        });
        this.workers.push(slot);
        initPromises.push(p);
      }

      await Promise.all(initPromises);
      this.workerCount = this.workers.length;

      // Hook Gecko/Zotero system memory-pressure signal so MuPDF immediately yields all rebuildable RAM!
      if (!this._memPressureObserver && typeof Services !== "undefined" && Services.obs?.addObserver) {
        this._memPressureObserver = {
          observe: (_subject, topic) => {
            if (!this.stopped && topic === "memory-pressure") {
              this.trimMemory(true);
            }
          },
        };
        try {
          Services.obs.addObserver(this._memPressureObserver, "memory-pressure");
        } catch {
          this._memPressureObserver = null;
        }
      }

      Zotero.debug(
        `[ZotMuPDF] In-process native MuPDF ${this.mupdfVersion} ready (${this.workerCount} lock-free ChromeWorkers + ${this.bgWorkerCount} lowest-prio bg threads, ${pixCacheMB}MB RGBA cache, ${storeMB}MB store)`
      );
    }

    _updateBusyIndicator() {
      if (this._inFlightMain > 0) {
        if (!this._busyTimer && !this.stats.busy) {
          this._busyTimer = setTimeout(() => {
            this._busyTimer = null;
            if (this._inFlightMain > 0 && !this.stats.busy) {
              this.stats.busy = true;
              this._emitStats(true);
            }
          }, 200);
        }
      } else {
        if (this._busyTimer) {
          clearTimeout(this._busyTimer);
          this._busyTimer = null;
        }
        if (this.stats.busy) {
          this.stats.busy = false;
          this._emitStats(true);
        }
      }
    }

    _takeNextJob() {
      let bestIdx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const j = this.queue[i];
        if (j.cancelled) {
          this.queue.splice(i, 1);
          this.pendingJobs.delete(j.jobId);
          if (this.reqKeyToJobId.get(j.reqKey) === j.jobId) {
            this.reqKeyToJobId.delete(j.reqKey);
          }
          i--;
          continue;
        }
        if (bestIdx === -1 || j.priority < this.queue[bestIdx].priority) {
          bestIdx = i;
          if (j.priority === 0) break;
        }
      }
      if (bestIdx === -1) return null;
      return this.queue.splice(bestIdx, 1)[0];
    }

    _pumpQueue() {
      while (this.queue.length > 0) {
        const freeSlot = this.workers.find(s => !s.busy);
        if (!freeSlot) return;

        const job = this._takeNextJob();
        if (!job) return;

        freeSlot.busy = true;
        freeSlot.activeJobId = job.jobId;
        job.tDispatch = nowMs();
        freeSlot.worker.postMessage({
          cmd: job.cmd || "render",
          jobId: job.jobId,
          nativeReqId: job.nativeReqId,
          ...job.payload,
        });
      }
    }

    _onWorkerRenderResult(slot, d) {
      slot.busy = false;
      slot.activeJobId = 0;

      const job = this.pendingJobs.get(d.jobId);
      if (job) {
        this.pendingJobs.delete(d.jobId);
        if (this.reqKeyToJobId.get(job.reqKey) === d.jobId) {
          this.reqKeyToJobId.delete(job.reqKey);
        }
        if (job.priority === 0 && job._countedMain) {
          job._countedMain = false;
          this._inFlightMain = Math.max(0, this._inFlightMain - 1);
          this._updateBusyIndicator();
        }

        if (job.cancelled || d.isCancelled) {
          if (d.buf) {
            this.recycleBuffer(d.buf);
          }
          this.stats.cancelledRenders++;
          const cancelErr = new Error("aborted");
          cancelErr.isCancelled = true;
          job.reject(cancelErr);
        } else if (!d.ok) {
          job.reject(new Error(d.error || "native render failed"));
        } else {
          const tNow = nowMs();
          const queueMs = Math.max(0, job.tDispatch - job.tEnqueue);
          const workerRoundtripMs = Math.max(0, tNow - job.tDispatch);
          const renderMs = Number(d.renderMs) || 0;
          const ipcMs = Math.max(0, workerRoundtripMs - renderMs);

          if (job.cmd === "thumb") {
            this.stats.thumbCount++;
            this.stats.thumbLastMs = renderMs;
            this._emitStats();
            job.resolve({
              buf: d.buf || null,
              width: d.width,
              height: d.height,
              aspect: d.aspect || d.width / Math.max(1, d.height),
              renderMs,
            });
          } else {
            const cacheTier = d.cacheTier || "cold";
            const cacheHit = !!d.cacheHit;

            if (job.priority === 0 || this.stats.totalRenders === 0) {
              this.stats.totalRenders++;
              if (cacheHit) this.stats.cacheHits++;
              if (cacheTier === "pix") this.stats.pixHits++;
              else if (cacheTier === "dl") this.stats.dlHits++;
              this.stats.lastRenderMs = renderMs;
              this.stats.lastQueueMs = queueMs;
              this.stats.lastIpcMs = ipcMs;
              this.stats.lastWidth = d.width | 0;
              this.stats.lastHeight = d.height | 0;
              this.stats.lastCacheTier = cacheTier;
              this.stats.totalRenderMs += renderMs;
              this.stats.avgRenderMs = this.stats.totalRenderMs / this.stats.totalRenders;
              this._emitStats();
            }

            job.resolve({
              buf: d.buf || null,
              width: d.width,
              height: d.height,
              renderMs,
              queueMs,
              ipcMs,
              cacheHit,
              cacheTier,
              pageW: d.pageW || 0,
              pageH: d.pageH || 0,
              priority: job.priority,
            });
          }
        }
      } else if (d.buf) {
        this.recycleBuffer(d.buf);
      }

      this._pumpQueue();
      if (this.queue.length === 0 && this._inFlightMain === 0) {
        this._scheduleIdleTrim();
      }
    }

    async renderPage(reqKey, payload, { priority = 0 } = {}) {
      await this.ensureStarted();
      this._clearIdleTrim();

      const jobId = this.nextJobId++;
      const nativeReqId = this.nextNativeReqId++;
      if (this.nextNativeReqId > 0x70000000) this.nextNativeReqId = 1;

      return new Promise((resolve, reject) => {
        const tEnqueue = nowMs();
        const job = {
          cmd: "render",
          jobId,
          nativeReqId,
          reqKey,
          payload,
          priority,
          resolve,
          reject,
          tEnqueue,
          tDispatch: tEnqueue,
          cancelled: false,
          _countedMain: priority === 0,
        };
        if (priority === 0) {
          this._inFlightMain++;
          this._updateBusyIndicator();
        }
        this.pendingJobs.set(jobId, job);
        this.reqKeyToJobId.set(reqKey, jobId);
        this.queue.push(job);
        this._pumpQueue();
      });
    }

    async renderThumb(reqKey, payload) {
      await this.ensureStarted();
      this._clearIdleTrim();

      const jobId = this.nextJobId++;
      const nativeReqId = this.nextNativeReqId++;
      if (this.nextNativeReqId > 0x70000000) this.nextNativeReqId = 1;

      return new Promise((resolve, reject) => {
        const tEnqueue = nowMs();
        const job = {
          cmd: "thumb",
          jobId,
          nativeReqId,
          reqKey,
          payload,
          priority: 1,
          resolve,
          reject,
          tEnqueue,
          tDispatch: tEnqueue,
          cancelled: false,
          _countedMain: false,
        };
        this.pendingJobs.set(jobId, job);
        this.reqKeyToJobId.set(reqKey, jobId);
        this.queue.push(job);
        this._pumpQueue();
      });
    }

    cancelRequest(reqKey) {
      const jobId = this.reqKeyToJobId.get(reqKey);
      if (!jobId) return;
      this.reqKeyToJobId.delete(reqKey);
      const job = this.pendingJobs.get(jobId);
      if (!job || job.cancelled) return;
      job.cancelled = true;

      if (job.priority === 0 && job._countedMain) {
        job._countedMain = false;
        this._inFlightMain = Math.max(0, this._inFlightMain - 1);
        this._updateBusyIndicator();
      }

      // Immediately abort in-flight C MuPDF display-list parse OR rasterize via fz_cookie!
      if (this.ctrlEng && this.fnCtrlAbort) {
        try {
          this.fnCtrlAbort(this.ctrlEng, job.nativeReqId);
        } catch {}
      }

      const qIdx = this.queue.indexOf(job);
      if (qIdx !== -1) {
        this.queue.splice(qIdx, 1);
        this.pendingJobs.delete(jobId);
        this.stats.cancelledRenders++;
        const cancelErr = new Error("aborted");
        cancelErr.isCancelled = true;
        job.reject(cancelErr);
      }
    }

    reportMuPDFPaint(e2eMs, paintMs, paintMode, isMainPage = true) {
      if (!Number.isFinite(e2eMs) || e2eMs < 0) return;
      if (!isMainPage && this.stats.lastE2EMs > 0) return;
      this.stats.lastE2EMs = e2eMs;
      if (Number.isFinite(paintMs) && paintMs >= 0) {
        this.stats.lastPaintMs = paintMs;
      }
      if (paintMode) {
        this.stats.paintMode = String(paintMode);
      }
      this.stats.totalE2EMs += e2eMs;
      const denom = Math.max(1, this.stats.totalRenders);
      this.stats.avgE2EMs = this.stats.totalE2EMs / denom;
      this._emitStats();
    }

    reportTextLayerTiming(ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      this.stats.lastTextLayerMs = ms;
      this._emitStats();
    }

    reportPdfJsTiming(ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      this.stats.pdfjsRenders++;
      this.stats.pdfjsLastMs = ms;
      this.stats.pdfjsTotalMs += ms;
      this.stats.pdfjsAvgMs = this.stats.pdfjsTotalMs / this.stats.pdfjsRenders;
      this._emitStats();
    }

    async evictCache() {
      for (const slot of this.workers) {
        try {
          slot.worker.postMessage({ cmd: "trim" });
        } catch {}
      }
      if (this.ctrlEng && this.fnCtrlEvict) {
        try {
          this.fnCtrlEvict(this.ctrlEng);
        } catch {}
      }
    }

    evictPath(filePath) {
      if (this.stopped || !filePath) return;
      for (const slot of this.workers) {
        try {
          slot.worker.postMessage({ cmd: "trim" });
        } catch {}
      }
      if (this.ctrlEng && this.fnCtrlEvictPath) {
        try {
          this.fnCtrlEvictPath(this.ctrlEng, String(filePath));
        } catch {}
      }
    }

    trimMemory(aggressive = false) {
      if (this.stopped) return;
      for (const slot of this.workers) {
        try {
          slot.worker.postMessage({ cmd: "trim" });
        } catch {}
      }
      if (this.ctrlEng && this.fnCtrlTrim) {
        try {
          this.fnCtrlTrim(this.ctrlEng, aggressive ? 1 : 0);
        } catch {}
      }
    }

    reportFallback(reason) {
      this.stats.fallbacks++;
      this.stats.lastFallbackReason = String(reason || "");
      this.log("Fallback to PDF.js:", reason);
      this._emitStats();
    }

    reportAdaptiveEvent(kind) {
      if (kind === "upgrade") {
        this.stats.adaptiveUpgrades++;
        this.stats.lastAdaptiveTier = "unlimited";
      } else if (kind === "demote") {
        this.stats.adaptiveDemotes++;
      } else if (kind === "fast") {
        this.stats.lastAdaptiveTier = "fast";
      } else if (kind === "unlimited") {
        this.stats.lastAdaptiveTier = "unlimited";
      } else {
        return;
      }
      this._emitStats();
    }

    async sleep() {
      if (this.stopped || !this.ready) return false;
      if (this._inFlightMain > 0 || this.queue.length > 0) return false;
      if (this._sleepPromise) return this._sleepPromise;
      this._sleepPromise = (async () => {
        try {
          if (this.stopped || !this.ready || this._inFlightMain > 0 || this.queue.length > 0) {
            return false;
          }
          this.ready = false;
          this.stats.busy = false;
          if (this._busyTimer) {
            clearTimeout(this._busyTimer);
            this._busyTimer = null;
          }
          this._clearIdleTrim();
          if (this._memPressureObserver && typeof Services !== "undefined" && Services.obs?.removeObserver) {
            try {
              Services.obs.removeObserver(this._memPressureObserver, "memory-pressure");
            } catch {}
            this._memPressureObserver = null;
          }
          const workers = this.workers.splice(0);
          this.workerCount = 0;
          this.bgWorkerCount = 0;
          await Promise.all(
            workers.map(
              slot =>
                new Promise(resolve => {
                  const t = setTimeout(() => {
                    try {
                      slot.worker.terminate();
                    } catch {}
                    resolve();
                  }, 800);
                  slot.worker.onmessage = ev => {
                    if (ev.data?.cmd === "shutdown") {
                      clearTimeout(t);
                      try {
                        slot.worker.terminate();
                      } catch {}
                      resolve();
                    }
                  };
                  try {
                    slot.worker.postMessage({ cmd: "shutdown", id: 0 });
                  } catch {
                    clearTimeout(t);
                    resolve();
                  }
                })
            )
          );
          try {
            if (this.ctrlEng && this.fnCtrlRelease) {
              this.fnCtrlRelease(this.ctrlEng);
              this.ctrlEng = null;
            }
            if (this.ctrlLib) {
              this.ctrlLib.close();
              this.ctrlLib = null;
            }
          } catch {}
          this._emitStats(true);
          return true;
        } finally {
          this._sleepPromise = null;
        }
      })();
      return this._sleepPromise;
    }

    async restart() {
      this.startPromise = null;
      await this.shutdown();
      this.stopped = false;
      this.ready = false;
      this.startPromise = null;
      this.consecutiveFailures = 0;
      this.lastFailAt = 0;
      this.lastError = "";
      this._emitStats(true);
      if (this.isEnabled()) {
        await this.ensureStarted();
      }
    }

    async shutdown() {
      this.stopped = true;
      this.ready = false;
      this._inFlightMain = 0;
      if (this._busyTimer) {
        clearTimeout(this._busyTimer);
        this._busyTimer = null;
      }
      this._clearIdleTrim();
      if (this._statsEmitTimer) {
        clearTimeout(this._statsEmitTimer);
        this._statsEmitTimer = null;
      }
      if (this._memPressureObserver && typeof Services !== "undefined" && Services.obs?.removeObserver) {
        try {
          Services.obs.removeObserver(this._memPressureObserver, "memory-pressure");
        } catch {}
        this._memPressureObserver = null;
      }

      for (const job of this.pendingJobs.values()) {
        job.cancelled = true;
        if (this.ctrlEng && this.fnCtrlAbort) {
          try {
            this.fnCtrlAbort(this.ctrlEng, job.nativeReqId);
          } catch {}
        }
        const cancelErr = new Error("aborted");
        cancelErr.isCancelled = true;
        try {
          job.reject(cancelErr);
        } catch {}
      }
      this.pendingJobs.clear();
      this.reqKeyToJobId.clear();
      this.queue.length = 0;

      const workers = this.workers.splice(0);
      await Promise.all(
        workers.map(
          slot =>
            new Promise(resolve => {
              const t = setTimeout(() => {
                try {
                  slot.worker.terminate();
                } catch {}
                resolve();
              }, 800);
              slot.worker.onmessage = ev => {
                if (ev.data?.cmd === "shutdown") {
                  clearTimeout(t);
                  try {
                    slot.worker.terminate();
                  } catch {}
                  resolve();
                }
              };
              try {
                slot.worker.postMessage({ cmd: "shutdown", id: 0 });
              } catch {
                clearTimeout(t);
                resolve();
              }
            })
        )
      );

      try {
        if (this.ctrlEng && this.fnCtrlRelease) {
          this.fnCtrlRelease(this.ctrlEng);
          this.ctrlEng = null;
        }
        if (this.ctrlLib) {
          this.ctrlLib.close();
          this.ctrlLib = null;
        }
      } catch {}
    }
  }

  return { EngineClient, getPref, setPref, extractUriToFile };
})();
