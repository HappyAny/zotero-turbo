/* global Zotero, Services, Components */
"use strict";

var ZotTurboPlugin = null;
var ZotTurboChromeHandle = null;
var ZotTurboPrefPaneID = null;

const ZOT_TURBO_PREF_PREFIX = "extensions.zotero-turbo.";
const ZOT_MUPDF_PREF_PREFIX = "extensions.zotero-turbo.mupdf.";
const LEGACY_MUPDF_PREFIX = "extensions.zotero-mupdf-engine.";

const ZOT_TURBO_DEFAULTS = {
  // Module 2: Native PDF Text Extraction, Recognizer, Outline, Ctrl+F, Batch Index & Worker Cleanup
  pdfFulltextEnabled: true,
  pdfRecognizerEnabled: true,
  batchIndexParallelEnabled: true,
  readerTextLayerEnabled: true,
  ctrlfAccelEnabled: true,
  readerOutlineEnabled: true,
  pdfjsCleanupEnabled: true,
  processedDataDelayMs: 1500,
  startupGraceSec: 45,
  startupProcessedDataDelayMs: 12000,
  processedDataMaxPages: 100,
  // Module 3: Smart Background Tab Hibernation & Window-Idle Auto-Slim
  tabHibernateEnabled: true,
  startupSelectLibraryTab: true,
  startupHibernateBackgroundTabs: true,
  tabHibernateMaxLoaded: 2,
  tabHibernateIdleMin: 10,
  tabHibernateNotes: false,
  autoBackgroundSlimEnabled: true,
  autoBackgroundSlimMin: 10,
  // Module 4: Multi-threaded Native Fulltext Scan & Search Cache
  searchNativeScanEnabled: true,
  searchCacheEnabled: true,
  // Module 5: Citation / CSL Accelerator
  citeCacheEnabled: true,
  citeUseCiteprocRs: false,
  // Module 6: SQLite PRAGMA Tuning & Auto-WebP Note Images
  sqliteTuneEnabled: true,
  sqliteCacheMB: 64,
  sqliteMmapMB: 256,
  noteWebpEnabled: true,
  noteWebpQuality: 85,
  noteWebpMinKB: 64,
  noteWebpMaxDim: 2560,
  // Module 7: Main UI Fluidity (ItemPane Selection Coalescing & 120Hz Virtualized Overscan)
  itemSelectCoalesceEnabled: true,
  itemSelectDebounceMs: 75,
  itemTreeOverscan: 6,
  // Internal migration flag
  migratedLegacyMuPDF: false,
};

const ZOT_MUPDF_DEFAULTS = {
  enabled: true,
  renderThumbnails: true,
  aaLevel: 8,
  workers: 2,
  bgWorkers: 1,
  storeMB: 96,
  pixCacheMB: 96,
  prerender: true,
  softwareCanvas: true,
  maxOutputScale: "",
  debugLog: false,
};

function readPrefRaw(full, fallback) {
  try {
    const t = Services.prefs.getPrefType(full);
    if (t === Services.prefs.PREF_BOOL) return Services.prefs.getBoolPref(full);
    if (t === Services.prefs.PREF_INT) return Services.prefs.getIntPref(full);
    if (t === Services.prefs.PREF_STRING) return Services.prefs.getStringPref(full);
  } catch {}
  return fallback;
}

function writePrefRaw(full, value) {
  if (typeof value === "boolean") Services.prefs.setBoolPref(full, value);
  else if (typeof value === "number") Services.prefs.setIntPref(full, Math.round(value));
  else if (typeof value === "string") Services.prefs.setStringPref(full, value);
}

function getPref(key, fallback) {
  return readPrefRaw(
    ZOT_TURBO_PREF_PREFIX + key,
    fallback !== undefined ? fallback : ZOT_TURBO_DEFAULTS[key]
  );
}

function setPref(key, value) {
  writePrefRaw(ZOT_TURBO_PREF_PREFIX + key, value);
}

function getMuPDFPref(key, fallback) {
  return readPrefRaw(
    ZOT_MUPDF_PREF_PREFIX + key,
    fallback !== undefined ? fallback : ZOT_MUPDF_DEFAULTS[key]
  );
}

function setMuPDFPref(key, value) {
  writePrefRaw(ZOT_MUPDF_PREF_PREFIX + key, value);
}

function resetAllPrefs() {
  for (const [k, v] of Object.entries(ZOT_TURBO_DEFAULTS)) {
    if (k === "migratedLegacyMuPDF") continue;
    setPref(k, v);
  }
  for (const [k, v] of Object.entries(ZOT_MUPDF_DEFAULTS)) {
    setMuPDFPref(k, v);
  }
}

function migrateLegacyMuPDFPrefsOnce() {
  try {
    if (getPref("migratedLegacyMuPDF", false)) return;
    for (const key of Object.keys(ZOT_MUPDF_DEFAULTS)) {
      const legacyFull = LEGACY_MUPDF_PREFIX + key;
      if (Services.prefs.prefHasUserValue(legacyFull)) {
        const val = readPrefRaw(legacyFull, ZOT_MUPDF_DEFAULTS[key]);
        setMuPDFPref(key, val);
      }
    }
    setPref("migratedLegacyMuPDF", true);
  } catch {}
}

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
  try {
    const startupAt = Date.now();
    await Zotero.initializationPromise;

    // Register chrome://zoturbo/content/ (src/) & chrome://zoturboui/content/ (content/)
    const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    ZotTurboChromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "zoturbo", rootURI + "src/"],
      ["content", "zoturboui", rootURI + "content/"],
    ]);

    // Register preference defaults for both Turbo & integrated MuPDF Render Engine
    const prefBranch = Services.prefs.getDefaultBranch("");
    for (const [k, v] of Object.entries(ZOT_TURBO_DEFAULTS)) {
      const full = ZOT_TURBO_PREF_PREFIX + k;
      if (typeof v === "boolean") prefBranch.setBoolPref(full, v);
      else if (typeof v === "number") prefBranch.setIntPref(full, v);
      else if (typeof v === "string") prefBranch.setStringPref(full, v);
    }
    for (const [k, v] of Object.entries(ZOT_MUPDF_DEFAULTS)) {
      const full = ZOT_MUPDF_PREF_PREFIX + k;
      if (typeof v === "boolean") prefBranch.setBoolPref(full, v);
      else if (typeof v === "number") prefBranch.setIntPref(full, v);
      else if (typeof v === "string") prefBranch.setStringPref(full, v);
    }

    migrateLegacyMuPDFPrefsOnce();

    // Load all modular sub-scripts
    Services.scriptloader.loadSubScript(rootURI + "src/native-client.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/engine-client.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/reader-hook.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/pdf-text-accel.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/tab-hibernator.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/search-accel.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/cite-accel.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/system-accel.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/ui-accel.js", globalThis);
    Services.scriptloader.loadSubScript(rootURI + "src/benchmark.js", globalThis);

    // Detect whether legacy standalone zotero-mupdf-engine is still installed & active
    const standaloneMuPDFDetected = !!(Zotero.ZotMuPDF && Zotero.ZotMuPDF !== ZotTurboPlugin);

    // Unified native binary extractor & text/scanner worker pool
    const nativeClient = new globalThis.ZotTurboNativeClient.NativeClient({ rootURI, version });

    // Integrated MuPDF 1.28.0 Render Engine (shares the EXACT same unified native DLL!)
    let renderEngine = null;
    let renderHook = null;
    if (!standaloneMuPDFDetected) {
      renderEngine = new globalThis.ZotMuPDFEngineClient.EngineClient({
        rootURI,
        version,
        getBinaryPath: () => nativeClient.ensureBinaryPath(),
      });
      renderHook = new globalThis.ZotMuPDFReaderHook.ReaderHook({
        pluginID: id,
        rootURI,
        engineClient: renderEngine,
      });
    } else {
      Zotero.debug(
        "[ZotTurbo] Standalone zotero-mupdf-engine detected — deferring render hooks to avoid double-patching. Uninstall old standalone plugin to use unified engine."
      );
    }

    const pdfTextAccel = new globalThis.ZotTurboPDFTextAccel.PDFTextAccelerator({
      rootURI,
      nativeClient,
      getPref,
      startupAt,
    });
    const tabHibernator = new globalThis.ZotTurboTabHibernator.TabHibernator({
      getPref,
      nativeClient,
      renderEngine,
      onBackgroundSlim: () => plugin.backgroundSlimMemory(),
      startupAt,
      startupSweepDelayMs: 4000,
    });
    const searchAccel = new globalThis.ZotTurboSearchAccel.SearchAccelerator({
      nativeClient,
      getPref,
    });
    const citeAccel = new globalThis.ZotTurboCiteAccel.CiteAccelerator({ getPref });
    const systemAccel = new globalThis.ZotTurboSystemAccel.SystemAccelerator({ getPref });
    const uiAccel = new globalThis.ZotTurboUIAccel.UIAccelerator({ getPref });

    const plugin = {
      id,
      version,
      rootURI,
      defaults: ZOT_TURBO_DEFAULTS,
      mupdfDefaults: ZOT_MUPDF_DEFAULTS,
      standaloneMuPDFDetected,
      getPref,
      setPref,
      getMuPDFPref,
      setMuPDFPref,
      resetAllPrefs,
      nativeClient,
      renderEngine,
      renderHook,
      pdfTextAccel,
      tabHibernator,
      searchAccel,
      citeAccel,
      systemAccel,
      uiAccel,
      getSummary() {
        const renderSummary = renderEngine
          ? renderEngine.getSummary()
          : standaloneMuPDFDetected && Zotero.ZotMuPDF?.engineClient?.getSummary
            ? Zotero.ZotMuPDF.engineClient.getSummary()
            : null;
        const nativeActive = nativeClient.available || !!renderEngine?.mupdfVersion;
        const hasError = !!(nativeClient.initError || renderEngine?.lastError);
        const fallbackPlatform = globalThis.ZotTurboNativeClient?.getNativeBinarySpec?.()?.platformKey || "";
        return {
          version,
          standaloneMuPDFDetected,
          nativeAvailable: nativeActive,
          standby: !nativeActive && !hasError,
          nativeVersion: nativeClient.nativeVersion || renderEngine?.mupdfVersion || "",
          platformKey: nativeClient.platformKey || fallbackPlatform,
          initError: nativeClient.initError,
          render: renderSummary,
          pdfText: pdfTextAccel.getStats(),
          tabs: tabHibernator.getStats(),
          search: searchAccel.getStats(),
          cite: citeAccel.getStats(),
          system: systemAccel.getStats(),
          ui: uiAccel.getStats(),
        };
      },
      async restartRenderEngine() {
        if (!renderEngine) return false;
        await renderEngine.restart();
        renderHook?.refreshAllViewers?.(true);
        return true;
      },
      async trimRenderCache() {
        if (renderEngine) {
          renderEngine.trimMemory(true);
        }
        await nativeClient.trim(true);
      },
      async clearAllCaches() {
        searchAccel.clearCache();
        citeAccel.clearCache();
        if (renderEngine) renderEngine.trimMemory(true);
        await nativeClient.trim(true);
      },
      async deepReclaimMemory() {
        const { setTimeout: delayTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
        const before = systemAccel.getMemorySnapshot();

        // 1. Hibernate all eligible background PDF tabs (biggest RAM consumer: 100-300 MB per tab)
        let hibernatedTabs = 0;
        try {
          hibernatedTabs = tabHibernator.hibernateAllBackground({ includeNotes: false, reason: "deep-reclaim" }) || 0;
        } catch {}

        // 2. Trim off-screen 2K/4K canvas page buffers on every still-open reader via Zotero 10's native trimMemory()
        let trimmedReaders = 0;
        try {
          for (const reader of Zotero.Reader?._readers || []) {
            if (!reader || reader._isUninitialized || reader._isTabClosed) continue;
            const internal = reader._internalReader;
            if (typeof internal?.trimMemory === "function") {
              internal.trimMemory();
              trimmedReaders++;
            } else if (typeof internal?._primaryView?.trimMemory === "function") {
              internal._primaryView.trimMemory();
              trimmedReaders++;
            }
          }
        } catch {}

        // 3. Clean PDF.js Worker decoded resources, JS caches, SQLite page caches & MuPDF native caches
        const cleanedWorkers = pdfTextAccel.cleanupAllPdfjsWorkers();
        searchAccel.clearCache();
        citeAccel.clearCache();
        try {
          await Zotero.DB?.queryAsync?.("PRAGMA shrink_memory");
        } catch {}
        if (renderEngine) renderEngine.trimMemory(true);
        await nativeClient.trim(true);

        // Give ChromeWorkers a brief moment to drop warm ArrayBuffer pools before Gecko GC
        await new Promise((r) => delayTimeout(r, 120));

        // 4. Full Gecko GC/CC + memory-pressure cycle (flushes JS heaps, image cache & jemalloc dirty pages)
        await new Promise((resolve) => {
          try {
            const mgr = Components.classes["@mozilla.org/memory-reporter-manager;1"].getService(
              Components.interfaces.nsIMemoryReporterManager
            );
            if (mgr && typeof mgr.minimizeMemoryUsage === "function") {
              mgr.minimizeMemoryUsage(() => resolve());
              return;
            }
          } catch {}
          resolve();
        });

        // 5. Return freed CRT/Win32 heap blocks & trim Windows Working Set so Task Manager reflects freed RAM
        await nativeClient.osTrimMemory(true);
        await new Promise((r) => delayTimeout(r, 150));

        const after = systemAccel.getMemorySnapshot();
        return {
          beforeMB: before.residentMB,
          afterMB: after.residentMB,
          freedMB: Math.max(0, before.residentMB - after.residentMB),
          hibernatedTabs,
          trimmedReaders,
          cleanedWorkers,
        };
      },
      async backgroundSlimMemory() {
        const { setTimeout: delayTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
        // Gentle non-destructive slim when Zotero is minimized/unfocused: keeps active tab & scroll position intact!
        try {
          for (const reader of Zotero.Reader?._readers || []) {
            if (!reader || reader._isUninitialized || reader._isTabClosed) continue;
            const internal = reader._internalReader;
            if (typeof internal?.trimMemory === "function") internal.trimMemory();
            else if (typeof internal?._primaryView?.trimMemory === "function") internal._primaryView.trimMemory();
          }
        } catch {}
        try {
          await Zotero.DB?.queryAsync?.("PRAGMA shrink_memory");
        } catch {}
        if (renderEngine) renderEngine.trimMemory(true);
        await nativeClient.trim(true);
        await new Promise((r) => delayTimeout(r, 80));
        await nativeClient.osTrimMemory(true);
        return true;
      },
      openPreferences() {
        try {
          const paneId = ZotTurboPrefPaneID || "zotero-turbo-prefpane";
          if (Zotero.Utilities?.Internal?.openPreferences) {
            Zotero.Utilities.Internal.openPreferences(paneId);
            return true;
          }
          const win = Zotero.getMainWindow?.();
          if (win?.ZoteroPane?.openPreferences) {
            win.ZoteroPane.openPreferences(paneId);
            return true;
          }
        } catch {}
        return false;
      },
      async runBenchmark(onProgress) {
        return globalThis.ZotTurboBenchmark.runSuite(plugin, onProgress);
      },
      async runHealthAudit() {
        return systemAccel.runHealthAudit();
      },
      async runVacuum() {
        return systemAccel.runVacuum();
      },
      async scanLegacyNoteImages() {
        return systemAccel.scanLegacyNoteImages();
      },
      async compressLegacyNoteImages(onProgress) {
        return systemAccel.compressLegacyNoteImages(onProgress);
      },
      revealDataDir() {
        return systemAccel.revealDataDir();
      },
    };

    ZotTurboPlugin = plugin;
    Zotero.ZotTurbo = plugin;

    // Initialize all 7 modules
    if (renderHook) {
      await renderHook.init();
    }
    await pdfTextAccel.init();
    tabHibernator.init();
    searchAccel.init();
    citeAccel.init();
    await systemAccel.init();
    uiAccel.init();

    // Register native Zotero Preferences Pane
    if (Zotero.PreferencePanes && typeof Zotero.PreferencePanes.register === "function") {
      try {
        ZotTurboPrefPaneID = await Zotero.PreferencePanes.register({
          pluginID: id,
          id: "zotero-turbo-prefpane",
          label: "Zotero Turbo",
          image: "chrome://zoturboui/content/icons/icon.svg",
          src: "chrome://zoturboui/content/preferences.xhtml",
          scripts: ["chrome://zoturboui/content/preferences.js"],
          stylesheets: ["chrome://zoturboui/content/preferences.css"],
          helpURL: "https://github.com/HappyAny/zotero-turbo",
        });
      } catch (prefErr) {
        Zotero.logError(prefErr);
      }
    }

    // Pure on-demand native engine startup:
    // - renderEngine warms only if a PDF reader is already open at startup
    // - nativeClient stays at 0 ChromeWorkers until first actual text/outline/search/index request
    const hasOpenReaders = (Zotero.Reader?._readers?.length || 0) > 0;
    if (hasOpenReaders && renderEngine && renderEngine.isEnabled()) {
      renderEngine.ensureStarted().catch((err) => {
        Zotero.debug("[ZotTurbo] MuPDF render engine warm-up notice: " + (err?.message || String(err)));
      });
    }

    Zotero.debug(`[ZotTurbo] Plugin v${version} initialized (unified 7-module native acceleration suite, on-demand standby=${!hasOpenReaders})`);
  } catch (err) {
    Zotero.logError("[ZotTurbo] startup failed:");
    Zotero.logError(err);
  }
}

function onMainWindowLoad({ window }) {
  try {
    ZotTurboPlugin?.renderHook?._scanAllReaders?.();
    ZotTurboPlugin?.tabHibernator?.attachWindow(window);
    ZotTurboPlugin?.uiAccel?.attachWindow(window);
    ZotTurboPlugin?.pdfTextAccel?.scanAllReaders();
  } catch {}
}

function onMainWindowUnload({ window }) {
  try {
    ZotTurboPlugin?.tabHibernator?.detachWindow(window, { preserveSessionHook: true });
    ZotTurboPlugin?.uiAccel?.detachWindow(window);
  } catch {}
}

async function shutdown(_data, reason) {
  const isAppShutdown = reason === (typeof APP_SHUTDOWN === "number" ? APP_SHUTDOWN : 2);
  if (ZotTurboPrefPaneID) {
    try {
      Zotero.PreferencePanes?.unregister?.(ZotTurboPrefPaneID);
    } catch {}
    ZotTurboPrefPaneID = null;
  }

  if (ZotTurboPlugin) {
    const p = ZotTurboPlugin;
    ZotTurboPlugin = null;
    if (Zotero.ZotTurbo === p) {
      delete Zotero.ZotTurbo;
    }
    // Strict reverse-init (LIFO) shutdown so chained hooks on Zotero.Reader.open restore cleanly
    try { p.uiAccel?.shutdown(); } catch (e) { Zotero.logError(e); }
    try { p.pdfTextAccel?.shutdown(); } catch (e) { Zotero.logError(e); }
    try { p.renderHook?.shutdown(); } catch (e) { Zotero.logError(e); }
    try { p.tabHibernator?.shutdown({ preserveSessionHook: isAppShutdown }); } catch (e) { Zotero.logError(e); }
    try { p.searchAccel?.shutdown(); } catch (e) { Zotero.logError(e); }
    try { p.citeAccel?.shutdown(); } catch (e) { Zotero.logError(e); }
    try { await p.systemAccel?.shutdown(); } catch (e) { Zotero.logError(e); }
    try { await p.renderEngine?.shutdown(); } catch (e) { Zotero.logError(e); }
    try { await p.nativeClient?.shutdown(); } catch (e) { Zotero.logError(e); }
  }

  if (ZotTurboChromeHandle) {
    try {
      ZotTurboChromeHandle.destruct();
    } catch {}
    ZotTurboChromeHandle = null;
  }

  globalThis.ZotMuPDFEngineClient = undefined;
  globalThis.ZotMuPDFReaderHook = undefined;
  globalThis.ZotTurboNativeClient = undefined;
  globalThis.ZotTurboPDFTextAccel = undefined;
  globalThis.ZotTurboTabHibernator = undefined;
  globalThis.ZotTurboSearchAccel = undefined;
  globalThis.ZotTurboCiteAccel = undefined;
  globalThis.ZotTurboSystemAccel = undefined;
  globalThis.ZotTurboUIAccel = undefined;
  globalThis.ZotTurboBenchmark = undefined;
}
