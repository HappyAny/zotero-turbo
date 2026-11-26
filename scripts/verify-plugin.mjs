import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "plugin");

function loadScriptInContext(relPath, ctx) {
  const full = path.join(PLUGIN_DIR, relPath);
  const code = fs.readFileSync(full, "utf8");
  vm.runInContext(code, ctx, { filename: relPath });
}

console.log("=== [Check 1] Syntax, Manifest, XHTML & Binary checks ===");
{
  const jsFiles = [
    "bootstrap.js",
    "src/native-worker.js",
    "src/native-client.js",
    "src/render-worker.js",
    "src/engine-client.js",
    "src/page-patch.js",
    "src/reader-hook.js",
    "src/reader-text-patch.js",
    "src/pdf-text-accel.js",
    "src/tab-hibernator.js",
    "src/search-accel.js",
    "src/cite-accel.js",
    "src/system-accel.js",
    "src/ui-accel.js",
    "src/benchmark.js",
    "content/preferences.js",
  ];
  for (const f of jsFiles) {
    const code = fs.readFileSync(path.join(PLUGIN_DIR, f), "utf8");
    new vm.Script(code, { filename: f });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
  assert.equal(manifest.applications.zotero.id, "zotero-turbo@happyany.github.io");
  assert.equal(manifest.version, "0.14.2");
  const bootSrc = fs.readFileSync(path.join(PLUGIN_DIR, "bootstrap.js"), "utf8");
  assert.ok(
    bootSrc.indexOf("await Zotero.initializationPromise;") < bootSrc.indexOf("const startupAt = Date.now();"),
    "startupAt must be captured AFTER await Zotero.initializationPromise so slow init does not eat startup grace windows!"
  );
  assert.ok(
    typeof manifest.applications.zotero.update_url === "string" &&
      manifest.applications.zotero.update_url.startsWith("https://"),
    "Zotero requires applications.zotero.update_url in manifest.json!"
  );
  assert.ok(manifest.applications.zotero.strict_max_version, "Zotero requires strict_max_version!");

  // Validate preferences.xhtml uses html: prefix for HTML tags and native XUL <menulist> (never broken <html:select>)
  const xhtml = fs.readFileSync(path.join(PLUGIN_DIR, "content/preferences.xhtml"), "utf8");
  assert.ok(xhtml.includes('xmlns:html="http://www.w3.org/1999/xhtml"'), "Missing html namespace");
  assert.ok(!xhtml.includes("<html:select"), "Do not use <html:select> in Zotero XUL preferences (popup fails); use XUL <menulist>!");
  assert.ok(xhtml.includes('<menulist id="zt-mupdf-aaLevel"'), "Expected native XUL <menulist> for aaLevel");
  assert.ok(xhtml.includes('<menulist id="zt-mupdf-maxOutputScale"'), "Expected native XUL <menulist> for maxOutputScale");
  assert.ok(xhtml.includes('<menulist id="zt-mupdf-maxPageMegapixels"'), "Expected native XUL <menulist> for maxPageMegapixels");
  assert.ok(xhtml.includes('<menuitem value="adaptive"'), "Expected adaptive HiDPI option in maxPageMegapixels menulist");
  assert.ok(xhtml.includes('id="zt-mupdf-liteOverlayBlend"'), "Expected liteOverlayBlend checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-mupdf-longDocCssOpt"'), "Expected longDocCssOpt checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-mupdf-deferTextLayerOnScroll"'), "Expected deferTextLayerOnScroll checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-trimBackgroundTabCanvas"'), "Expected trimBackgroundTabCanvas checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-longDocScrollOpt"'), "Expected longDocScrollOpt checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-btn-health-audit"'), "Expected health audit button in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-btn-vacuum-db"'), "Expected VACUUM button in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-btn-scan-note-png"'), "Expected scan note PNG button in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-btn-compress-note-png"'), "Expected compress note PNG button in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-ctrlfAccelEnabled"'), "Expected Ctrl+F checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-batchIndexParallelEnabled"'), "Expected batch index checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-autoBackgroundSlimEnabled"'), "Expected autoBackgroundSlim checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-startupSelectLibraryTab"'), "Expected startupSelectLibraryTab checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-startupHibernateBackgroundTabs"'), "Expected startupHibernateBackgroundTabs checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-autoBackgroundSlimMin"'), "Expected autoBackgroundSlimMin input in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-itemSelectCoalesceEnabled"'), "Expected itemSelectCoalesceEnabled checkbox in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-itemSelectDebounceMs"'), "Expected itemSelectDebounceMs input in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-pref-itemTreeOverscan"'), "Expected itemTreeOverscan input in preferences.xhtml");
  assert.ok(xhtml.includes('id="zt-stat-ui"'), "Expected zt-stat-ui metric in preferences.xhtml");
  assert.ok(
    !/<(div|span|button|input|label|h2|p|hr|strong|select|option|table)\b/.test(xhtml),
    "Unprefixed HTML tag found in XUL XHTML!"
  );
  const pagePatchSrc = fs.readFileSync(path.join(PLUGIN_DIR, "src/page-patch.js"), "utf8");
  assert.ok(!pagePatchSrc.includes("proto.getProcessedData"), "page-patch.js must not duplicate reader-text-patch's getProcessedData hook!");
  const nativeWorkerSrc = fs.readFileSync(path.join(PLUGIN_DIR, "src/native-worker.js"), "utf8");
  assert.ok(nativeWorkerSrc.includes("readStringReplaceMalformed"), "native-worker.js must use fast C++ UTF-8 string decoding");
  assert.ok(nativeWorkerSrc.includes("zot_turbo_pdf_has_annots"), "native-worker.js must declare zot_turbo_pdf_has_annots");
  assert.ok(nativeWorkerSrc.includes("zot_turbo_os_trim_memory"), "native-worker.js must declare zot_turbo_os_trim_memory");
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, "bin/zotero-turbo-native-win-x64.dll")), "Missing compiled Win x64 DLL");
  console.log(`  PASS: ${jsFiles.length} JS files parsed, manifest v0.14.2 + XUL menulist + unified DLL verified`);
}

console.log("=== [Check 2] Cross-platform ABI binary routing ===");
{
  for (const [os, abi, expected] of [
    ["WINNT", "x86_64-msvc", "zotero-turbo-native-win-x64.dll"],
    ["Darwin", "aarch64-gcc3", "zotero-turbo-native-darwin-arm64.dylib"],
    ["Darwin", "x86_64-gcc3", "zotero-turbo-native-darwin-x64.dylib"],
    ["Linux", "x86_64-gcc3", "zotero-turbo-native-linux-x64.so"],
  ]) {
    const ctx = vm.createContext({
      Services: { appinfo: { OS: os, XPCOMABI: abi }, prefs: {} },
      ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
      Zotero: {},
      Components: {},
      IOUtils: {},
      PathUtils: {},
    });
    loadScriptInContext("src/native-client.js", ctx);
    const spec = ctx.ZotTurboNativeClient.getNativeBinarySpec();
    assert.equal(spec.filename, expected, `ABI mismatch for ${os}/${abi}`);
  }
  console.log("  PASS: 4-platform native binary routing verified");
}

console.log("=== [Check 3] Module 1: PDF fulltext & Reader getPageData coordinate math ===");
{
  let origFulltextCalls = 0;
  const mockPdfWorker = {
    async getFullText(itemID, maxPages, _isPri, password) {
      origFulltextCalls++;
      return { text: "ORIG:" + itemID + ":" + (password || ""), extractedPages: 1, totalPages: 1 };
    },
  };
  const mockNative = {
    async extractFulltext(p, maxPages) {
      return { ok: true, text: "e\u0301 Hello MuPDF \f Page 2  ", extractedPages: maxPages || 5, totalPages: 5, ms: 4.2 };
    },
    async extractPageData() {
      return {
        ok: true,
        ms: 1.4,
        json: JSON.stringify({
          b: [0, 0, 612, 792],
          f: ["Times-Roman"],
          c: [
            // 'A' at MuPDF top-down (72, 60) -> (80, 72)
            [65, 72, 60, 80, 72, 72, 60, 80, 72, 12, 0, 4 | 8, 0],
            // '-' trailing hyphen with lineBreak + paragraphBreak + ignorable
            [45, 84, 60, 88, 72, 84, 60, 88, 72, 12, 0, 16 | 32 | 64, 0],
          ],
          l: [[1, 70, 58, 90, 74, "https://zotero.org", -1, 0, 0]],
        }),
      };
    },
    async evictPath() {},
  };

  const ctx = vm.createContext({
    Zotero: {
      PDFWorker: mockPdfWorker,
      Items: {
        async getAsync(id) {
          return {
            id,
            isPDFAttachment: () => true,
            getFilePathAsync: async () => "C:\\papers\\test.pdf",
          };
        },
      },
      File: { getResourceAsync: async () => fs.readFileSync(path.join(PLUGIN_DIR, "src/reader-text-patch.js"), "utf8") },
      Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
      Reader: { _readers: [] },
      debug() {},
    },
    Services: {},
    Components: { utils: { cloneInto: (x) => x, isDeadWrapper: () => false } },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
  });
  loadScriptInContext("src/pdf-text-accel.js", ctx);
  const accel = new ctx.ZotTurboPDFTextAccel.PDFTextAccelerator({
    rootURI: "file:///mock/",
    nativeClient: mockNative,
    getPref: (_k, def) => def,
  });
  await accel.init();

  // Test native fulltext + NFC normalization
  const ft = await ctx.Zotero.PDFWorker.getFullText(101, 3, false, null);
  assert.equal(ft.extractedPages, 3);
  assert.equal(ft.totalPages, 5);
  assert.equal(ft.text.startsWith("\u00e9 Hello MuPDF"), true, "Expected NFC normalized text");
  assert.equal(origFulltextCalls, 0);

  // Test password fallback
  const ftPw = await ctx.Zotero.PDFWorker.getFullText(101, 3, false, "secret");
  assert.equal(ftPw.text, "ORIG:101:secret");
  assert.equal(origFulltextCalls, 1);

  // Test reader-text-patch.js coordinate transform + fallback
  let origGetPageDataCalls = 0;
  let hits = 0, fallbacks = 0;
  function MockPDFDoc() {}
  MockPDFDoc.prototype.getPage = async function (pageNum) {
    if (pageNum === 2) return { view: [0, 0, 612, 792], rotate: 90 };
    return { view: [10, 20, 622, 812], rotate: 0 }; // non-zero CropBox offset [10, 20]
  };
  MockPDFDoc.prototype.getPageData = async function () {
    origGetPageDataCalls++;
    return { partial: true, chars: [{ c: "FALLBACK" }], overlays: [], viewBox: [0, 0, 612, 792] };
  };
  const docInst = new MockPDFDoc();
  const winCtx = vm.createContext({
    Promise,
    setTimeout,
    clearTimeout,
    PDFViewerApplication: { pdfDocument: docInst },
    __zotTurboTextBridge: {
      isEnabled: () => true,
      requestPageData: (idx) => mockNative.extractPageData("test.pdf", idx),
      reportHit: () => hits++,
      reportFallback: () => fallbacks++,
    },
  });
  winCtx.window = winCtx;
  loadScriptInContext("src/reader-text-patch.js", winCtx);

  // Page 0: non-zero CropBox [10, 20, 622, 812] -> vx0=10, vy1=812
  // MuPDF rect [72, 60, 80, 72] => PDF rect [10+72, 812-72, 10+80, 812-60] = [82, 740, 90, 752]
  const pd0 = await docInst.getPageData({ pageIndex: 0 });
  assert.equal(hits, 1);
  assert.equal(pd0.chars.length, 2);
  assert.equal(pd0.chars[0].offset, 0, "Zotero 10 applySelectionRangeIsolation REQUIRES numeric char.offset!");
  assert.equal(pd0.chars[1].offset, 1, "Zotero 10 applySelectionRangeIsolation REQUIRES sequential char.offset!");
  // Simulate exact Zotero 10 reader.js applySelectionRangeIsolation offset calculation
  {
    const range = { pageIndex: pd0.chars[0].pageIndex, anchorOffset: pd0.chars[0].offset, headOffset: pd0.chars[0].offset };
    for (const ch of pd0.chars) range.headOffset = ch.offset + 1;
    const from = Math.min(range.anchorOffset, range.headOffset);
    const to = Math.max(range.anchorOffset, range.headOffset);
    assert.ok(Number.isInteger(from) && Number.isInteger(to), "Selection offsets must never be NaN!");
    assert.equal(pd0.chars.slice(from, to).length, 2, "Text selection slice must cover selected chars!");
  }
  assert.deepEqual(Array.from(pd0.chars[0].rect), [82, 740, 90, 752]);
  assert.equal(pd0.chars[0].spaceAfter, true);
  assert.equal(pd0.chars[1].wordBreakAfter, true);
  assert.equal(pd0.chars[1].lineBreakAfter, true);
  assert.equal(pd0.chars[1].paragraphBreakAfter, true);
  assert.equal(pd0.chars[1].ignorable, true);
  assert.equal(pd0.overlays.length, 1);
  assert.equal(pd0.overlays[0].url, "https://zotero.org");

  // Page 1 (pageNum=2): rotate=90 must safely fall back to PDF.js
  const pd1 = await docInst.getPageData({ pageIndex: 1 });
  assert.equal(fallbacks, 1);
  assert.equal(origGetPageDataCalls, 1);
  assert.equal(pd1.chars[0].c, "FALLBACK");

  winCtx.__zotTurboUnpatchText();
  accel.shutdown();
  console.log("  PASS: PDF fulltext NFC + CropBox coordinate math + rotated fallback + clean unpatch");
}

console.log("=== [Check 4] Module 2: Tab Hibernator policy & safety ===");
{
  const nowSec = 100000;
  const unloaded = [];
  const mockTabs = {
    selectedID: "t1",
    _tabs: [
      { id: "zotero-pane", type: "library", timeUnselected: 0 },
      { id: "t1", type: "reader", timeUnselected: nowSec }, // selected
      { id: "t2", type: "reader", timeUnselected: nowSec - 60 }, // recent (keep #2)
      { id: "t3", type: "reader", timeUnselected: nowSec - 120 }, // exceeds maxLoaded=2 -> unload
      { id: "t4", type: "reader", timeUnselected: nowSec - 900 }, // exceeds idle=10m -> unload
      { id: "t5", type: "reader", timeUnselected: nowSec - 900, audioStatus: { active: true, paused: false } }, // audio playing -> NEVER unload!
    ],
    canUnload(id) {
      const t = this._tabs.find((x) => x.id === id);
      return t && t.id !== this.selectedID && t.type === "reader" && !(t.audioStatus?.active && !t.audioStatus?.paused);
    },
    unload(id) {
      const t = this._tabs.find((x) => x.id === id);
      if (t) {
        t.type = `${t.type}-unloaded`;
        unloaded.push(id);
      }
    },
    unloadUnusedTabs() {},
  };
  const origFn = mockTabs.unloadUnusedTabs;
  const mockWin = {
    closed: false,
    Zotero_Tabs: mockTabs,
    document: {
      head: { appendChild() {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElementNS: () => ({ remove() {} }),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const ctx = vm.createContext({
    Zotero: {
      getMainWindows: () => [mockWin],
      Date: { getUnixTimestamp: () => nowSec },
      Notifier: { registerObserver: () => 2, unregisterObserver: () => {} },
      debug() {},
    },
    Services: { obs: { addObserver() {}, removeObserver() {} } },
    Components: { classes: {}, interfaces: {} },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {} }) },
  });
  loadScriptInContext("src/tab-hibernator.js", ctx);
  const hib = new ctx.ZotTurboTabHibernator.TabHibernator({
    getPref: (k, def) => (k === "tabHibernateMaxLoaded" ? 2 : k === "tabHibernateIdleMin" ? 10 : def),
    nativeClient: { trim: async () => {} },
  });
  hib.init();
  mockTabs.unloadUnusedTabs();
  assert.deepEqual(unloaded.sort(), ["t3", "t4"], "Expected t3 & t4 unloaded while keeping t1, t2, and audio-playing t5");
  hib.shutdown();
  assert.equal(mockTabs.unloadUnusedTabs, origFn, "Original unloadUnusedTabs must be restored on shutdown");
  console.log("  PASS: Tab Hibernator maxLoaded + idle timeout + audio protection + clean restore");
}

console.log("=== [Check 5] Module 3: Native Parallel Scanner & Search Cache invalidation ===");
{
  let origScanCalls = 0;
  let origSearchCalls = 0;
  let notifierCb = null;
  function MockSearch() {
    this.libraryID = 1;
    this._conditions = { 0: { condition: "title", operator: "contains", value: "quantum" } };
  }
  MockSearch.prototype.search = async function () {
    origSearchCalls++;
    return [10, 20, 30];
  };

  const ctx = vm.createContext({
    Zotero: {
      FullText: {
        isCachedMIMEType: (m) => m === "application/pdf",
        getItemCacheFile: (it) => ({ path: `C:\\cache\\${it.id}.zotero-ft-cache` }),
        async findTextInItems() {
          origScanCalls++;
          return [{ id: 999 }];
        },
      },
      Items: {
        async getAsync(ids) {
          return ids.map((id) => ({ id, isAttachment: () => true, attachmentContentType: "application/pdf" }));
        },
      },
      Prefs: { get: () => 500000 },
      MIME: { isTextType: () => false },
      Search: MockSearch,
      Notifier: {
        registerObserver: (obj) => {
          notifierCb = obj;
          return 3;
        },
        unregisterObserver: () => {},
      },
      debug() {},
    },
    OS: {},
  });
  loadScriptInContext("src/search-accel.js", ctx);
  const sc = new ctx.ZotTurboSearchAccel.SearchAccelerator({
    nativeClient: {
      async scanFiles(paths) {
        assert.equal(paths.length, 3);
        return { ok: true, indicesJson: "[0,2]", scanned: 3, ms: 1.1 };
      },
    },
    getPref: (_k, def) => def,
  });
  sc.init();

  const found = await ctx.Zotero.FullText.findTextInItems([1, 2, 3], "quantum", "phrase");
  assert.deepEqual(JSON.parse(JSON.stringify(found)), [{ id: 1 }, { id: 3 }]);
  assert.equal(origScanCalls, 0);

  // Regex must fall back safely
  const rxFound = await ctx.Zotero.FullText.findTextInItems([1, 2], "q.*m", "regexp");
  assert.equal(origScanCalls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(rxFound)), [{ id: 999 }]);

  // Search cache hit + automatic notifier invalidation
  const s1 = new MockSearch();
  assert.deepEqual(Array.from(await s1.search()), [10, 20, 30]);
  assert.deepEqual(Array.from(await s1.search()), [10, 20, 30]);
  assert.equal(origSearchCalls, 1, "Second identical search must hit cache");
  notifierCb.notify("modify", "item", [10]);
  assert.deepEqual(Array.from(await s1.search()), [10, 20, 30]);
  assert.equal(origSearchCalls, 2, "Notifier event must invalidate search cache");
  sc.shutdown();
  console.log("  PASS: Native parallel scanner + regex fallback + Notifier-invalidated search cache");
}

console.log("=== [Check 6] Module 4: Cite CSL-JSON deep-clone cache & invalidation ===");
{
  let origRetrieve = 0;
  let notifierCb = null;
  function MockItem(id, mod) {
    this.id = id;
    this.dateModified = mod;
    this.version = 1;
  }
  function MockCiteSys() {}
  MockCiteSys.prototype.retrieveItem = function (it) {
    origRetrieve++;
    return { id: it.id, title: "Paper " + it.id, author: [{ family: "Doe" }] };
  };
  const ctx = vm.createContext({
    structuredClone,
    Zotero: {
      Item: MockItem,
      Items: { get: (id) => new MockItem(id, "2026-01-01") },
      Prefs: { get: () => false, set: () => {} },
      Cite: { System: MockCiteSys, getAbbreviation: () => {} },
      Style: { prototype: { getCiteProc: () => ({}) } },
      Notifier: {
        registerObserver: (obj) => {
          notifierCb = obj;
          return 4;
        },
        unregisterObserver: () => {},
      },
      debug() {},
    },
  });
  loadScriptInContext("src/cite-accel.js", ctx);
  const ca = new ctx.ZotTurboCiteAccel.CiteAccelerator({ getPref: (_k, def) => def });
  ca.init();

  const sys = new MockCiteSys();
  const itemA = new MockItem(7, "2026-01-01");
  const c1 = sys.retrieveItem(itemA);
  c1.author[0].family = "MUTATED";
  const c2 = sys.retrieveItem(itemA);
  assert.equal(origRetrieve, 1, "Second retrieveItem must hit cache");
  assert.equal(c2.author[0].family, "Doe", "Cache must be immune to citeproc-js mutation!");

  // Notifier invalidation
  notifierCb.notify("modify", "item", [7]);
  sys.retrieveItem(itemA);
  assert.equal(origRetrieve, 2, "Notifier modify must invalidate item CSL cache");
  ca.shutdown();
  console.log("  PASS: Cite CSL cache mutation isolation + Notifier invalidation");
}

console.log("=== [Check 7] Module 5: SQLite PRAGMA tuning & Auto-WebP note compression ===");
{
  const executedPragmas = [];
  let savedBlobType = null;
  let savedBlobSize = 0;

  const ctx = vm.createContext({
    Zotero: {
      DB: {
        async queryAsync(sql) {
          executedPragmas.push(sql);
        },
        async valueQueryAsync(sql) {
          if (sql.includes("cache_size")) return -65536;
          if (sql.includes("mmap_size")) return 268435456;
          if (sql.includes("temp_store")) return 2;
          if (sql.includes("journal_mode")) return "wal";
          if (sql.includes("page_size")) return 4096;
          return 0;
        },
      },
      Attachments: {
        async importEmbeddedImage({ blob }) {
          savedBlobType = blob.type;
          savedBlobSize = blob.size;
          return { key: "IMG1" };
        },
      },
      getMainWindow: () => ({
        createImageBitmap: async () => ({ width: 2000, height: 1000, close() {} }),
        OffscreenCanvas: class {
          constructor(w, h) { this.w = w; this.h = h; }
          getContext() { return { drawImage() {} }; }
          async convertToBlob({ type }) {
            return { type, size: 18000 }; // 18KB WebP from 200KB PNG
          }
        },
      }),
      debug() {},
    },
    ChromeUtils: { importESModule: () => ({ setTimeout: () => 1, clearTimeout: () => {} }) },
  });
  loadScriptInContext("src/system-accel.js", ctx);
  const sy = new ctx.ZotTurboSystemAccel.SystemAccelerator({ getPref: (_k, def) => def });
  await sy.init();

  assert.ok(executedPragmas.some((s) => s.includes("cache_size = -65536")), "Expected 64MB cache_size");
  assert.ok(executedPragmas.some((s) => s.includes("temp_store = MEMORY")), "Expected temp_store=MEMORY");
  assert.ok(executedPragmas.some((s) => s.includes("mmap_size = 268435456")), "Expected 256MB mmap_size");

  // Large PNG -> compressed WebP
  await ctx.Zotero.Attachments.importEmbeddedImage({ blob: { type: "image/png", size: 200000 }, parentItemID: 1 });
  assert.equal(savedBlobType, "image/webp");
  assert.equal(savedBlobSize, 18000);

  // Small PNG (< 64KB) -> untouched
  await ctx.Zotero.Attachments.importEmbeddedImage({ blob: { type: "image/png", size: 20000 }, parentItemID: 1 });
  assert.equal(savedBlobType, "image/png");
  assert.equal(savedBlobSize, 20000);

  await sy.shutdown();
  console.log("  PASS: SQLite PRAGMA tuning + PNG->WebP size-threshold compression");
}

console.log("=== [Check 8] Merged MuPDF Render Engine integration & shared binary path ===");
{
  const engineSrc = fs.readFileSync(path.join(PLUGIN_DIR, "src/engine-client.js"), "utf8");
  assert.ok(engineSrc.includes('PREF_PREFIX = "extensions.zotero-turbo.mupdf."'), "Render pref prefix must be namespaced under zotero-turbo");
  assert.ok(engineSrc.includes('WORKER_URI = "chrome://zoturbo/content/render-worker.js"'), "Render worker URI must use zoturbo chrome namespace");
  assert.ok(!engineSrc.includes("zotero-mupdf-native"), "Render engine must reference unified zotero-turbo-native binary");

  let sharedPathUsed = false;
  const ctx = vm.createContext({
    Zotero: { Prefs: { get: () => undefined, set: () => {} }, Profile: { dir: "C:\\prof" }, debug() {} },
    Services: { appinfo: { OS: "WINNT", XPCOMABI: "x86_64-msvc" }, obs: { addObserver() {}, removeObserver() {} } },
    Components: { classes: {}, interfaces: {}, isSuccessCode: () => true },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }), now: () => Date.now() },
    IOUtils: {},
    PathUtils: { join: (...a) => a.join("\\") },
  });
  loadScriptInContext("src/engine-client.js", ctx);
  const ec = new ctx.ZotMuPDFEngineClient.EngineClient({
    rootURI: "file:///mock/",
    version: "0.2.0",
    getBinaryPath: async () => {
      sharedPathUsed = true;
      return "C:\\prof\\zotero-turbo-bin\\v0.2.0\\zotero-turbo-native-win-x64.dll";
    },
  });
  const resolved = await ec._ensureDLLExtracted();
  assert.equal(sharedPathUsed, true, "EngineClient must reuse NativeClient's shared unified DLL path");
  assert.ok(resolved.endsWith("zotero-turbo-native-win-x64.dll"));
  assert.equal(ec._getNativeBinarySpec().candidates[0], "zotero-turbo-native-win-x64.dll");
  // Verify real EngineClient.getSummary() returns expected fields used by bootstrap.js & preferences.js
  const realSummary = ec.getSummary();
  assert.equal(typeof realSummary.enabled, "boolean");
  assert.equal(typeof realSummary.totalRenders, "number");
  assert.equal(typeof realSummary.thumbCount, "number");
  assert.equal(typeof realSummary.avgRenderMs, "number");
  assert.equal(typeof realSummary.fgWorkers, "number");
  // Verify bootstrap.js never calls nonexistent getStatsSummary() and shuts down in LIFO order
  const bootSrc = fs.readFileSync(path.join(PLUGIN_DIR, "bootstrap.js"), "utf8");
  assert.ok(!bootSrc.includes("getStatsSummary"), "bootstrap.js must call getSummary(), not getStatsSummary()");
  assert.ok(
    bootSrc.indexOf("p.pdfTextAccel?.shutdown()") < bootSrc.indexOf("p.renderHook?.shutdown()"),
    "bootstrap.js must shut down pdfTextAccel before renderHook (LIFO unwrap of Zotero.Reader.open)"
  );
  // Verify benchmark.js calls renderPage(reqKey, payload) with 2 args and uses IOUtils.exists
  const benchSrc = fs.readFileSync(path.join(PLUGIN_DIR, "src/benchmark.js"), "utf8");
  assert.ok(benchSrc.includes('renderPage("bench-cold", {'), "benchmark.js must pass reqKey + payload to renderPage");
  assert.ok(benchSrc.includes("IOUtils.exists"), "benchmark.js must use IOUtils.exists for Zotero 10 compatibility");
  console.log("  PASS: Unified single-DLL path sharing + real getSummary() + renderPage(reqKey, payload)");
}

console.log("=== [Check 9] Zotero 10 Cu.Sandbox PrefPane lifecycle & button click dispatch ===");
{
  let benchClicked = false;
  let hibernateClicked = false;
  let auditClicked = false;
  let revealClicked = false;
  let vacuumClicked = false;
  let scanNoteClicked = false;
  let compressNoteClicked = false;
  const savedMuPDFPrefs = {};
  let refreshViewerCount = 0;
  const elements = new Map();
  function makeEl(id) {
    const listeners = {};
    const node = {
      id,
      checked: false,
      value: "",
      disabled: false,
      textContent: "",
      className: "",
      style: {},
      children: [],
      get firstChild() { return this.children[0] || null; },
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) {
        const idx = this.children.indexOf(c);
        if (idx >= 0) this.children.splice(idx, 1);
      },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      async trigger(type) {
        for (const fn of listeners[type] || []) {
          await fn({ target: this });
        }
      },
    };
    elements.set(id, node);
    return node;
  }

  // Step 1: Before DOM insert (exactly how Zotero 10 _loadPane runs pane.scripts in Cu.Sandbox!)
  let domMounted = false;
  const mockWin = {
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => fn(),
    addEventListener: () => {},
  };
  const mockDoc = {
    getElementById: (id) => (domMounted ? elements.get(id) || null : null),
    createElementNS: (_ns, tag) => makeEl(`__dyn_${tag}_${Math.random()}`),
  };
  const mockZotero = {
    logError: (e) => { throw e; },
    ZotTurbo: {
      getPref: () => true,
      setPref: () => {},
      getMuPDFPref: (k) => (k === "aaLevel" ? 8 : k === "maxOutputScale" ? "" : true),
      setMuPDFPref: (k, v) => { savedMuPDFPrefs[k] = v; },
      renderHook: { refreshAllViewers: () => { refreshViewerCount++; } },
      getSummary: () => ({
        version: "0.7.2",
        standaloneMuPDFDetected: false,
        nativeAvailable: true,
        platformKey: "win-x64",
        render: { enabled: true, ready: true, mupdfVersion: "1.28.0", totalRenders: 5, thumbCount: 2, avgRenderMs: 4.5, pixHits: 3, dlHits: 1, fgWorkers: 2, workers: 3 },
        pdfText: { fulltextNativeCount: 1, batchPrefetchHits: 2, recognizerNativeCount: 2, avgFulltextMs: 12, readerPageHits: 4, ctrlfPages: 3, avgReaderPageMs: 2.1, outlineHits: 3, pdfjsCleanups: 2 },
        tabs: { activeReaders: 1, hibernatedTabs: 2, totalHibernated: 3 },
        search: { nativeFilesScanned: 50, avgNativeScanMs: 4.2, cacheHitRate: 80 },
        cite: { cslCacheSize: 20, cslHitRate: 90, citeprocRsActive: false },
        system: { memory: { ok: true, residentMB: 620, heapMB: 180 }, sqliteInfo: { cacheMB: 64, mmapMB: 256, tempStore: "MEMORY", mainSizeMB: 21.7, mainWastePct: 2.1, walMB: 0.4 }, webpCompressedCount: 1, webpSavedMB: 0.4, webpSavedRatio: 75 },
      }),
      tabHibernator: {
        hibernateAllBackground: () => {
          hibernateClicked = true;
          return 2;
        },
      },
      async runBenchmark(onProg) {
        benchClicked = true;
        onProg("running");
        return {
          timestamp: Date.now(),
          platform: "win-x64",
          results: [{ name: "Test", baselineMs: 100, turboMs: 5, speedup: 20, detail: "ok" }],
        };
      },
      async runHealthAudit() {
        auditClicked = true;
        return {
          timestamp: Date.now(),
          dataDir: "C:\\Zotero",
          hints: ["数据目录与扩展状态整体健康"],
          largeDataFiles: [{ name: "zotero.sqlite", sizeMB: 21.7, category: "核心数据库", note: "" }],
          addons: [{ id: "bbt@example", name: "Better BibTeX", version: "7.0", active: true, sizeKB: 2048 }],
        };
      },
      revealDataDir() {
        revealClicked = true;
        return true;
      },
      async runVacuum() {
        vacuumClicked = true;
        return { ok: true, performed: true, ms: 42, beforeMB: 50, afterMB: 35, freedMB: 15 };
      },
      async scanLegacyNoteImages() {
        scanNoteClicked = true;
        return { count: 3, totalMB: 4.5, minKB: 64, candidates: [] };
      },
      async compressLegacyNoteImages() {
        compressNoteClicked = true;
        return { ok: true, total: 3, converted: 3, skipped: 0, failed: 0, savedMB: 3.6 };
      },
    },
  };

  // Sandbox global is separate from mockWin (just like Cu.Sandbox(window)!)
  const sandboxCtx = vm.createContext({
    window: mockWin,
    document: mockDoc,
    Zotero: mockZotero,
  });
  loadScriptInContext("content/preferences.js", sandboxCtx);

  // Must be exposed on window so XUL onload="window.ZotTurboPrefs && window.ZotTurboPrefs.init()" works!
  assert.equal(typeof mockWin.ZotTurboPrefs?.init, "function", "window.ZotTurboPrefs.init must be exported onto window!");

  // Step 2: Mount DOM fragment and fire onload on window
  for (const id of [
    "zot-turbo-prefpane",
    "zt-badge-status",
    "zt-conflict-banner",
    "zt-stat-render",
    "zt-stat-memory",
    "zt-stat-pdf",
    "zt-stat-tabs",
    "zt-stat-search",
    "zt-stat-cite",
    "zt-stat-sqlite",
    "zt-stat-webp",
    "zt-btn-benchmark",
    "zt-bench-status",
    "zt-bench-results",
    "zt-btn-health-audit",
    "zt-btn-vacuum-db",
    "zt-btn-reveal-datadir",
    "zt-audit-status",
    "zt-audit-results",
    "zt-btn-scan-note-png",
    "zt-btn-compress-note-png",
    "zt-note-webp-status",
    "zt-btn-hibernate-now",
    "zt-save-toast",
    "zt-mupdf-aaLevel",
    "zt-mupdf-maxOutputScale",
  ]) {
    makeEl(id);
  }
  elements.get("zt-btn-compress-note-png").disabled = true;
  domMounted = true;
  mockWin.ZotTurboPrefs.init();

  assert.ok(elements.get("zt-badge-status").textContent.includes("0.7.2"), "Telemetry badge must populate v0.7.2 on init");
  assert.ok(elements.get("zt-stat-pdf").textContent.includes("Ctrl+F 3页"), "PDF telemetry must display Ctrl+F page count");
  assert.ok(elements.get("zt-stat-pdf").textContent.includes("预取 2"), "PDF telemetry must display batch prefetch hits");
  assert.ok(elements.get("zt-stat-memory").textContent.includes("620 MB"), "Memory telemetry must render RSS MB");
  assert.ok(elements.get("zt-stat-render").textContent.includes("累计渲染 7 帧"), "Render telemetry must read totalRenders + thumbCount");
  assert.equal(elements.get("zt-mupdf-aaLevel").value, "8");
  assert.equal(elements.get("zt-mupdf-maxOutputScale").value, "native");

  // Simulate XUL <menulist> dropdown selection ("command" event)
  elements.get("zt-mupdf-aaLevel").value = "4";
  await elements.get("zt-mupdf-aaLevel").trigger("command");
  assert.equal(savedMuPDFPrefs.aaLevel, 4, "XUL menulist command must persist aaLevel");

  elements.get("zt-mupdf-maxOutputScale").value = "1.5";
  await elements.get("zt-mupdf-maxOutputScale").trigger("command");
  assert.equal(savedMuPDFPrefs.maxOutputScale, "1.5", "XUL menulist command must persist maxOutputScale");

  elements.get("zt-mupdf-maxOutputScale").value = "native";
  await elements.get("zt-mupdf-maxOutputScale").trigger("command");
  assert.equal(savedMuPDFPrefs.maxOutputScale, "", "XUL menulist 'native' must map back to empty string");
  assert.ok(refreshViewerCount >= 3, "Changing render menulist options must refresh viewers");

  await elements.get("zt-btn-benchmark").trigger("click");
  assert.equal(benchClicked, true, "Benchmark button click must trigger runBenchmark()");
  assert.ok(elements.get("zt-bench-results").children.length > 0, "Benchmark table must render into #zt-bench-results");

  await elements.get("zt-btn-hibernate-now").trigger("click");
  assert.equal(hibernateClicked, true, "Hibernate button click must trigger hibernateAllBackground()");

  await elements.get("zt-btn-health-audit").trigger("click");
  assert.equal(auditClicked, true, "Health audit button must trigger runHealthAudit()");
  assert.ok(elements.get("zt-audit-results").children.length >= 2, "Health audit results must render into #zt-audit-results");

  await elements.get("zt-btn-reveal-datadir").trigger("click");
  assert.equal(revealClicked, true, "Reveal data dir button must trigger revealDataDir()");

  await elements.get("zt-btn-vacuum-db").trigger("click");
  assert.equal(vacuumClicked, true, "VACUUM button must trigger runVacuum()");

  await elements.get("zt-btn-scan-note-png").trigger("click");
  assert.equal(scanNoteClicked, true, "Scan note PNG button must trigger scanLegacyNoteImages()");
  assert.equal(elements.get("zt-btn-compress-note-png").disabled, false, "Compress button must unlock when scan finds images");

  await elements.get("zt-btn-compress-note-png").trigger("click");
  assert.equal(compressNoteClicked, true, "Compress note PNG button must trigger compressLegacyNoteImages()");
  console.log("  PASS: Cu.Sandbox(window) PrefPane init + Benchmark, Hibernate, Audit, VACUUM & PNG-WebP clicks verified");
}

console.log("=== [Check 10] Hot-upgrade & interleaved 3rd-party plugin monkey-patch resilience ===");
{
  let realOpenCalls = 0;
  let thirdPartyCalls = 0;
  const mockZotero = {
    Reader: {
      _readers: [],
      async open(itemID) {
        realOpenCalls++;
        return { itemID, type: "pdf" };
      },
      async openPreview(itemID) {
        return { itemID, type: "pdf" };
      },
      registerEventListener() {},
    },
    PDFWorker: {
      async getFullText(id) {
        return { text: "ok:" + id, extractedPages: 1, totalPages: 1 };
      },
    },
    Items: { getAsync: async () => null },
    File: { getResourceAsync: async () => "" },
    Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
    debug() {},
  };
  const ctx = vm.createContext({
    Zotero: mockZotero,
    Services: {},
    Components: { utils: { cloneInto: (x) => x, isDeadWrapper: () => false } },
    ChromeUtils: { importESModule: () => ({ setTimeout: () => 1, clearTimeout: () => {} }), now: () => Date.now() },
  });
  loadScriptInContext("src/reader-hook.js", ctx);
  loadScriptInContext("src/pdf-text-accel.js", ctx);

  const mockEng = { onStatsChange: () => () => {}, isEnabled: () => true, getSummary: () => ({}) };
  const rh = new ctx.ZotMuPDFReaderHook.ReaderHook({ pluginID: "t", rootURI: "file:///", engineClient: mockEng });
  const pta = new ctx.ZotTurboPDFTextAccel.PDFTextAccelerator({
    rootURI: "file:///",
    nativeClient: { evictPath: async () => {} },
    getPref: (_k, d) => d,
  });

  await rh.init();
  await pta.init();

  // Simulate a 3rd-party plugin wrapping Zotero.Reader.open ON TOP of us!
  const prevOpen = mockZotero.Reader.open;
  mockZotero.Reader.open = async function thirdPartyWrap(...args) {
    thirdPartyCalls++;
    return prevOpen.apply(this, args);
  };

  // Even if we shut down OUT OF ORDER (rh first, then pta) while 3rd-party wrapper is still active,
  // calling Zotero.Reader.open MUST NEVER throw TypeError: _origReaderOpen is null!
  rh.shutdown();
  pta.shutdown();

  const opened = await mockZotero.Reader.open(42);
  assert.equal(opened.itemID, 42);
  assert.equal(realOpenCalls, 1, "Real Zotero.Reader.open must still execute cleanly!");
  assert.equal(thirdPartyCalls, 1, "3rd-party plugin wrapper must stay intact!");
  console.log("  PASS: Out-of-order shutdown & 3rd-party interleaved wrap leave Zotero.Reader.open 100% crash-proof");
}

console.log("=== [Check 11] v0.4.0 features: Outline, Deferred getProcessedData + Cleanup, Recognizer, Memory & WAL ===");
{
  let origOutlineCalls = 0;
  let origProcessedCalls = 0;
  let cleanupCalls = 0;
  let origRecCalls = 0;
  let outlineMode = "present";

  function MockDoc(numPages) {
    this.numPages = numPages;
  }
  MockDoc.prototype.getPage = async () => ({ view: [0, 0, 612, 792], rotate: 0 });
  MockDoc.prototype.getPageData = async () => ({ partial: true, chars: [], overlays: [], viewBox: [0, 0, 612, 792] });
  MockDoc.prototype.getOutline2 = async () => {
    origOutlineCalls++;
    return [{ title: "Heuristic Heading", items: [] }];
  };
  MockDoc.prototype.getProcessedData = async () => {
    origProcessedCalls++;
    return { pages: { 0: { overlays: [{ type: "citation" }], chars: [{ c: "X", isolated: true }] } } };
  };
  let lastCleanupKeepFonts = null;
  MockDoc.prototype.cleanup = async (keepFonts) => {
    cleanupCalls++;
    lastCleanupKeepFonts = keepFonts;
  };

  const docSmall = new MockDoc(25);
  const winCtx = vm.createContext({
    Promise,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    PDFViewerApplication: { pdfDocument: docSmall },
    __zotTurboTextBridge: {
      isEnabled: () => true,
      isOutlineEnabled: () => true,
      isPdfjsCleanupEnabled: () => true,
      getProcessedDataDelayMs: () => 0,
      getProcessedDataMaxPages: () => 100,
      requestPageData: async () => ({ ok: false }),
      requestOutline: async () =>
        outlineMode === "present"
          ? { ok: true, ms: 0.2, json: JSON.stringify([{ title: "1 Intro", items: [], location: { position: { pageIndex: 0, rects: [[0, 720, 0, 720]] } } }]) }
          : { ok: false, noOutline: true },
      reportHit() {},
      reportFallback() {},
      reportOutlineHit() {},
      reportOutlineFallback() {},
      reportPdfjsCleanup() {},
    },
  });
  winCtx.window = winCtx;
  loadScriptInContext("src/reader-text-patch.js", winCtx);

  // Native outline hit (<0.5ms)
  const ol1 = await docSmall.getOutline2();
  assert.equal(ol1[0].title, "1 Intro");
  assert.equal(origOutlineCalls, 0);

  // No embedded outline -> falls back cleanly to Zotero heuristic extractor
  outlineMode = "none";
  const ol2 = await docSmall.getOutline2();
  assert.equal(ol2[0].title, "Heuristic Heading");
  assert.equal(origOutlineCalls, 1);

  // Normal 25-page paper (<= 100): citation popups 100% preserved, mismatched PDF.js isolated chars stripped, cleanup(true) triggered!
  const beforeClean = cleanupCalls;
  const procRes = await docSmall.getProcessedData();
  assert.equal(origProcessedCalls, 1, "Citation popup getProcessedData must run for <= maxPages");
  assert.equal(procRes.pages[0].overlays[0].type, "citation");
  assert.equal(procRes.pages[0].chars, undefined, "Mismatched PDF.js chars must be stripped when MuPDF getPageData is active");
  assert.ok(cleanupCalls > beforeClean, "pdfDocument.cleanup() must run after getProcessedData finishes");
  assert.equal(lastCleanupKeepFonts, true, "pdfDocument.cleanup(true) must keep loaded active-tab fonts");

  // Huge 150-page book (> 100): skips heavy JS scan immediately
  const docHuge = new MockDoc(150);
  const hugeRes = await docHuge.getProcessedData();
  assert.equal(origProcessedCalls, 1, "Huge book > maxPages must skip heavy JS scan");
  assert.deepEqual(Object.keys(hugeRes.pages), []);

  // Test native PDFWorker.getRecognizerData hook + password fallback
  const recCtx = vm.createContext({
    Zotero: {
      PDFWorker: {
        async getFullText() { return { text: "", extractedPages: 0, totalPages: 0 }; },
        async getRecognizerData(id, _p, pw) {
          origRecCalls++;
          return { metadata: { from: "orig:" + (pw || "") }, totalPages: 1, pages: [] };
        },
      },
      Items: {
        async getAsync(id) {
          return { id, isPDFAttachment: () => true, getFilePathAsync: async () => "C:\\p.pdf" };
        },
      },
      File: { getResourceAsync: async () => "" },
      Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
      Reader: { _readers: [] },
      debug() {},
    },
    Services: {},
    Components: { utils: { cloneInto: (x) => x, isDeadWrapper: () => false } },
    ChromeUtils: { importESModule: () => ({ setTimeout: () => 1, clearTimeout: () => {} }) },
  });
  loadScriptInContext("src/pdf-text-accel.js", recCtx);
  const pa = new recCtx.ZotTurboPDFTextAccel.PDFTextAccelerator({
    rootURI: "file:///",
    nativeClient: {
      extractRecognizerData: async () => ({
        ok: true,
        ms: 2.3,
        json: JSON.stringify({ metadata: { Title: "Fast Paper" }, totalPages: 12, pages: [[612, 792, [[[[0, 0, 0, 0, []]]]]]] }),
      }),
    },
    getPref: (_k, d) => d,
  });
  await pa.init();
  const rNative = await recCtx.Zotero.PDFWorker.getRecognizerData(99, false, null);
  assert.equal(rNative.metadata.Title, "Fast Paper");
  assert.equal(origRecCalls, 0);
  const rPw = await recCtx.Zotero.PDFWorker.getRecognizerData(99, false, "pw");
  assert.equal(rPw.metadata.from, "orig:pw");
  assert.equal(origRecCalls, 1);
  pa.shutdown();

  console.log("  PASS: Native outline + citation-safe deferred getProcessedData + Worker cleanup + native recognizer verified");
}

console.log("=== [Check 12] v0.5.0 features: Ctrl+F lookahead sweep, batch indexItems prefetch & read-only Health Audit ===");
{
  // 12A: Ctrl+F sequential sweep + lookahead + zero-getPage fast path + rotated visible page protection
  let getPageCalls = 0;
  let origPageDataCalls = 0;
  const requestedPages = [];
  const ctrlfHitFlags = [];

  function MockSweepDoc(numPages) {
    this.numPages = numPages;
  }
  MockSweepDoc.prototype.getPage = async function () {
    getPageCalls++;
    return { view: [0, 0, 612, 792], rotate: 0 };
  };
  MockSweepDoc.prototype.getPageData = async function () {
    origPageDataCalls++;
    return { partial: true, chars: [{ c: "F", u: "F" }], overlays: [], viewBox: [0, 0, 612, 792] };
  };

  const sweepDoc = new MockSweepDoc(10);
  const viewerPages = [];
  viewerPages[5] = { pdfPage: { view: [0, 0, 612, 792], rotate: 90 } }; // visible rotated page 5

  const winCtx = vm.createContext({
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    PDFViewerApplication: {
      pdfDocument: sweepDoc,
      pdfViewer: { _pages: viewerPages },
    },
    __zotTurboTextBridge: {
      isEnabled: () => true,
      isCtrlFAccelEnabled: () => true,
      requestPageData: async (idx) => {
        requestedPages.push(idx);
        return {
          ok: true,
          ms: 1.5,
          json: JSON.stringify({
            b: [0, 0, 612, 792],
            f: ["Helvetica"],
            c: [[65 + (idx % 26), 10, 10, 20, 22, 10, 10, 20, 22, 12, 0, 4, 0]],
            l: [],
          }),
        };
      },
      reportHit: (_ms, _chars, isCtrlF) => ctrlfHitFlags.push(!!isCtrlF),
      reportFallback: () => {},
    },
  });
  winCtx.window = winCtx;
  loadScriptInContext("src/reader-text-patch.js", winCtx);

  for (let p = 0; p < 5; p++) {
    const out = await sweepDoc.getPageData({ pageIndex: p });
    assert.equal(out.chars.length, 1);
  }
  assert.equal(getPageCalls, 2, "Ctrl+F sweep must skip this.getPage() once page 0 confirmed [0,0,W,H] (only pages 0 & 1)");
  assert.deepEqual(ctrlfHitFlags, [false, false, true, true, true], "Pages 2..4 must be detected as Ctrl+F sweep");
  assert.ok(requestedPages.includes(9), "Ctrl+F +6 lookahead must prefetch pages ahead of current page");

  // Page 5 has existingPdfPage with rotate:90 -> MUST fall back cleanly even during a Ctrl+F sweep!
  const p5 = await sweepDoc.getPageData({ pageIndex: 5 });
  assert.equal(origPageDataCalls, 1, "Visible rotated page must still safely fall back to PDF.js");
  assert.equal(p5.chars[0].c, "F");
  winCtx.__zotTurboUnpatchText();

  // 12B: Batch Zotero.Fulltext.indexItems parallel prefetch pipeline + clean unwrap
  const extractedIds = [];
  const origIndexItems = async function (ids) {
    for (const id of ids) {
      await batchCtx.Zotero.PDFWorker.getFullText(id, 100, false, null);
    }
    return ids.length;
  };
  const batchCtx = vm.createContext({
    Zotero: {
      Prefs: { get: (k) => (k === "fulltext.pdfMaxPages" ? 100 : 0) },
      Fulltext: { indexItems: origIndexItems },
      PDFWorker: {
        async getFullText(id) {
          return { text: "ORIG-" + id, extractedPages: 1, totalPages: 1 };
        },
      },
      Items: {
        async getAsync(idOrIds) {
          const mk = (id) => ({
            id,
            isAttachment: () => true,
            isPDFAttachment: () => true,
            attachmentContentType: "application/pdf",
            getFilePathAsync: async () => `C:\\papers\\doc_${id}.pdf`,
          });
          return Array.isArray(idOrIds) ? idOrIds.map(mk) : mk(idOrIds);
        },
      },
      File: { getResourceAsync: async () => "" },
      Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
      Reader: { _readers: [] },
      debug() {},
    },
    Services: {},
    Components: { utils: { cloneInto: (x) => x, isDeadWrapper: () => false } },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
  });
  loadScriptInContext("src/pdf-text-accel.js", batchCtx);
  const bAccel = new batchCtx.ZotTurboPDFTextAccel.PDFTextAccelerator({
    rootURI: "file:///",
    nativeClient: {
      async extractFulltext(p, maxPages) {
        extractedIds.push(p);
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, text: `Text(${p})`, extractedPages: maxPages || 10, totalPages: 10, ms: 3.1 };
      },
      async evictPath() {},
    },
    getPref: (_k, d) => d,
  });
  await bAccel.init();
  await batchCtx.Zotero.Fulltext.indexItems([1, 2, 3, 4], { complete: false });
  const bStats = bAccel.getStats();
  assert.equal(bStats.fulltextNativeCount, 4);
  assert.ok(bStats.batchPrefetchHits >= 2, `Expected >= 2 batch prefetch hits, got ${bStats.batchPrefetchHits}`);
  assert.equal(bAccel._batchPrefetch.size, 0, "Batch prefetch buffer must be completely drained on finish");
  bAccel.shutdown();
  assert.equal(batchCtx.Zotero.Fulltext.indexItems, origIndexItems, "indexItems must cleanly unwrap on shutdown");

  // 12C: Read-only Data Directory & Add-ons Health Audit + revealDataDir()
  let revealedTarget = "";
  const mockStatMap = {
    "C:\\Zotero\\zotero.sqlite": { type: "regular", size: 50 * 1024 * 1024 },
    "C:\\Zotero\\zotero.sqlite-wal": { type: "regular", size: 30 * 1024 * 1024 },
    "C:\\Zotero\\oldplugin.sqlite": { type: "regular", size: 25 * 1024 * 1024 },
    "C:\\Zotero\\better-bibtex.sqlite": { type: "regular", size: 15 * 1024 * 1024 },
    "C:\\Prof\\extensions\\better-bibtex@iris-advies.com.xpi": { type: "regular", size: 8 * 1024 * 1024 },
    "C:\\Prof\\extensions\\disabled@example.org.xpi": { type: "regular", size: 512 * 1024 },
  };
  const auditCtx = vm.createContext({
    IOUtils: {
      async getChildren(dir) {
        assert.equal(dir, "C:\\Zotero");
        return [
          "C:\\Zotero\\zotero.sqlite",
          "C:\\Zotero\\zotero.sqlite-wal",
          "C:\\Zotero\\oldplugin.sqlite",
          "C:\\Zotero\\better-bibtex.sqlite",
        ];
      },
      async stat(p) {
        if (!mockStatMap[p]) throw new Error("ENOENT");
        return mockStatMap[p];
      },
    },
    PathUtils: {
      profileDir: "C:\\Prof",
      join: (...parts) => parts.join("\\"),
      filename: (p) => p.split("\\").pop(),
    },
    Zotero: {
      DataDirectory: { dir: "C:\\Zotero" },
      Profile: { dir: "C:\\Prof" },
      File: {
        async reveal(p) {
          revealedTarget = p;
        },
      },
      DB: {
        async queryAsync() {},
        async valueQueryAsync(sql) {
          if (sql.includes("cache_size")) return -65536;
          if (sql.includes("mmap_size")) return 268435456;
          if (sql.includes("temp_store")) return 2;
          if (sql.includes("page_size")) return 4096;
          if (sql.includes("page_count")) return 12800;
          if (sql.includes("freelist_count")) return 256;
          return 0;
        },
      },
      debug() {},
    },
    ChromeUtils: {
      importESModule(uri) {
        if (uri.includes("AddonManager")) {
          return {
            AddonManager: {
              async getAddonsByTypes() {
                return [
                  { id: "better-bibtex@iris-advies.com", name: "Better BibTeX", version: "7.0", isActive: true, userDisabled: false },
                  { id: "disabled@example.org", name: "Disabled Addon", version: "1.0", isActive: false, userDisabled: true },
                ];
              },
            },
          };
        }
        return { setTimeout: () => 1, clearTimeout: () => {} };
      },
    },
  });
  loadScriptInContext("src/system-accel.js", auditCtx);
  const sysAudit = new auditCtx.ZotTurboSystemAccel.SystemAccelerator({ getPref: (_k, d) => d });
  const rep = await sysAudit.runHealthAudit();
  assert.equal(rep.largeDataFiles[0].name, "zotero.sqlite");
  const orphan = rep.largeDataFiles.find((f) => f.name === "oldplugin.sqlite");
  const activeDb = rep.largeDataFiles.find((f) => f.name === "better-bibtex.sqlite");
  assert.ok(orphan && orphan.note.includes("疑似已禁用"), "Orphan sqlite DB must be flagged");
  assert.ok(activeDb && activeDb.note.includes("活跃第三方插件"), "Active plugin DB must be recognized");
  assert.ok(rep.hints.some((h) => h.includes("疑似遗留插件数据库")), "Expected orphan DB hint");
  assert.ok(rep.hints.some((h) => h.includes("WAL")), "Expected WAL bloat hint");
  assert.ok(rep.hints.some((h) => h.includes("Better BibTeX")), "Expected heavy active addon hint");
  assert.equal(sysAudit.revealDataDir(), true);
  assert.equal(revealedTarget, "C:\\Zotero\\zotero.sqlite", "revealDataDir must open directly inside dataDir");

  console.log("  PASS: Ctrl+F lookahead + batch indexItems prefetch + read-only Health Audit verified");
}

console.log("=== [Check 13] v0.6.0 features: Native hasAnnotations, FTS5 merge, atomic VACUUM & Legacy PNG->WebP ===");
{
  // 13A: Native PDFWorker.hasAnnotations + password fallback + clean unwrap
  let origHasAnnotsCalls = 0;
  const origHasAnnots = async function (_id, _p, pw) {
    origHasAnnotsCalls++;
    return pw === "pw";
  };
  const haCtx = vm.createContext({
    Zotero: {
      PDFWorker: {
        async getFullText() { return { text: "", extractedPages: 0, totalPages: 0 }; },
        hasAnnotations: origHasAnnots,
      },
      Items: {
        async getAsync(id) {
          return { id, isPDFAttachment: () => true, getFilePathAsync: async () => `C:\\p_${id}.pdf` };
        },
      },
      File: { getResourceAsync: async () => "" },
      Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
      Reader: { _readers: [] },
      debug() {},
    },
    Services: {},
    Components: { utils: { cloneInto: (x) => x, isDeadWrapper: () => false } },
    ChromeUtils: { importESModule: () => ({ setTimeout: () => 1, clearTimeout: () => {} }) },
  });
  loadScriptInContext("src/pdf-text-accel.js", haCtx);
  const haAccel = new haCtx.ZotTurboPDFTextAccel.PDFTextAccelerator({
    rootURI: "file:///",
    nativeClient: {
      async hasAnnotations(p) {
        return { ok: true, hasAnnotations: p.includes("p_1"), ms: 0.3 };
      },
    },
    getPref: (_k, d) => d,
  });
  await haAccel.init();
  assert.equal(await haCtx.Zotero.PDFWorker.hasAnnotations(1, true, null), true);
  assert.equal(await haCtx.Zotero.PDFWorker.hasAnnotations(2, true, null), false);
  assert.equal(origHasAnnotsCalls, 0);
  assert.equal(await haCtx.Zotero.PDFWorker.hasAnnotations(2, true, "pw"), true);
  assert.equal(origHasAnnotsCalls, 1);
  haAccel.shutdown();
  assert.equal(haCtx.Zotero.PDFWorker.hasAnnotations, origHasAnnots, "hasAnnotations must restore cleanly on shutdown");

  // 13B: Search cache key sensitivity to recursiveCollections preference
  let recPref = false;
  let searchExecs = 0;
  function MockSearch2() {
    this.libraryID = 1;
    this._conditions = { 0: { condition: "title", operator: "contains", value: "laser" } };
  }
  MockSearch2.prototype.search = async function () {
    searchExecs++;
    return recPref ? [1, 2, 3] : [1];
  };
  const scCtx2 = vm.createContext({
    Zotero: {
      Prefs: { get: (k) => (k === "recursiveCollections" ? recPref : 500000) },
      Search: MockSearch2,
      Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
      debug() {},
    },
  });
  loadScriptInContext("src/search-accel.js", scCtx2);
  const sc2 = new scCtx2.ZotTurboSearchAccel.SearchAccelerator({ nativeClient: {}, getPref: (_k, d) => d });
  sc2.init();
  const s2 = new MockSearch2();
  assert.deepEqual(Array.from(await s2.search()), [1]);
  assert.deepEqual(Array.from(await s2.search()), [1]);
  assert.equal(searchExecs, 1);
  recPref = true;
  assert.deepEqual(Array.from(await s2.search()), [1, 2, 3], "Toggling recursiveCollections must bypass stale search cache");
  assert.equal(searchExecs, 2);
  sc2.shutdown();

  // 13C: FTS5 merge, atomic VACUUM & two-step legacy PNG->WebP migration with rollback safety
  const sqlLog = [];
  let vacuumForce = false;
  const virtualFs = new Map([
    ["C:\\Zotero\\storage\\AAA\\image.png", new Uint8Array(200000)],
    ["C:\\Zotero\\storage\\BBB\\image.png", new Uint8Array(180000)],
  ]);
  const mockItems = new Map([
    [
      10,
      {
        id: 10,
        deleted: false,
        library: { editable: true },
        isAttachment: () => true,
        attachmentContentType: "image/png",
        attachmentPath: "storage:image.png",
        getFilePathAsync: async () => "C:\\Zotero\\storage\\AAA\\image.png",
        saveTx: async () => {},
        _updateAttachmentStates: () => {},
      },
    ],
    [
      11,
      {
        id: 11,
        deleted: false,
        library: { editable: true },
        isAttachment: () => true,
        attachmentContentType: "image/png",
        attachmentPath: "storage:image.png",
        getFilePathAsync: async () => "C:\\Zotero\\storage\\BBB\\image.png",
        saveTx: async () => {
          throw new Error("Simulated DB save failure");
        },
      },
    ],
  ]);

  const sysCtx = vm.createContext({
    Uint8Array,
    IOUtils: {
      async stat(p) {
        if (!virtualFs.has(p)) throw new Error("ENOENT");
        return { type: "regular", size: virtualFs.get(p).byteLength };
      },
      async read(p) {
        if (!virtualFs.has(p)) throw new Error("ENOENT");
        return virtualFs.get(p);
      },
      async write(p, bytes) {
        virtualFs.set(p, bytes);
      },
      async move(src, dst) {
        virtualFs.set(dst, virtualFs.get(src));
        virtualFs.delete(src);
      },
      async remove(p) {
        virtualFs.delete(p);
      },
    },
    PathUtils: {
      parent: (p) => p.slice(0, p.lastIndexOf("\\")),
      join: (...parts) => parts.join("\\"),
    },
    Zotero: {
      Attachments: { LINK_MODE_EMBEDDED_IMAGE: 4 },
      Items: { getAsync: async (id) => mockItems.get(id) },
      DB: {
        async queryAsync(sql) {
          sqlLog.push(sql);
          if (sql.includes("FROM itemAttachments")) {
            return [
              { itemID: 10, contentType: "image/png" },
              { itemID: 11, contentType: "image/png" },
            ];
          }
          return [];
        },
        async valueQueryAsync(sql) {
          if (sql.includes("page_size")) return 4096;
          if (sql.includes("page_count")) return vacuumForce ? 8000 : 12000;
          if (sql.includes("freelist_count")) return 500;
          if (sql.includes("cache_size")) return -65536;
          return 0;
        },
        async vacuum(opts) {
          vacuumForce = !!opts?.force;
          return true;
        },
      },
      getMainWindow: () => ({
        Blob: class {
          constructor(parts, opts) {
            this.parts = parts;
            this.type = opts?.type || "";
            this.size = parts[0]?.byteLength || 0;
          }
          async arrayBuffer() {
            return this.parts[0].buffer;
          }
        },
        createImageBitmap: async () => ({ width: 1200, height: 800, close() {} }),
        OffscreenCanvas: class {
          getContext() { return { drawImage() {} }; }
          async convertToBlob({ type }) {
            const out = new Uint8Array(25000);
            return { type, size: out.byteLength, arrayBuffer: async () => out.buffer };
          }
        },
      }),
      debug() {},
    },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
  });
  loadScriptInContext("src/system-accel.js", sysCtx);
  const sys6 = new sysCtx.ZotTurboSystemAccel.SystemAccelerator({ getPref: (_k, d) => d });

  const optRes = await sys6.runIdleOptimize({ truncateWal: true, mergeFts5: true });
  assert.equal(optRes.ok, true);
  assert.equal(optRes.fts5Merged, 4, "Must run FTS5 merge on all 4 Zotero 10 FTS5 tables");
  assert.ok(sqlLog.some((s) => s.includes("ftindex.fulltextContent") && s.includes("'merge'")));

  const vacRes = await sys6.runVacuum();
  assert.equal(vacRes.ok, true);
  assert.equal(vacRes.performed, true);
  assert.equal(vacuumForce, true);
  assert.ok(vacRes.freedMB > 10, "VACUUM must report freed MB accurately");

  const scanRes = await sys6.scanLegacyNoteImages();
  assert.equal(scanRes.count, 2);

  const compRes = await sys6.compressLegacyNoteImages();
  assert.equal(compRes.ok, true);
  assert.equal(compRes.converted, 1, "Item 10 must convert cleanly to WebP");
  assert.equal(compRes.failed, 1, "Item 11 simulated saveTx error must be counted as failed");
  assert.equal(mockItems.get(10).attachmentPath, "storage:image.webp");
  assert.equal(mockItems.get(10).attachmentContentType, "image/webp");
  assert.equal(virtualFs.has("C:\\Zotero\\storage\\AAA\\image.webp"), true);
  assert.equal(virtualFs.has("C:\\Zotero\\storage\\AAA\\image.png"), false, "Old PNG removed only after saveTx succeeded");
  assert.equal(virtualFs.has("C:\\Zotero\\storage\\BBB\\image.png"), true, "Failed saveTx must preserve original PNG intact!");
  assert.equal(virtualFs.has("C:\\Zotero\\storage\\BBB\\image.webp"), false, "Failed saveTx must roll back new WebP file!");

  console.log("  PASS: Native hasAnnotations + recursiveCollections cache key + FTS5 merge + VACUUM + atomic PNG->WebP verified");
}

console.log("=== [Check 14] v0.7.0 features: Background auto-slim & Reader capsule right-click quick menu ===");
{
  // 14A: Background / minimized window auto-slim lifecycle
  let slimCalls = 0;
  let activeFocusWin = {}; // initially focused (dialog or main window active)
  const winListeners = {};
  const mockWin = {
    closed: false,
    STATE_MINIMIZED: 2,
    windowState: 1, // normal
    Zotero_Tabs: { _tabs: [], unload() {}, canUnload: () => false, unloadUnusedTabs() {} },
    document: {
      head: { appendChild() {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElementNS: () => ({ remove() {} }),
    },
    addEventListener(type, fn) {
      (winListeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
  };
  const hibCtx = vm.createContext({
    Zotero: {
      getMainWindows: () => [mockWin],
      Date: { getUnixTimestamp: () => 100000 },
      Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
      debug() {},
    },
    Services: {
      obs: { addObserver() {}, removeObserver() {} },
      focus: {
        get activeWindow() {
          return activeFocusWin;
        },
      },
    },
    Components: { classes: {}, interfaces: {} },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {} }) },
  });
  loadScriptInContext("src/tab-hibernator.js", hibCtx);
  const hib = new hibCtx.ZotTurboTabHibernator.TabHibernator({
    getPref: (k, def) => (k === "autoBackgroundSlimMin" ? 10 : def),
    onBackgroundSlim: async () => {
      slimCalls++;
    },
  });
  hib.init();

  const t0 = 1_000_000;
  // While another Zotero dialog holds focus -> NEVER slim
  assert.equal(hib._checkBackgroundAutoSlim(t0), false);
  assert.equal(hib._checkBackgroundAutoSlim(t0 + 20 * 60 * 1000), false);
  assert.equal(slimCalls, 0);

  // User switches to Word (activeWindow becomes null) -> starts timer at t0
  activeFocusWin = null;
  assert.equal(hib._checkBackgroundAutoSlim(t0), false);
  assert.equal(hib._checkBackgroundAutoSlim(t0 + 5 * 60 * 1000), false); // only 5m < 10m
  assert.equal(hib._checkBackgroundAutoSlim(t0 + 11 * 60 * 1000), true, "Must trigger auto-slim after 10m unfocused");
  assert.equal(slimCalls, 1);
  // Single-shot during same idle period (must not spam every 60s!)
  assert.equal(hib._checkBackgroundAutoSlim(t0 + 15 * 60 * 1000), false);
  assert.equal(slimCalls, 1);

  // User activates Zotero again -> resets idle latch; minimizing later can trigger once more
  activeFocusWin = mockWin;
  for (const fn of winListeners.activate || []) fn();
  mockWin.windowState = mockWin.STATE_MINIMIZED;
  assert.equal(hib._checkBackgroundAutoSlim(t0 + 20 * 60 * 1000), false);
  assert.equal(hib._checkBackgroundAutoSlim(t0 + 31 * 60 * 1000), true, "Must trigger again after re-minimize >= 10m");
  assert.equal(slimCalls, 2);
  hib.shutdown();

  // 14B: Reader toolbar capsule: Cu.unwaiveXrays, native XUL _openContextMenu, Shift+click cold-reset & HTML fallback
  let reclaimCalled = false;
  let hibCalled = false;
  let trimCalled = false;
  let prefsOpened = false;
  let evictCalled = 0;
  let unwaivedCount = 0;
  let nativeMenuArg = null;
  let engineEnabled = true;
  const bodyChildren = [];
  function makeNode(tag) {
    const ls = {};
    const node = {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      style: {},
      children: [],
      isConnected: true,
      appendChild(c) { this.children.push(c); return c; },
      append(...cs) { this.children.push(...cs); },
      remove() {
        const idx = bodyChildren.indexOf(this);
        if (idx >= 0) bodyChildren.splice(idx, 1);
      },
      contains: () => false,
      getBoundingClientRect: () => ({ left: 680, right: 790, bottom: 32 }),
      addEventListener(type, fn) { (ls[type] ||= []).push(fn); },
      removeEventListener() {},
      async fire(type, ev = {}) {
        for (const fn of ls[type] || []) {
          await fn({ preventDefault() {}, stopPropagation() {}, ...ev });
        }
      },
    };
    return node;
  }
  const mockDoc = {
    head: makeNode("head"),
    body: {
      appendChild(c) { bodyChildren.push(c); return c; },
    },
    defaultView: {
      closed: false,
      innerWidth: 800,
      innerHeight: 600,
      addEventListener() {},
      removeEventListener() {},
    },
    getElementById: () => null,
    querySelector: (sel) => (sel === ".zot-mupdf-ctxmenu" ? bodyChildren.find((n) => n.className === "zot-mupdf-ctxmenu") || null : null),
    createElement: (tag) => makeNode(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  let unregisteredToolbar = false;
  const rhCtx = vm.createContext({
    Zotero: {
      Reader: {
        _readers: [],
        registerEventListener() {},
        unregisterEventListener(type) {
          if (type === "renderToolbar") unregisteredToolbar = true;
        },
      },
      Notifier: { registerObserver: () => 1, unregisterObserver: () => {} },
      ZotTurbo: {
        systemAccel: { getMemorySnapshot: () => ({ ok: true, residentMB: 540 }) },
        tabHibernator: {
          getStats: () => ({ activeReaders: 2, hibernatedTabs: 1 }),
          hibernateAllBackground: () => { hibCalled = true; return 1; },
        },
        async deepReclaimMemory() { reclaimCalled = true; return { freedMB: 210 }; },
        async trimRenderCache() { trimCalled = true; },
        openPreferences() { prefsOpened = true; return true; },
      },
      File: { getResourceAsync: async () => "" },
      debug() {},
    },
    Services: {},
    Components: {
      utils: {
        cloneInto: (x) => x,
        exportFunction: (f) => f,
        unwaiveXrays: (x) => {
          unwaivedCount++;
          return x;
        },
      },
    },
    ChromeUtils: { importESModule: () => ({ setTimeout: () => 1, clearTimeout: () => {} }), now: () => Date.now() },
  });
  loadScriptInContext("src/reader-hook.js", rhCtx);
  const rh = new rhCtx.ZotMuPDFReaderHook.ReaderHook({
    pluginID: "zt",
    rootURI: "file:///",
    engineClient: {
      onStatsChange: () => () => {},
      isEnabled: () => engineEnabled,
      setEnabled: (v) => { engineEnabled = !!v; },
      evictCache: async () => { evictCalled++; },
      ensureStarted: async () => {},
      getSummary: () => ({ enabled: engineEnabled, ready: true, totalRenders: 3, lastE2EMs: 4.2, avgE2EMs: 4.2, pixHits: 1, fallbacks: 0 }),
    },
  });
  await rh.init();

  // Test primary Zotero 10 native XUL _openContextMenu path + Shift+click cold-toggle
  let capsuleBtn = null;
  rh._renderToolbarButton({
    reader: {
      async _openContextMenu(opts) {
        nativeMenuArg = opts;
      },
    },
    doc: mockDoc,
    append: (el) => { capsuleBtn = el; },
  });
  assert.ok(capsuleBtn, "Capsule button must render");
  assert.ok(unwaivedCount >= 1, "Must call Cu.unwaiveXrays on event.doc from renderToolbar!");

  // Verify right-click pointerdown stops propagation BEFORE reader.js:81605 calls preventDefault() (which kills contextmenu!)
  let pdStopped = false;
  let pdPrevented = false;
  await capsuleBtn.fire("pointerdown", {
    button: 2,
    stopPropagation() { pdStopped = true; },
    preventDefault() { pdPrevented = true; },
  });
  assert.equal(pdStopped, true, "Right-click pointerdown must stopPropagation to bypass reader.js preventDefault()");
  assert.equal(pdPrevented, false, "Right-click pointerdown must NOT call preventDefault() or Gecko suppresses contextmenu!");

  await capsuleBtn.fire("contextmenu", { clientX: 700, clientY: 28 });
  assert.ok(nativeMenuArg, "Right-clicking capsule must invoke reader._openContextMenu (native XUL popup)");
  assert.equal(nativeMenuArg.x, 700);
  assert.equal(nativeMenuArg.y, 28);
  assert.ok(nativeMenuArg.itemGroups[0][0].label.includes("540 MB"), "Header must show live RSS");
  assert.equal(nativeMenuArg.itemGroups[0][0].disabled, true);

  // Trigger all native XUL menu item commands
  await nativeMenuArg.itemGroups[1][0].onCommand();
  assert.equal(reclaimCalled, true, "Deep reclaim menu item must invoke deepReclaimMemory()");
  nativeMenuArg.itemGroups[1][1].onCommand();
  assert.equal(hibCalled, true, "Hibernate menu item must invoke hibernateAllBackground()");
  await nativeMenuArg.itemGroups[1][2].onCommand();
  assert.equal(trimCalled, true, "Trim menu item must invoke trimRenderCache()");
  nativeMenuArg.itemGroups[2][0].onCommand();
  assert.equal(prefsOpened, true, "Settings menu item must invoke openPreferences()");

  // Test Shift+click cold-toggle: must toggle engine, evict cache, and flash visual feedback even in PDF.js branch
  await capsuleBtn.fire("click", { shiftKey: true });
  assert.equal(engineEnabled, false, "Shift+click must toggle engine to PDF.js");
  assert.equal(evictCalled, 1, "Shift+click must call engine.evictCache() for true cold comparison");
  const metricSpan = capsuleBtn.children[1];
  assert.equal(metricSpan.textContent, "冷切JS", "Shift+click must visibly flash 冷切JS on capsule");

  // Also test HTML fallback when reader._openContextMenu is unavailable
  let fallbackBtn = null;
  rh._renderToolbarButton({
    reader: {},
    doc: mockDoc,
    append: (el) => { fallbackBtn = el; },
  });
  await fallbackBtn.fire("contextmenu");
  assert.equal(bodyChildren.length, 1, "HTML fallback menu must mount when _openContextMenu absent");

  rh.shutdown();
  assert.equal(unregisteredToolbar, true, "shutdown() must unregister renderToolbar listener");
  assert.equal(bodyChildren.length, 0, "shutdown() must dispose open HTML fallback menu");

  console.log("  PASS: Background auto-slim + Xray-safe native XUL capsule menu + Shift+click cold-reset verified");
}

console.log("=== [Check 15] v0.8.0 features: Main UI selection coalescing, ItemTree overscan & async OffscreenCanvas thumbs ===");
{
  const renderedIds = [];
  const jsWin = { overscanCount: 2 };
  const origItemSelected = async function (id) {
    renderedIds.push(id);
    return true;
  };
  const mockWin = {
    closed: false,
    Zotero_Tabs: { selectedType: "library" },
    ZoteroPane: {
      itemSelected: origItemSelected,
      itemsView: { tree: { _jsWindow: jsWin } },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const uiCtx = vm.createContext({
    Zotero: {
      getMainWindows: () => [mockWin],
      Notifier: { registerObserver: () => 42, unregisterObserver() {} },
    },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
  });
  loadScriptInContext("src/ui-accel.js", uiCtx);
  const uiAccel = new uiCtx.ZotTurboUIAccel.UIAccelerator({
    getPref: (k, d) => ({ itemSelectCoalesceEnabled: true, itemSelectDebounceMs: 40, itemTreeOverscan: 7 }[k] ?? d),
  });
  uiAccel.init();

  assert.equal(jsWin.overscanCount, 7, "UIAccelerator must raise ItemTree overscanCount to configured value");
  assert.notEqual(mockWin.ZoteroPane.itemSelected, origItemSelected, "ZoteroPane.itemSelected must be wrapped");

  // 1. First selection executes immediately (leading edge = 0ms lag!)
  const r1 = await mockWin.ZoteroPane.itemSelected("item-1");
  assert.equal(r1, true);
  assert.deepEqual(renderedIds, ["item-1"], "First single click must execute immediately");

  // 2. Rapid burst (4 consecutive arrow presses within debounce window) coalesces to ONLY the final item
  const p2 = mockWin.ZoteroPane.itemSelected("item-2");
  const p3 = mockWin.ZoteroPane.itemSelected("item-3");
  const p4 = mockWin.ZoteroPane.itemSelected("item-4");
  const p5 = mockWin.ZoteroPane.itemSelected("item-5");
  const results = await Promise.all([p2, p3, p4, p5]);
  assert.deepEqual(results, [false, false, false, true], "Superseded intermediate selections resolve false; final resolves true");
  assert.deepEqual(renderedIds, ["item-1", "item-5"], "Intermediate ItemPane rebuilds must be coalesced away");
  assert.equal(uiAccel.getStats().coalescedSelections, 3, "Stats must record 3 coalesced selections");

  // 3. Shutdown restores original ZoteroPane.itemSelected and overscanCount cleanly
  uiAccel.shutdown();
  assert.equal(mockWin.ZoteroPane.itemSelected, origItemSelected, "shutdown() must unwrap ZoteroPane.itemSelected");
  assert.equal(jsWin.overscanCount, 2, "shutdown() must restore original ItemTree overscanCount");

  // 4. Verify async OffscreenCanvas.convertToBlob thumbnail encoding + dirty-checked toolbar DOM in reader-hook.js
  let convertToBlobCalls = 0;
  let titleWrites = 0;
  const mockChromeWin = {
    ImageData: class {
      constructor(arr, w, h) { this.data = arr; this.width = w; this.height = h; }
    },
    OffscreenCanvas: class {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { putImageData() {} }; }
      async convertToBlob(opts) {
        convertToBlobCalls++;
        assert.equal(opts.type, "image/jpeg");
        return { size: 128, _fake: true };
      }
    },
    FileReader: class {
      readAsDataURL() {
        this.result = "data:image/jpeg;base64,ZmFrZQ==";
        setTimeout(() => this.onload?.(), 0);
      }
    },
  };
  const rhCtx2 = vm.createContext({
    Zotero: { Reader: { _readers: [] }, Notifier: { registerObserver: () => 1, unregisterObserver() {} }, File: { getResourceAsync: async () => "" }, debug() {} },
    Services: { wm: { getMostRecentWindow: () => mockChromeWin } },
    Components: { utils: { cloneInto: (x) => x, exportFunction: (f) => f, unwaiveXrays: (x) => x } },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }), now: () => Date.now() },
  });
  loadScriptInContext("src/reader-hook.js", rhCtx2);
  const rh2 = new rhCtx2.ZotMuPDFReaderHook.ReaderHook({
    pluginID: "zt",
    rootURI: "file:///",
    engineClient: { onStatsChange: () => () => {}, isEnabled: () => true, getSummary: () => ({ enabled: true, ready: true, totalRenders: 1, lastE2EMs: 3.1, avgE2EMs: 3.1, pixHits: 1, fallbacks: 0 }) },
  });
  const dataUrl = await rh2._encodeThumbJpegAsync(new ArrayBuffer(16), 2, 2);
  assert.equal(convertToBlobCalls, 1, "Thumbnail encoding must prefer async OffscreenCanvas.convertToBlob()");
  assert.equal(dataUrl, "data:image/jpeg;base64,ZmFrZQ==");

  const fakeBtn = {
    isConnected: true,
    _t: "",
    set title(v) { titleWrites++; this._t = v; },
    get title() { return this._t; },
  };
  const fakeRec = {
    doc: { defaultView: { closed: false } },
    btn: fakeBtn,
    nameEl: { textContent: "" },
    dot: { style: { backgroundColor: "" } },
    metricEl: { textContent: "" },
  };
  const sameSummary = { enabled: true, ready: true, totalRenders: 1, lastE2EMs: 3.1, avgE2EMs: 3.1, pixHits: 1, fallbacks: 0 };
  rh2._applyButtonState(fakeRec, sameSummary);
  rh2._applyButtonState(fakeRec, sameSummary);
  rh2._applyButtonState(fakeRec, sameSummary);
  assert.equal(titleWrites, 1, "Dirty-checked _applyButtonState must not rewrite unchanged DOM properties");

  console.log("  PASS: Main UI selection coalescing + ItemTree overscan + async OffscreenCanvas thumbs + dirty-checked capsule verified");
}

console.log("=== [Check 16] v0.9.0: Reader Text ASCII/Diacritic Fast-Path & Elastic Native Worker Pool ===");
{
  // 1. Verify reader-text-patch.js hoists SPECIALS/ASCII_CHARS and preserves diacritic + ligature normalization
  const rtpSrc = fs.readFileSync(path.join(PLUGIN_DIR, "src/reader-text-patch.js"), "utf8");
  assert.ok(rtpSrc.includes("const ASCII_CHARS ="), "reader-text-patch.js must precompute ASCII_CHARS table");
  assert.ok(rtpSrc.includes("const SPECIALS = Object.assign(Object.create(null)"), "reader-text-patch.js must hoist SPECIALS out of normalizeChar");
  function MockDoc2() {}
  MockDoc2.prototype.getPage = async () => ({ view: [0, 0, 612, 792], rotate: 0 });
  MockDoc2.prototype.getPageData = async () => ({ partial: true, chars: [], overlays: [], viewBox: [0, 0, 612, 792] });
  const doc2 = new MockDoc2();
  const winCtx2 = vm.createContext({
    Promise,
    setTimeout,
    clearTimeout,
    PDFViewerApplication: { pdfDocument: doc2 },
    __zotTurboTextBridge: {
      isEnabled: () => true,
      requestPageData: async () => ({
        ok: true,
        ms: 0.5,
        json: JSON.stringify({
          b: [0, 0, 612, 792],
          f: ["Times"],
          c: [
            [65, 10, 10, 20, 20, 10, 10, 20, 20, 12, 0, 0, 0], // 'A' (ASCII fast-path)
            [0x00e9, 20, 10, 30, 20, 20, 10, 30, 20, 12, 0, 0, 0], // 'é' -> stays 'é' via SPECIALS
            [0x00e7, 30, 10, 40, 20, 30, 10, 40, 20, 12, 0, 0, 0], // 'ç' -> stays 'ç' via SPECIALS
            [0xfb01, 40, 10, 50, 20, 40, 10, 50, 20, 12, 0, 0, 0], // 'ﬁ' ligature -> 'fi' via NFKD
          ],
          l: [],
        }),
      }),
      reportHit() {},
      reportFallback() {},
    },
  });
  winCtx2.window = winCtx2;
  loadScriptInContext("src/reader-text-patch.js", winCtx2);
  const pd = await doc2.getPageData({ pageIndex: 0 });
  assert.deepEqual(
    Array.from(pd.chars, (x) => x.c),
    ["A", "é", "ç", "fi"],
    "Hoisted SPECIALS + ASCII fast-path must preserve exact char normalization"
  );
  winCtx2.__zotTurboUnpatchText();

  // 2. Verify NativeClient elastic worker pool: 1 baseline -> burst up to 3 -> idle reap back to 1
  let workersSpawned = 0;
  let workersTerminated = 0;
  class MockChromeWorker {
    constructor() {
      this.id = ++workersSpawned;
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(msg) {
      const delay = msg.op === "init" || msg.op === "shutdown" ? 5 : 25;
      setTimeout(() => {
        if (!this.onmessage) return;
        if (msg.op === "init") {
          this.onmessage({ data: { id: msg.id, ok: true, result: { version: "0.9.0" } } });
        } else if (msg.op === "shutdown") {
          this.onmessage({ data: { id: msg.id, ok: true, result: true } });
        } else {
          this.onmessage({ data: { id: msg.id, ok: true, result: { ok: true, workerId: this.id } } });
        }
      }, delay);
    }
    terminate() {
      workersTerminated++;
      this.onmessage = null;
    }
  }
  const ncCtx = vm.createContext({
    Zotero: { Profile: { dir: "C:\\mock" }, debug() {} },
    Services: { appinfo: { OS: "WINNT", XPCOMABI: "x86_64-msvc" }, prefs: {} },
    Components: {},
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
    ChromeWorker: MockChromeWorker,
    IOUtils: {
      makeDirectory: async () => {},
      stat: async () => ({ size: 2000000 }),
    },
    PathUtils: {
      profileDir: "C:\\mock",
      join: (...parts) => parts.join("\\"),
    },
  });
  loadScriptInContext("src/native-client.js", ncCtx);
  const client = new ncCtx.ZotTurboNativeClient.NativeClient({
    rootURI: "file:///mock/",
    version: "0.9.0",
    minWorkers: 1,
    maxWorkers: 3,
    burstReapMs: 80,
  });
  const started = await client.ensureStarted();
  assert.equal(started, true);
  assert.equal(client.slots.length, 1, "Elastic pool must start with only 1 lean baseline worker");
  assert.equal(workersSpawned, 1);

  // Trigger concurrent requests -> should burst up to 2 then 3 workers
  const burst1 = Promise.all([
    client.extractPageData("a.pdf", 0),
    client.extractPageData("a.pdf", 1),
  ]);
  await new Promise((r) => setTimeout(r, 12));
  const burst2 = Promise.all([
    client.extractPageData("a.pdf", 2),
    client.extractPageData("a.pdf", 3),
    client.extractPageData("a.pdf", 4),
  ]);
  await Promise.all([burst1, burst2]);
  assert.ok(client.slots.length >= 2 && client.slots.length <= 3, `Expected elastic burst to 2-3 workers, got ${client.slots.length}`);

  // Wait for burstReapMs to elapse -> extra workers must auto-reap back down to 1
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(client.slots.length, 1, "Idle burst workers must auto-reap back to 1 baseline worker");
  assert.ok(workersTerminated >= 1, "Reaped burst workers must be terminated cleanly");
  await client.shutdown();
  assert.equal(client.slots.length, 0);

  console.log("  PASS: Reader text ASCII/diacritic fast-path & elastic 1->3->1 NativeClient worker pool verified");
}

console.log("=== [Check 17] v0.10.0: Pure On-Demand MuPDF Engine Wake & Auto-Sleep (0 Workers in Library-Only Mode) ===");
{
  // 1. ReaderHook wakes renderEngine on attachReader() and auto-sleeps it after all PDF tabs close
  let engineStartCalls = 0;
  let engineSleepCalls = 0;
  let engineReady = false;
  const mockEngine = {
    onStatsChange: () => () => {},
    isEnabled: () => true,
    isReady: () => engineReady,
    async ensureStarted() {
      engineStartCalls++;
      engineReady = true;
    },
    async sleep() {
      engineSleepCalls++;
      engineReady = false;
      return true;
    },
    evictPath() {},
    getSummary: () => ({ enabled: true, ready: engineReady, totalRenders: 0, fgWorkers: engineReady ? 2 : 0, workers: engineReady ? 3 : 0 }),
  };
  const rhCtx3 = vm.createContext({
    Zotero: {
      Reader: { _readers: [] },
      Items: { getAsync: async () => ({ getFilePathAsync: async () => "C:\\papers\\demo.pdf" }) },
      Notifier: { registerObserver: () => 1, unregisterObserver() {} },
      File: { getResourceAsync: async () => "" },
      debug() {},
      logError() {},
    },
    Services: { wm: { getMostRecentWindow: () => null } },
    Components: { utils: { cloneInto: (x) => x, exportFunction: (f) => f, unwaiveXrays: (x) => x } },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }), now: () => Date.now() },
  });
  loadScriptInContext("src/reader-hook.js", rhCtx3);
  const rh3 = new rhCtx3.ZotMuPDFReaderHook.ReaderHook({
    pluginID: "zt",
    rootURI: "file:///",
    engineClient: mockEngine,
    renderIdleSleepMs: 60,
  });
  assert.equal(engineStartCalls, 0, "Engine must remain in 0-worker standby before any PDF opens");
  const fakeReader = { tabID: "tab-pdf-1", type: "pdf", itemID: 1, _isUninitialized: false, _isTabClosed: false };
  rh3.attachReader(fakeReader);
  assert.equal(engineStartCalls, 1, "attachReader() must wake MuPDF renderEngine on-demand");
  assert.equal(engineReady, true);
  // Closing the last PDF tab schedules engine.sleep()
  rh3._detachReader("tab-pdf-1");
  await new Promise((r) => setTimeout(r, 110));
  assert.equal(engineSleepCalls, 1, "Closing all PDF tabs must auto-sleep renderEngine after idle timeout");
  assert.equal(engineReady, false);
  // Opening a new PDF wakes it back up cleanly
  rh3.attachReader({ tabID: "tab-pdf-2", type: "pdf", itemID: 2, _isUninitialized: false, _isTabClosed: false });
  assert.equal(engineStartCalls, 2, "Re-opening a PDF after sleep must wake renderEngine cleanly");
  rh3.shutdown();

  // 2. NativeClient 1->0 idle sleep & transparent wake on next request
  let spawned = 0;
  let terminated = 0;
  class MockWorkerSleep {
    constructor() {
      spawned++;
      this.onmessage = null;
    }
    postMessage(msg) {
      setTimeout(() => {
        if (!this.onmessage) return;
        if (msg.op === "init") this.onmessage({ data: { id: msg.id, ok: true, result: { version: "0.10.0" } } });
        else if (msg.op === "shutdown") this.onmessage({ data: { id: msg.id, ok: true, result: true } });
        else this.onmessage({ data: { id: msg.id, ok: true, result: { ok: true } } });
      }, 4);
    }
    terminate() {
      terminated++;
      this.onmessage = null;
    }
  }
  const ncCtx2 = vm.createContext({
    Zotero: { Profile: { dir: "C:\\mock" }, debug() {} },
    Services: { appinfo: { OS: "WINNT", XPCOMABI: "x86_64-msvc" }, prefs: {} },
    Components: {},
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
    ChromeWorker: MockWorkerSleep,
    IOUtils: { makeDirectory: async () => {}, stat: async () => ({ size: 2000000 }) },
    PathUtils: { profileDir: "C:\\mock", join: (...parts) => parts.join("\\") },
  });
  loadScriptInContext("src/native-client.js", ncCtx2);
  const nc2 = new ncCtx2.ZotTurboNativeClient.NativeClient({
    rootURI: "file:///mock/",
    version: "0.10.0",
    minWorkers: 1,
    maxWorkers: 3,
    burstReapMs: 50,
    idleSleepMs: 70,
  });
  assert.equal(nc2.slots.length, 0, "NativeClient starts with 0 workers until first call");
  await nc2.extractPageData("demo.pdf", 0);
  assert.equal(nc2.slots.length, 1);
  assert.equal(nc2.available, true);
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(nc2.slots.length, 0, "Idle NativeClient must auto-sleep last baseline worker down to 0");
  assert.equal(nc2.available, false);
  assert.equal(terminated, 1);
  // Subsequent request transparently wakes worker #2
  const res = await nc2.extractPageData("demo.pdf", 1);
  assert.equal(res.ok, true);
  assert.equal(nc2.slots.length, 1);
  assert.equal(spawned, 2);
  await nc2.shutdown();

  // 3. Verify bootstrap.js implements pure on-demand standby & EngineClient exposes sleep()
  const bootSrc = fs.readFileSync(path.join(PLUGIN_DIR, "bootstrap.js"), "utf8");
  assert.ok(bootSrc.includes("standby: !nativeActive && !hasError"), "bootstrap.js must report standby status for Preferences UI");
  assert.ok(bootSrc.includes("if (hasOpenReaders"), "bootstrap.js must not spin up workers on library-only startup");
  const engSrc = fs.readFileSync(path.join(PLUGIN_DIR, "src/engine-client.js"), "utf8");
  assert.ok(engSrc.includes("async sleep()"), "EngineClient must expose sleep() for idle PDF-free reclamation");

  console.log("  PASS: On-demand MuPDF wake, PDF-free auto-sleep, and 0-worker NativeClient standby verified");
}

console.log("=== [Check 18] v0.11.0: Cold-Start Grace Window & Early Startup Tab Hibernation ===");
{
  // 1. PDFTextAccelerator extends getProcessedDataDelayMs() to 12s during first 45s cold-start grace window
  const capturedBridges = [];
  const makeViewerWin = () => {
    const w = {
      closed: false,
      Promise,
      eval() {
        capturedBridges.push(w.__zotTurboTextBridge);
      },
      addEventListener() {},
      removeEventListener() {},
    };
    w.wrappedJSObject = w;
    return w;
  };
  const ptaCtx = vm.createContext({
    Zotero: {
      PDFWorker: {},
      Items: {
        async getAsync() {
          return { isPDFAttachment: () => true, getFilePathAsync: async () => "C:\\papers\\startup.pdf" };
        },
      },
      File: { getResourceAsync: async () => "" },
      Notifier: { registerObserver: () => 1, unregisterObserver() {} },
      Reader: { _readers: [] },
      debug() {},
    },
    Services: {},
    Components: { utils: { cloneInto: (x) => x, isDeadWrapper: () => false } },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }) },
  });
  loadScriptInContext("src/pdf-text-accel.js", ptaCtx);

  const prefs = { processedDataDelayMs: 1500, startupGraceSec: 45, startupProcessedDataDelayMs: 12000 };
  const accelFresh = new ptaCtx.ZotTurboPDFTextAccel.PDFTextAccelerator({
    rootURI: "file:///mock/",
    nativeClient: { evictPath: async () => {} },
    getPref: (k, d) => (k in prefs ? prefs[k] : d),
    startupAt: Date.now(),
  });
  await accelFresh.init();
  const vw1 = makeViewerWin();
  accelFresh._attachReader({
    type: "pdf",
    itemID: 1,
    _iframeWindow: { document: { querySelector: () => ({ contentWindow: vw1 }) } },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(capturedBridges.length, 1);
  assert.equal(capturedBridges[0].getProcessedDataDelayMs(), 12000, "Cold-start grace window must defer getProcessedData to 12s");
  // Simulate > 45s elapsed -> reverts cleanly to normal 1.5s delay
  accelFresh._startupAt = Date.now() - 60_000;
  assert.equal(capturedBridges[0].getProcessedDataDelayMs(), 1500, "After 45s grace window, delay reverts to normal 1.5s");
  accelFresh.shutdown();

  // 2. reader-text-patch.js aborts getProcessedData cleanly if tab is unpatched/hibernated during defer delay
  let origProcessedCalls = 0;
  function MockDoc3() {
    this.numPages = 20;
  }
  MockDoc3.prototype.getPageData = async () => ({ chars: [] });
  MockDoc3.prototype.getProcessedData = async () => {
    origProcessedCalls++;
    return { pages: { 0: { overlays: [] } } };
  };
  const doc3 = new MockDoc3();
  const winCtx3 = vm.createContext({
    Promise,
    setTimeout,
    clearTimeout,
    closed: false,
    PDFViewerApplication: { pdfDocument: doc3 },
    __zotTurboTextBridge: {
      isEnabled: () => true,
      getProcessedDataDelayMs: () => 50,
      getProcessedDataMaxPages: () => 100,
    },
  });
  winCtx3.window = winCtx3;
  loadScriptInContext("src/reader-text-patch.js", winCtx3);
  const pendingProcessed = doc3.getProcessedData({});
  // Hibernate/unpatch tab after 15ms (before 50ms defer completes)
  await new Promise((r) => setTimeout(r, 15));
  winCtx3.__zotTurboUnpatchText();
  const abortedResult = await pendingProcessed;
  assert.deepEqual(JSON.parse(JSON.stringify(abortedResult)), { pages: {} });
  assert.equal(origProcessedCalls, 0, "Hibernated/unpatched tab must not wake PDF.js getProcessedData()");

  // 3. TabHibernator early startup restore sweep hibernates excess background tabs at t+startupSweepDelayMs
  const unloadedIds = [];
  const mockTabs = [
    { id: "lib", type: "library" },
    { id: "pdf-active", type: "reader", timeUnselected: 0, data: { itemID: 1 } },
    { id: "pdf-recent", type: "reader", timeUnselected: 1000, data: { itemID: 2 } },
    { id: "pdf-oldest", type: "reader", timeUnselected: 500, data: { itemID: 3 } },
  ];
  const mockWin = {
    closed: false,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElementNS: () => ({ remove() {} }),
      head: { appendChild() {} },
    },
    addEventListener() {},
    removeEventListener() {},
    Zotero_Tabs: {
      _tabs: mockTabs,
      selectedID: "pdf-active",
      canUnload: (id) => id !== "pdf-active" && id !== "lib",
      unload(id) {
        unloadedIds.push(id);
        const t = mockTabs.find((x) => x.id === id);
        if (t) t.type = "reader-unloaded";
      },
      unloadUnusedTabs() {},
    },
  };
  const thCtx = vm.createContext({
    Zotero: {
      getMainWindows: () => [mockWin],
      Date: { getUnixTimestamp: () => 1010 },
      Notifier: { registerObserver: () => 1, unregisterObserver() {} },
      Items: { getAsync: async () => null },
      debug() {},
    },
    Services: { obs: { addObserver() {}, removeObserver() {} }, focus: { activeWindow: mockWin } },
    Components: { classes: {}, interfaces: {} },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout, setInterval, clearInterval }) },
  });
  loadScriptInContext("src/tab-hibernator.js", thCtx);
  const hibernator = new thCtx.ZotTurboTabHibernator.TabHibernator({
    getPref: (k, d) => (k === "tabHibernateMaxLoaded" ? 2 : k === "startupHibernateBackgroundTabs" ? false : d),
    nativeClient: { trim: async () => {}, evictPath: async () => {} },
    startupSweepDelayMs: 35,
  });
  hibernator.init();
  assert.equal(unloadedIds.length, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(unloadedIds, ["pdf-oldest"], "Early startup sweep with startupHibernateBackgroundTabs=false must hibernate excess 3rd tab");
  hibernator.shutdown();
  assert.equal(hibernator._startupSweepTimer, null);

  // 4. Verify bootstrap.js wires startupAt, startupSweepDelayMs and pure on-demand nativeClient (no eager warmup timer)
  const bootSrc = fs.readFileSync(path.join(PLUGIN_DIR, "bootstrap.js"), "utf8");
  assert.ok(bootSrc.includes("startupGraceSec: 45"), "bootstrap.js must define startupGraceSec default");
  assert.ok(bootSrc.includes("startupProcessedDataDelayMs: 12000"), "bootstrap.js must define startupProcessedDataDelayMs default");
  assert.ok(bootSrc.includes("startupSweepDelayMs: 4000"), "bootstrap.js must enable early 4s startup tab sweep");
  assert.ok(bootSrc.includes("startupHibernateBackgroundTabs: true"), "bootstrap.js must enable startupHibernateBackgroundTabs by default");
  assert.ok(!bootSrc.includes("ZotTurboWarmupTimer"), "bootstrap.js must keep nativeClient purely on-demand with no eager startup warmup timer");

  console.log("  PASS: Cold-start 45s grace window, aborted hibernated scan, and early startup tab hibernation verified");
}

console.log("=== [Check 19] v0.12.0: Deferred SQLite Diagnostics, Coalesced Reader Scan & All-Background Startup Hibernation ===");
{
  // 1. SystemAccelerator.init() skips diagnostic PRAGMA page_count/freelist queries at startup
  const queries = [];
  const valueQueries = [];
  let idleDelaySeen = 0;
  const sysCtx = vm.createContext({
    Zotero: {
      DB: {
        async queryAsync(q) { queries.push(q); },
        async valueQueryAsync(q) { valueQueries.push(q); return 4096; },
      },
      Attachments: {},
      DataDirectory: { dir: "D:\\Mock" },
      debug() {},
    },
    Components: { classes: {}, interfaces: {} },
    ChromeUtils: {
      importESModule: () => ({
        setTimeout: (fn, ms) => { idleDelaySeen = ms; return 99; },
        clearTimeout() {},
      }),
    },
    IOUtils: { stat: async () => ({ size: 0 }) },
    PathUtils: { join: (...a) => a.join("\\") },
  });
  loadScriptInContext("src/system-accel.js", sysCtx);
  const sysAccel = new sysCtx.ZotTurboSystemAccel.SystemAccelerator({
    getPref: (_k, d) => d,
  });
  await sysAccel.init();
  assert.ok(queries.some((q) => q.includes("PRAGMA cache_size")), "Startup must still apply core SQLite tuning PRAGMAs");
  assert.equal(valueQueries.length, 0, "Startup must NOT run 10+ diagnostic PRAGMA page_count/freelist queries");
  assert.equal(idleDelaySeen, 180 * 1000, "Idle PRAGMA optimize must be deferred to 180s off startup");
  assert.equal(sysAccel.stats.sqliteInfo.cacheMB, 64);
  // Preferences on-demand refresh populates full stats
  await sysAccel.refreshSQLiteInfo();
  assert.ok(valueQueries.length >= 6, "On-demand refreshSQLiteInfo() must query full diagnostics when Preferences opens");
  await sysAccel.shutdown();

  // 2. TabHibernator with startupHibernateBackgroundTabs=true hibernates ALL restored background PDF tabs
  const unloaded2 = [];
  const mockTabs2 = [
    { id: "lib", type: "library" },
    { id: "pdf-active", type: "reader", timeUnselected: 0, data: { itemID: 1 } },
    { id: "pdf-bg-1", type: "reader", timeUnselected: 1000, data: { itemID: 2 } },
    { id: "pdf-bg-2", type: "reader", timeUnselected: 500, data: { itemID: 3 } },
  ];
  const mockWin2 = {
    closed: false,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElementNS: () => ({ remove() {} }),
      head: { appendChild() {} },
    },
    addEventListener() {},
    removeEventListener() {},
    Zotero_Tabs: {
      _tabs: mockTabs2,
      selectedID: "pdf-active",
      canUnload: (id) => id !== "pdf-active" && id !== "lib",
      unload(id) {
        unloaded2.push(id);
        const t = mockTabs2.find((x) => x.id === id);
        if (t) t.type = "reader-unloaded";
      },
      unloadUnusedTabs() {},
    },
  };
  const thCtx2 = vm.createContext({
    Zotero: {
      getMainWindows: () => [mockWin2],
      Date: { getUnixTimestamp: () => 1010 },
      Notifier: { registerObserver: () => 1, unregisterObserver() {} },
      Items: { getAsync: async () => null },
      debug() {},
    },
    Services: { obs: { addObserver() {}, removeObserver() {} }, focus: { activeWindow: mockWin2 } },
    Components: { classes: {}, interfaces: {} },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout, setInterval, clearInterval }) },
  });
  loadScriptInContext("src/tab-hibernator.js", thCtx2);
  const hib2 = new thCtx2.ZotTurboTabHibernator.TabHibernator({
    getPref: (_k, d) => d, // startupHibernateBackgroundTabs defaults to true
    nativeClient: { trim: async () => {}, evictPath: async () => {} },
    startupSweepDelayMs: 30,
  });
  hib2.init();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(unloaded2, ["pdf-bg-1", "pdf-bg-2"], "Default startup sweep must hibernate ALL restored background PDF tabs while preserving active tab");
  hib2.shutdown();

  // 3. ReaderHook coalesces rapid tab add/select bursts into a single debounced scan
  let notifyCb = null;
  const rhCtx4 = vm.createContext({
    Zotero: {
      Reader: { _readers: [] },
      Items: { getAsync: async () => null },
      Notifier: { registerObserver: (o) => { notifyCb = o.notify; return 1; }, unregisterObserver() {} },
      File: { getResourceAsync: async () => "" },
      debug() {},
      logError() {},
    },
    Services: { wm: { getMostRecentWindow: () => null } },
    Components: { utils: { cloneInto: (x) => x, exportFunction: (f) => f, unwaiveXrays: (x) => x } },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }), now: () => Date.now() },
  });
  loadScriptInContext("src/reader-hook.js", rhCtx4);
  const rh4 = new rhCtx4.ZotMuPDFReaderHook.ReaderHook({
    pluginID: "zt",
    rootURI: "file:///",
    engineClient: { onStatsChange: () => () => {}, isEnabled: () => true, isReady: () => false },
  });
  await rh4.init();
  let scanCount = 0;
  rh4._scanAllReaders = () => { scanCount++; };
  for (let i = 0; i < 6; i++) notifyCb("add", "tab");
  assert.equal(scanCount, 0, "Burst tab add events must be debounced");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(scanCount, 1, "6 rapid tab add events must coalesce into 1 initial scan");
  rh4.shutdown();
  assert.equal(rh4._scanTimer, null);
  assert.equal(rh4._scanFollowupTimer, null);

  console.log("  PASS: Deferred SQLite diagnostics, 180s optimize, all-background startup hibernation & coalesced scan verified");
}

console.log("=== [Check 20] v0.13.2: Zero-Hijack Native Library Start While Preserving All Open Tabs ===");
{
  let lastClosedSaved = null;
  const origSetLastClosed = (st) => { lastClosedSaved = st; };
  let startupSelectPref = true;
  const unloadedIds3 = [];
  const selectCalls3 = [];
  const tabs3 = [
    { id: "zotero-pane", type: "library" },
    // User clicked pdf-1 BEFORE bootstrap.startup() finished (slow Zotero.initializationPromise!)
    { id: "pdf-1", type: "reader", timeSelected: 1995, timeUnselected: 0, data: { itemID: 9239 } },
    // User also briefly clicked pdf-2 10s ago (timeSelected=1990)
    { id: "pdf-2", type: "reader", timeSelected: 1990, timeUnselected: 1994, data: { itemID: 9145 } },
    // Stale restored background reader (no recent timeSelected)
    { id: "pdf-stale", type: "reader", timeUnselected: 1000, data: { itemID: 8663 } },
  ];
  const origGetState = () => ({
    type: "pane",
    tabs: [
      { type: "library", title: "My Library", data: { icon: "library" } },
      { type: "reader", title: "Paper A", data: { itemID: 9239 }, selected: true },
      { type: "reader", title: "Textbook B", data: { itemID: 9145 } },
      { type: "reader", title: "Paper C", data: { itemID: 8663 } },
    ],
  });
  const mockWin3 = {
    closed: false,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElementNS: () => ({ remove() {} }),
      head: { appendChild() {} },
    },
    addEventListener() {},
    removeEventListener() {},
    ZoteroPane: { getState: origGetState },
    Zotero_Tabs: {
      _tabs: tabs3,
      selectedID: "pdf-1",
      select(id) {
        selectCalls3.push(id);
        this.selectedID = id;
      },
      canUnload(id) { return id !== this.selectedID && id !== "zotero-pane"; },
      unload(id) {
        unloadedIds3.push(id);
        const t = tabs3.find((x) => x.id === id);
        if (t) t.type = "reader-unloaded";
      },
      unloadUnusedTabs() {},
    },
  };
  let sessionSaveCalls = 0;
  const mockSessionState = {
    windows: [
      {
        type: "pane",
        tabs: [
          { type: "library", title: "My Library" },
          { type: "reader", title: "Paper A", data: { itemID: 9239 }, selected: true },
        ],
      },
    ],
  };
  const thCtx3 = vm.createContext({
    Zotero: {
      getMainWindows: () => [mockWin3],
      Date: { getUnixTimestamp: () => 2000 },
      Notifier: { registerObserver: () => 1, unregisterObserver() {} },
      Items: { getAsync: async () => null },
      Session: {
        setLastClosedZoteroPaneState: origSetLastClosed,
        state: mockSessionState,
        async save() {
          sessionSaveCalls++;
          mockSessionState.windows = [mockWin3.ZoteroPane.getState()];
        },
      },
      debug() {},
    },
    Services: { obs: { addObserver() {}, removeObserver() {} }, focus: { activeWindow: mockWin3 } },
    Components: { classes: {}, interfaces: {} },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout, setInterval, clearInterval }) },
  });
  loadScriptInContext("src/tab-hibernator.js", thCtx3);
  const hib3 = new thCtx3.ZotTurboTabHibernator.TabHibernator({
    getPref: (k, d) => (k === "startupSelectLibraryTab" ? startupSelectPref : d),
    nativeClient: { trim: async () => {}, evictPath: async () => {} },
    startupAt: Date.now(),
    startupSweepDelayMs: 30,
  });
  hib3.init();

  // 1. NEVER hijack user's active PDF tab after launch!
  assert.equal(mockWin3.Zotero_Tabs.selectedID, "pdf-1", "Must NEVER yank user back to My Library after they clicked a PDF");
  assert.equal(selectCalls3.length, 0, "TabHibernator must not call Zotero_Tabs.select() on startup");

  // 2. ZoteroPane.getState() preserves ALL tabs & order while marking My Library selected for next launch
  const savedState = mockWin3.ZoteroPane.getState();
  assert.equal(savedState.tabs.length, 4, "All 4 tabs (Library + 3 PDFs) must be preserved");
  assert.equal(savedState.tabs[0].type, "library");
  assert.equal(savedState.tabs[0].selected, true, "My Library must be marked selected in session.json");
  assert.equal(savedState.tabs[1].selected, undefined, "PDF tab 1 must NOT be marked selected");
  assert.equal(savedState.tabs[1].data.itemID, 9239, "PDF tab 1 itemID preserved");
  assert.equal(savedState.tabs[2].data.itemID, 9145, "PDF tab 2 itemID preserved");
  assert.equal(savedState.tabs[3].data.itemID, 8663, "PDF tab 3 itemID preserved");

  // 3. Zotero.Session.setLastClosedZoteroPaneState() also normalizes last-closed window state
  thCtx3.Zotero.Session.setLastClosedZoteroPaneState(origGetState());
  assert.equal(lastClosedSaved.tabs[0].selected, true);
  assert.equal(lastClosedSaved.tabs[1].selected, undefined);

  // 4. Disabling pref restores original pass-through behavior
  startupSelectPref = false;
  const rawState = mockWin3.ZoteroPane.getState();
  assert.equal(rawState.tabs[1].selected, true, "When pref is disabled, active PDF tab stays selected");
  startupSelectPref = true;

  // 5. After startup sweep runs:
  //    - active pdf-1 stays active (NEVER jumped back to Library!)
  //    - recently clicked pdf-2 (10s ago) is SPARED from startup-restore hibernation
  //    - stale restored pdf-stale IS hibernated
  //    - unnormalized session.json is persisted once for next zero-PDF launch
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(mockWin3.Zotero_Tabs.selectedID, "pdf-1", "Active PDF tab must remain selected after startup sweep");
  assert.deepEqual(unloadedIds3, ["pdf-stale"], "Only stale background tabs hibernated; recently clicked PDF spared");
  assert.equal(sessionSaveCalls, 1, "Unnormalized PDF-selected session.json must be persisted immediately on first boot");
  assert.equal(mockSessionState.windows[0].tabs[0].selected, true);
  assert.equal(mockSessionState.windows[0].tabs[1].selected, undefined);

  // 6. Clean restore on normal shutdown (disable/uninstall/upgrade)
  hib3.shutdown();
  assert.equal(mockWin3.ZoteroPane.getState, origGetState, "ZoteroPane.getState restored cleanly");
  assert.equal(thCtx3.Zotero.Session.setLastClosedZoteroPaneState, origSetLastClosed, "Session hook restored cleanly");

  // 7. Already-normalized session.json triggers ZERO redundant startup saves & never touches active tab
  const hib4 = new thCtx3.ZotTurboTabHibernator.TabHibernator({
    getPref: (k, d) => (k === "startupSelectLibraryTab" ? true : d),
    nativeClient: { trim: async () => {}, evictPath: async () => {} },
    startupAt: Date.now(),
    startupSweepDelayMs: 30,
  });
  hib4.init();
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(mockWin3.Zotero_Tabs.selectedID, "pdf-1", "Active PDF tab stays untouched");
  assert.equal(sessionSaveCalls, 1, "Already-normalized session.json must NOT trigger redundant startup save");

  // 8. APP_SHUTDOWN preserves session normalization even if Zotero.Session.save() runs after bootstrap.shutdown()
  hib4.shutdown({ preserveSessionHook: true });
  const quitSavedState = mockWin3.ZoteroPane.getState();
  assert.equal(quitSavedState.tabs[0].selected, true, "APP_SHUTDOWN must keep session normalization active for final save");
  assert.equal(quitSavedState.tabs[1].selected, undefined);

  console.log("  PASS: zero-hijack startupSelectLibraryTab, recently-clicked tab guard, silent migration & APP_SHUTDOWN verified");
}

console.log("=== [Check 21] v0.14.0: 4K 120Hz & Long-Paper Fluidity Suite ===");
{
  // 21.1 + 21.2 + 21.3: page-patch.js (4K maxPageMegapixels, CSS containment + liteOverlayBlend, scroll-settled TextLayer/StructTree)
  const styleNodes = new Map();
  const scrollListeners = [];
  const classSet = new Set();
  const containerEl = {
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      has: (c) => classSet.has(c),
    },
    addEventListener(ev, fn) { if (ev === "scroll") scrollListeners.push(fn); },
    removeEventListener(ev, fn) {
      if (ev === "scroll") {
        const idx = scrollListeners.indexOf(fn);
        if (idx >= 0) scrollListeners.splice(idx, 1);
      }
    },
  };
  let origTextRenderCalls = 0;
  let origStructRenderCalls = 0;
  class MockTextLayer {
    async render() { origTextRenderCalls++; return "text-ok"; }
    cancel() {}
  }
  class MockStructTree {
    async render() { origStructRenderCalls++; return "struct-ok"; }
  }
  class MockPdfPage {
    constructor(n) { this.pageNumber = n; this._pageIndex = n - 1; }
    getViewport() { return { width: 595, height: 842, transform: [1, 0, 0, -1, 0, 842] }; }
    render() { return { promise: Promise.resolve() }; }
  }
  const tl1 = new MockTextLayer();
  const tl2 = new MockTextLayer();
  const st1 = new MockStructTree();
  const st2 = new MockStructTree();
  const mockPages = [
    { id: 1, renderingState: 3, pdfPage: new MockPdfPage(1), textLayer: tl1, structTreeLayer: st1 },
    { id: 2, renderingState: 3, pdfPage: new MockPdfPage(2), textLayer: tl2, structTreeLayer: st2 },
  ];
  const cfg4k = {
    renderThumbnails: true,
    aaLevel: 8,
    softwareCanvas: true,
    maxOutputScale: 1.5,
    maxPageMegapixels: 4.5,
    liteOverlayBlend: true,
    longDocCssOpt: true,
    deferTextLayerOnScroll: true,
  };
  const renderedPayloads = [];
  const docEl = {
    getElementById: (id) => (id === "viewerContainer" ? containerEl : styleNodes.get(id) || null),
    createElement: (tag) => {
      const el = { tagName: tag.toUpperCase(), id: "", textContent: "", remove() { styleNodes.delete(this.id); } };
      return el;
    },
    head: { appendChild(el) { if (el.id) styleNodes.set(el.id, el); } },
  };
  const ppCtx = vm.createContext({
    setTimeout,
    clearTimeout,
    performance: { now: () => Date.now() },
    document: docEl,
    window: null,
  });
  ppCtx.window = ppCtx;
  ppCtx.PDFViewerApplication = {
    pdfDocument: { getPage: async (n) => mockPages[n - 1].pdfPage },
    pdfViewer: { container: containerEl, _pages: mockPages, _getVisiblePages: () => ({ ids: new Set([1]) }) },
    eventBus: { on() {}, off() {} },
    pdfRenderingQueue: { renderHighestPriority() {} },
  };
  ppCtx.__zotMuPDFBridge = {
    isEnabled: () => true,
    getConfig: () => ({ ...cfg4k }),
    setPassword() {},
    cancelRequest() {},
    reportFallback() {},
    reportMuPDFPaint() {},
    reportTextLayerTiming() {},
    reportPdfJsTiming() {},
    renderPage(payloadJSON, _canvas, _ctx, _isCancelled, onPainted) {
      renderedPayloads.push(JSON.parse(payloadJSON));
      onPainted(2.0, "skia", 0);
    },
  };
  loadScriptInContext("src/page-patch.js", ppCtx);

  // Check injected 4K & long-doc CSS
  const optStyle = styleNodes.get("zot-turbo-4k-style");
  assert.ok(optStyle, "4K & long-doc optimization <style> must be injected");
  assert.ok(optStyle.textContent.includes("contain: layout style"), "Must apply CSS layout containment on .page");
  assert.ok(optStyle.textContent.includes("mix-blend-mode: normal !important"), "Must include liteOverlayBlend rules");

  // Check 4K maxPageMegapixels cap: 2520x3255 (8.20 MP) -> <= 4.55 MP; 1200x1550 (1.86 MP) untouched
  const canvas4k = { width: 2520, height: 3255, closest: () => null };
  await mockPages[0].pdfPage.render({
    canvas: canvas4k,
    viewport: { width: 1680, height: 2170, transform: [2.82, 0, 0, -2.82, 0, 2170] },
    transform: [1.5, 0, 0, 1.5, 0, 0],
    annotationMode: 1,
  }).promise;
  assert.ok(canvas4k.width * canvas4k.height <= 4550000, `4K canvas must be capped <= 4.55 MP, got ${canvas4k.width}x${canvas4k.height}`);
  assert.ok(canvas4k.width >= 1800, `4K canvas must stay crisp >= 1800px wide, got ${canvas4k.width}`);

  const canvas1080 = { width: 1200, height: 1550, closest: () => null };
  await mockPages[0].pdfPage.render({
    canvas: canvas1080,
    viewport: { width: 800, height: 1033, transform: [1.34, 0, 0, -1.34, 0, 1033] },
    transform: [1.5, 0, 0, 1.5, 0, 0],
    annotationMode: 1,
  }).promise;
  assert.equal(canvas1080.width, 1200, "1080p canvas (1.86 MP) must stay 100% native untouched");

  // Check scroll-settled TextLayer & StructTree deferral
  await tl1.render({});
  assert.equal(origTextRenderCalls, 1, "When not scrolling, TextLayer renders immediately (0ms delay)");

  // Trigger active scroll -> adds zot-turbo-scrolling class & defers textLayer/structTree
  assert.equal(scrollListeners.length, 1, "Scroll watcher attached to viewerContainer");
  scrollListeners[0]();
  assert.ok(classSet.has("zot-turbo-scrolling"), "Active scroll must add zot-turbo-scrolling class");
  const pDeferActive = tl1.render({});
  const pDeferEvicted = tl2.render({});
  const pStructEvicted = st2.render();
  // Simulate page 2 getting evicted by _trimPageBuffer while user scrolled past it!
  tl2.cancel();
  mockPages[1].renderingState = 0;
  assert.equal(origTextRenderCalls, 1, "During active scroll, textLayer must wait for scroll settle");
  await Promise.all([pDeferActive, pDeferEvicted, pStructEvicted]);
  assert.ok(!classSet.has("zot-turbo-scrolling"), "zot-turbo-scrolling must clear once scroll settles");
  assert.equal(origTextRenderCalls, 2, "Only settled active page 1 rendered TextLayer; scrolled-past page 2 skipped!");
  assert.equal(origStructRenderCalls, 0, "Scrolled-past page 2 skipped StructTreeLayer completely!");

  // Dynamic pref toggle off removes injected <style>
  cfg4k.longDocCssOpt = false;
  cfg4k.liteOverlayBlend = false;
  ppCtx.__zotMuPDFControl.applyRuntimeOpts();
  assert.equal(styleNodes.has("zot-turbo-4k-style"), false, "Disabling CSS/blend prefs must remove style cleanly");

  // Uninstall cleanly restores TextLayer & StructTree prototypes
  ppCtx.__zotMuPDFControl.uninstall();
  assert.equal(MockTextLayer.prototype.render.name, "render", "TextLayer.prototype.render restored");
  assert.equal(MockStructTree.prototype.render.name, "render", "StructTree.prototype.render restored");

  // 21.4: ReaderHook _updateViewStats 120Hz scroll coalescing
  let viewStatsCalls = 0;
  const mockViewerObj = { currentPageNumber: 10, currentScaleValue: "page-width", pagesCount: 867, scrollMode: 0, spreadMode: 0 };
  const rawPvMock = {
    _scrolling: true,
    _iframeWindow: { PDFViewerApplication: { pdfViewer: mockViewerObj } },
    _updateViewStats() { viewStatsCalls++; },
  };
  const origUpdateFn = rawPvMock._updateViewStats;
  const rhCtx5 = vm.createContext({
    Zotero: {
      File: { getResourceAsync: async () => "" },
      Reader: { _readers: [], registerEventListener() {}, unregisterEventListener() {} },
      Notifier: { registerObserver: () => 1, unregisterObserver() {} },
      debug() {},
      logError() {},
    },
    Services: { wm: { getMostRecentWindow: () => null } },
    Components: { utils: { exportFunction: (fn) => fn, cloneInto: (o) => o, unwaiveXrays: (o) => o } },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }), now: () => Date.now() },
  });
  loadScriptInContext("src/reader-hook.js", rhCtx5);
  const rh5 = new rhCtx5.ZotMuPDFReaderHook.ReaderHook({
    pluginID: "zt",
    rootURI: "file:///",
    engineClient: { onStatsChange: () => () => {}, isEnabled: () => true, isReady: () => false, log() {} },
    getPref: (k, d) => (k === "longDocScrollOpt" ? true : d),
  });
  const state5 = {
    iframeWin: { closed: false },
    reader: { _internalReader: { _primaryView: rawPvMock } },
    viewStatsHooks: new Set(),
  };
  rh5._hookLongDocScrollViews(state5);
  // Burst 20 scroll frames on same page -> coalesced into 1 immediate call
  for (let i = 0; i < 20; i++) rawPvMock._updateViewStats();
  assert.equal(viewStatsCalls, 1, "20 rapid same-page 120Hz scroll frames must coalesce into 1 immediate _updateViewStats call");
  // Crossing to page 11 fires IMMEDIATELY (0ms lag!)
  mockViewerObj.currentPageNumber = 11;
  rawPvMock._updateViewStats();
  assert.equal(viewStatsCalls, 2, "Crossing to a new page must update viewStats immediately");
  // Clean restore on shutdown
  rh5.shutdown();
  assert.equal(rawPvMock._updateViewStats, origUpdateFn, "PDFView._updateViewStats restored cleanly on shutdown");

  // 21.5: TabHibernator background active-tab GPU canvas trim (trimBackgroundTabCanvas)
  let notifyTabFn = null;
  let trim1Calls = 0;
  let trim2Calls = 0;
  const mockWin5 = {
    closed: false,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElementNS: () => ({ remove() {} }), head: { appendChild() {} } },
    addEventListener() {},
    removeEventListener() {},
    Zotero_Tabs: {
      _tabs: [{ id: "zotero-pane", type: "library" }, { id: "pdf-1", type: "reader" }, { id: "pdf-2", type: "reader" }],
      selectedID: "pdf-1",
      canUnload: () => true,
      unload() {},
      unloadUnusedTabs() {},
    },
  };
  const thCtx5 = vm.createContext({
    Zotero: {
      getMainWindows: () => [mockWin5],
      Date: { getUnixTimestamp: () => 2000 },
      Notifier: { registerObserver: (o) => { notifyTabFn = o.notify; return 1; }, unregisterObserver() {} },
      Items: { getAsync: async () => null },
      Reader: {
        _readers: [
          { tabID: "pdf-1", _isUninitialized: false, _isTabClosed: false, _internalReader: { _primaryView: { trimMemory() { trim1Calls++; } } } },
          { tabID: "pdf-2", _isUninitialized: false, _isTabClosed: false, _internalReader: { _primaryView: { trimMemory() { trim2Calls++; } } } },
        ],
      },
      debug() {},
    },
    Services: { obs: { addObserver() {}, removeObserver() {} }, focus: { activeWindow: mockWin5 } },
    Components: { classes: {}, interfaces: {} },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout, setInterval, clearInterval }) },
  });
  loadScriptInContext("src/tab-hibernator.js", thCtx5);
  const hib5 = new thCtx5.ZotTurboTabHibernator.TabHibernator({
    getPref: (k, d) => (k === "trimBackgroundTabCanvas" ? true : d),
    nativeClient: { trim: async () => {}, evictPath: async () => {} },
    startupSweepDelayMs: 0,
    bgTrimDelayMs: 40,
  });
  hib5.init();
  // Switch pdf-1 -> pdf-2, then quickly switch back before 40ms -> trim cancelled!
  mockWin5.Zotero_Tabs.selectedID = "pdf-2";
  notifyTabFn("select", "tab");
  mockWin5.Zotero_Tabs.selectedID = "pdf-1";
  notifyTabFn("select", "tab");
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(trim1Calls, 0, "Quickly switching back to pdf-1 must cancel its background canvas trim");
  assert.equal(trim2Calls, 1, "pdf-2 stayed in background >40ms so its off-screen canvases were trimmed");
  assert.equal(hib5.stats.backgroundTrims, 1);
  hib5.shutdown();

  console.log("  PASS: 4K maxPageMegapixels, CSS containment, blend-free scroll, deferred TextLayer/StructTree, 120Hz ViewStats coalescing & bg canvas trim verified");
}

console.log("=== [Check 22] v0.14.1: Adaptive HiDPI (Unlimited Settled Display Page + 3.6 MP Other Pages + Zero-Flicker Atomic Swap) ===");
{
  // 22.1: EngineClient.getConfig() parses adaptive, native, and fixed megapixel presets
  const prefStore = {};
  const ecCtx = vm.createContext({
    Zotero: {
      Prefs: {
        get: (k) => prefStore[k],
        set: (k, v) => { prefStore[k] = v; },
      },
      debug() {},
    },
    Services: { appinfo: { OS: "WINNT", XPCOMABI: "x86_64-msvc" } },
    Components: { classes: {}, interfaces: {} },
    ChromeUtils: { importESModule: () => ({ setTimeout, clearTimeout }), now: () => Date.now() },
    ChromeWorker: class {},
    IOUtils: {},
    PathUtils: {},
  });
  loadScriptInContext("src/engine-client.js", ecCtx);
  const ec = new ecCtx.ZotMuPDFEngineClient.EngineClient({ rootURI: "file:///", version: "0.14.2" });
  const cfgDefault = ec.getConfig();
  assert.equal(cfgDefault.adaptiveHiDPI, true, "Default maxPageMegapixels must enable adaptiveHiDPI");
  assert.equal(cfgDefault.maxPageMegapixels, 3.6, "Adaptive fast tier cap must default to 3.6 MP");
  assert.equal(cfgDefault.adaptiveSlowDwellMs, 400, "Default slow-read dwell must be 400ms");
  assert.equal(cfgDefault.adaptiveFastDwellMs, 1200, "Default fast-flip dwell must be 1200ms");
  prefStore["extensions.zotero-turbo.mupdf.maxPageMegapixels"] = "";
  const cfgNative = ec.getConfig();
  assert.equal(cfgNative.adaptiveHiDPI, false);
  assert.equal(cfgNative.maxPageMegapixels, 0, "Empty string means unlimited native for all pages");
  prefStore["extensions.zotero-turbo.mupdf.maxPageMegapixels"] = "6.0";
  const cfgFixed = ec.getConfig();
  assert.equal(cfgFixed.adaptiveHiDPI, false);
  assert.equal(cfgFixed.maxPageMegapixels, 6.0);

  // 22.2: Full Adaptive HiDPI lifecycle in page-patch.js
  function makeMockCanvas(w, h) {
    const children = [];
    const c = {
      tagName: "CANVAS",
      width: w,
      height: h,
      className: "page-canvas",
      role: "presentation",
      style: { cssText: "width: 1400px; height: 1812px;", transform: "" },
      isConnected: true,
      parentNode: null,
      children,
      drawImageCalls: 0,
      closest: () => null,
      get firstChild() { return children[0] || null; },
      appendChild(node) {
        if (node._parent) {
          const i = node._parent.children.indexOf(node);
          if (i >= 0) node._parent.children.splice(i, 1);
        }
        node._parent = c;
        children.push(node);
        return node;
      },
      replaceWith(next) {
        c._replacedBy = next;
        c.isConnected = false;
        next.isConnected = true;
      },
      getContext() {
        return {
          imageSmoothingEnabled: false,
          drawImage() { c.drawImageCalls++; },
          putImageData() {},
        };
      },
    };
    return c;
  }

  class AdaptiveMockPage {
    constructor(n) { this.pageNumber = n; this._pageIndex = n - 1; }
    getViewport() { return { width: 595, height: 842, transform: [1, 0, 0, -1, 0, 842] }; }
    render() { return { promise: Promise.resolve() }; }
  }

  const scrollListeners2 = [];
  const busHandlers = new Map();
  const visibleIds = new Set([1]);
  const container2 = {
    classList: { add() {}, remove() {} },
    addEventListener(ev, fn) { if (ev === "scroll") scrollListeners2.push(fn); },
    removeEventListener() {},
  };
  const mockPages2 = [
    { id: 1, renderingState: 3, pdfPage: new AdaptiveMockPage(1), canvas: null },
    { id: 2, renderingState: 3, pdfPage: new AdaptiveMockPage(2), canvas: null },
    { id: 3, renderingState: 3, pdfPage: new AdaptiveMockPage(3), canvas: null },
  ];
  const renderCalls = [];
  const cancelledReqIds = [];
  let holdNextUpgrade = false;
  let heldUpgradeFinish = null;

  const ppCtx2 = vm.createContext({
    setTimeout,
    clearTimeout,
    performance: { now: () => Date.now() },
    document: {
      getElementById: (id) => (id === "viewerContainer" ? container2 : null),
      createElement: (tag) => (tag === "canvas" ? makeMockCanvas(0, 0) : { id: "", textContent: "", remove() {} }),
      head: { appendChild() {} },
    },
    window: null,
  });
  ppCtx2.window = ppCtx2;
  ppCtx2.PDFViewerApplication = {
    pdfDocument: { getPage: async (n) => mockPages2[n - 1].pdfPage },
    pdfViewer: {
      container: container2,
      currentPageNumber: 1,
      _pages: mockPages2,
      _getVisiblePages: () => ({ ids: visibleIds, views: mockPages2.filter((p) => visibleIds.has(p.id)).map((v) => ({ id: v.id, view: v })) }),
    },
    eventBus: {
      on(ev, fn) { if (!busHandlers.has(ev)) busHandlers.set(ev, new Set()); busHandlers.get(ev).add(fn); },
      off(ev, fn) { busHandlers.get(ev)?.delete(fn); },
      dispatch(ev, data) { for (const fn of busHandlers.get(ev) || []) fn(data); },
    },
    pdfRenderingQueue: { renderHighestPriority() {} },
  };
  ppCtx2.__zotMuPDFBridge = {
    isEnabled: () => true,
    getConfig: () => ({
      renderThumbnails: true,
      aaLevel: 8,
      softwareCanvas: true,
      maxOutputScale: 0, // Native 4K 2.0x DPR!
      adaptiveHiDPI: true,
      maxPageMegapixels: 3.6,
      liteOverlayBlend: true,
      longDocCssOpt: true,
      deferTextLayerOnScroll: true,
    }),
    setPassword() {},
    cancelRequest(reqId) { cancelledReqIds.push(reqId); },
    reportFallback() {},
    reportMuPDFPaint() {},
    reportTextLayerTiming() {},
    reportPdfJsTiming() {},
    renderPage(payloadJSON, _canvas, _ctx, isCancelledFn, onPainted) {
      const parsed = JSON.parse(payloadJSON);
      renderCalls.push(parsed);
      if (holdNextUpgrade && parsed.isAdaptiveUpgrade) {
        holdNextUpgrade = false;
        heldUpgradeFinish = () => {
          if (!isCancelledFn()) onPainted(4.0, "skia-sliced", 0);
        };
        return;
      }
      onPainted(3.0, parsed.isDetached ? "skia-sliced" : "skia", 0);
    },
  };
  loadScriptInContext("src/page-patch.js", ppCtx2);

  // Case 1: Settled visible Page 1 renders DIRECTLY at unlimited 4K native (2800x3624 = 10.15 MP) in 1 pass!
  const c1 = makeMockCanvas(2800, 3624);
  mockPages2[0].canvas = c1;
  await mockPages2[0].pdfPage.render({
    canvas: c1,
    viewport: { width: 1400, height: 1812, transform: [2.35, 0, 0, -2.35, 0, 1812] },
    transform: [2.0, 0, 0, 2.0, 0, 0],
    annotationMode: 1,
  }).promise;
  assert.equal(c1.width, 2800, "Settled visible page must render at UNLIMITED native width (2800px)");
  assert.equal(c1.height, 3624, "Settled visible page must render at UNLIMITED native height (3624px)");
  assert.ok(c1._zotAdaptiveFullSpec, "Unlimited visible page must store _zotAdaptiveFullSpec for later off-screen demotion");

  // Case 2: Off-screen pre-rendered Page 2 caps to <= 3.65 MP (~1668x2158) and saves _zotAdaptiveSpec!
  const c2 = makeMockCanvas(2800, 3624);
  const structNode = { tagName: "SPAN", id: "struct-tree-p2" };
  c2.appendChild(structNode);
  mockPages2[1].canvas = c2;
  await mockPages2[1].pdfPage.render({
    canvas: c2,
    viewport: { width: 1400, height: 1812, transform: [2.35, 0, 0, -2.35, 0, 1812] },
    transform: [2.0, 0, 0, 2.0, 0, 0],
    annotationMode: 1,
  }).promise;
  assert.ok(c2.width * c2.height <= 3650000, `Off-screen page must cap to <= 3.65 MP, got ${c2.width}x${c2.height}`);
  assert.ok(c2._zotAdaptiveSpec, "Capped off-screen page must store _zotAdaptiveSpec for settled upgrade");

  // Case 3: Active scroll into Page 2 + mid-scroll render of Page 3 caps Page 3 to <= 3.65 MP
  visibleIds.clear();
  visibleIds.add(2);
  ppCtx2.PDFViewerApplication.pdfViewer.currentPageNumber = 2;
  scrollListeners2[0](); // starts active scrolling!
  const c3 = makeMockCanvas(2800, 3624);
  mockPages2[2].canvas = c3;
  visibleIds.add(3);
  await mockPages2[2].pdfPage.render({
    canvas: c3,
    viewport: { width: 1400, height: 1812, transform: [2.35, 0, 0, -2.35, 0, 1812] },
    transform: [2.0, 0, 0, 2.0, 0, 0],
    annotationMode: 1,
  }).promise;
  assert.ok(c3.width * c3.height <= 3650000, `Mid-scroll visible page must cap to <= 3.65 MP, got ${c3.width}x${c3.height}`);

  // Leave ONLY Page 2 visible: brief glance at 180ms stays 3.6 MP (no wasted GPU upload!),
  // then once slow-read 400ms dwell finishes (~450ms total), Page 2 atomically upgrades to 2800x3624!
  visibleIds.delete(3);
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(mockPages2[1].canvas, c2, "Brief 180ms glance after scroll must NOT prematurely trigger full-res upgrade");
  await new Promise((r) => setTimeout(r, 270));
  const upgradedC2 = mockPages2[1].canvas;
  assert.notEqual(upgradedC2, c2, "Settled visible Page 2 must atomically swap pv.canvas to detached hiCanvas after 400ms dwell");
  assert.equal(upgradedC2.width, 2800, "Upgraded Page 2 must reach UNLIMITED native 2800px");
  assert.equal(upgradedC2.height, 3624, "Upgraded Page 2 must reach UNLIMITED native 3624px");
  assert.equal(upgradedC2.style.cssText, "width: 1400px; height: 1812px;", "CSS dimensions preserved identically");
  assert.equal(upgradedC2.firstChild, structNode, "structTreeLayer child DOM must be migrated atomically to hiCanvas!");
  assert.equal(c2.width, 0, "Old capped canvas backing store must be freed (width=0)");
  assert.equal(c2.height, 0, "Old capped canvas backing store must be freed (height=0)");
  assert.ok(
    renderCalls.some((r) => r.isAdaptiveUpgrade && r.isDetached && r.skipBgPrerender === true && r.width === 2800),
    "Upgrade must render off-screen detached with skipBgPrerender=true so MuPDF pixCache stays lean"
  );

  // Case 4: Wait > 600ms off-screen settle -> Page 1 (now off-screen!) demotes from 10.15 MP -> 3.6 MP!
  await new Promise((r) => setTimeout(r, 380));
  const demotedC1 = mockPages2[0].canvas;
  assert.notEqual(demotedC1, c1, "Off-screen Page 1 must demote to save 4K VRAM");
  assert.ok(demotedC1.width * demotedC1.height <= 3650000, `Demoted Page 1 must shrink to <= 3.65 MP, got ${demotedC1.width}x${demotedC1.height}`);
  assert.equal(demotedC1.drawImageCalls, 1, "Demotion must downsample existing canvas via 2D drawImage");
  assert.equal(c1.width, 0, "Old unlimited off-screen canvas freed (width=0)");
  assert.ok(demotedC1._zotAdaptiveSpec, "Demoted Page 1 retains _zotAdaptiveSpec so returning to it upgrades back to unlimited!");

  // Case 5: Resuming scroll mid-upgrade IMMEDIATELY cancels in-flight upgrade & leaves pv.canvas untouched!
  visibleIds.clear();
  visibleIds.add(3);
  ppCtx2.PDFViewerApplication.pdfViewer.currentPageNumber = 3;
  holdNextUpgrade = true;
  scrollListeners2[0]();
  await new Promise((r) => setTimeout(r, 450)); // settle + slow dwell starts held upgrade for Page 3
  assert.ok(typeof heldUpgradeFinish === "function", "Upgrade for Page 3 must be in-flight");
  const prevCancels = cancelledReqIds.length;
  scrollListeners2[0](); // user resumes scrolling before upgrade finishes!
  assert.ok(cancelledReqIds.length > prevCancels, "Resuming scroll must immediately cancel in-flight adaptive upgrade");
  heldUpgradeFinish();
  assert.equal(mockPages2[2].canvas, c3, "Cancelled upgrade must NEVER swap stale hiCanvas onto pv.canvas");

  ppCtx2.__zotMuPDFControl.uninstall();
  console.log("  PASS: Adaptive HiDPI (1-pass unlimited settled, 3.6 MP off-screen/scroll, atomic zero-flicker swap, structTree migration, off-screen demote & scroll-cancel) verified");
}

console.log("=== [Check 23] v0.14.2: Rhythm-Aware Fast-Flip Dwell, Instant Click-Upgrade, Primary-Viewport Filter & VRAM Guard ===");
{
  function makeRectCanvas(w, h) {
    const c = {
      tagName: "CANVAS",
      width: w,
      height: h,
      className: "page-canvas",
      role: "presentation",
      style: { cssText: "width: 1400px; height: 1812px;", transform: "" },
      isConnected: true,
      drawImageCalls: 0,
      closest: () => null,
      firstChild: null,
      appendChild() {},
      replaceWith(next) { c.isConnected = false; next.isConnected = true; },
      getContext() { return { imageSmoothingEnabled: false, drawImage() { c.drawImageCalls++; }, putImageData() {} }; },
    };
    return c;
  }
  class RhythmPage {
    constructor(n) { this.pageNumber = n; this._pageIndex = n - 1; }
    getViewport() { return { width: 595, height: 842, transform: [1, 0, 0, -1, 0, 842] }; }
    render() { return { promise: Promise.resolve() }; }
  }

  const containerListeners = new Map();
  const container3 = {
    scrollTop: 0,
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ top: 0, bottom: 1000, width: 1600, height: 1000 }),
    addEventListener(ev, fn) {
      if (!containerListeners.has(ev)) containerListeners.set(ev, []);
      containerListeners.get(ev).push(fn);
    },
    removeEventListener() {},
    fire(ev, arg) { for (const fn of containerListeners.get(ev) || []) fn(arg); },
  };

  // Page 1 & 2 full off-screen, Page 5 primary (85% of viewport), Page 6 peeking edge (15% of viewport!)
  const pageRects = {
    1: { top: -3000, bottom: -2000, height: 1000 },
    2: { top: -1800, bottom: -800, height: 1000 },
    5: { top: 0, bottom: 850, height: 850 },
    6: { top: 850, bottom: 1700, height: 850 }, // only 150px visible = 17.6% < 35%!
  };
  const visible3 = new Set([1]);
  const pages3 = [1, 2, 3, 4, 5, 6].map((id) => ({
    id,
    renderingState: 3,
    pdfPage: new RhythmPage(id),
    canvas: null,
    div: { getBoundingClientRect: () => pageRects[id] || { top: 5000, bottom: 6000, height: 1000 } },
  }));
  const payloads3 = [];
  const ppCtx3 = vm.createContext({
    setTimeout,
    clearTimeout,
    performance: { now: () => Date.now() },
    document: {
      getElementById: (id) => (id === "viewerContainer" ? container3 : null),
      createElement: (tag) => (tag === "canvas" ? makeRectCanvas(0, 0) : { id: "", textContent: "", remove() {} }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    window: null,
  });
  ppCtx3.window = ppCtx3;
  ppCtx3.PDFViewerApplication = {
    pdfDocument: { getPage: async (n) => pages3[n - 1].pdfPage },
    pdfViewer: {
      container: container3,
      currentPageNumber: 1,
      _pages: pages3,
      _getVisiblePages: () => ({ ids: visible3, views: pages3.filter((p) => visible3.has(p.id)).map((v) => ({ id: v.id, view: v })) }),
    },
    eventBus: { on() {}, off() {} },
    pdfRenderingQueue: { renderHighestPriority() {} },
  };
  ppCtx3.__zotMuPDFBridge = {
    isEnabled: () => true,
    getConfig: () => ({
      renderThumbnails: true,
      aaLevel: 8,
      softwareCanvas: true,
      maxOutputScale: 0,
      adaptiveHiDPI: true,
      maxPageMegapixels: 3.6,
      adaptiveSlowDwellMs: 220, // fast unit-test timing
      adaptiveFastDwellMs: 520,
      liteOverlayBlend: true,
      longDocCssOpt: true,
      deferTextLayerOnScroll: true,
    }),
    setPassword() {},
    cancelRequest() {},
    reportFallback() {},
    reportMuPDFPaint() {},
    reportTextLayerTiming() {},
    reportPdfJsTiming() {},
    renderPage(payloadJSON, _canvas, _ctx, _isCancelled, onPainted) {
      payloads3.push(JSON.parse(payloadJSON));
      onPainted(2.0, "skia", 0);
    },
  };
  loadScriptInContext("src/page-patch.js", ppCtx3);

  // Render Page 1 & Page 2 as full unlimited first (simulating 2 previously-read pages!)
  const p1c = makeRectCanvas(2800, 3624);
  pages3[0].canvas = p1c;
  await pages3[0].pdfPage.render({
    canvas: p1c,
    viewport: { width: 1400, height: 1812, transform: [2.35, 0, 0, -2.35, 0, 1812] },
    transform: [2.0, 0, 0, 2.0, 0, 0],
    annotationMode: 1,
  }).promise;
  assert.equal(payloads3[0].skipBgPrerender, true, "Initial 1-pass unlimited 4K render must set skipBgPrerender=true");

  visible3.clear();
  visible3.add(2);
  ppCtx3.PDFViewerApplication.pdfViewer.currentPageNumber = 2;
  const p2c = makeRectCanvas(2800, 3624);
  pages3[1].canvas = p2c;
  await pages3[1].pdfPage.render({
    canvas: p2c,
    viewport: { width: 1400, height: 1812, transform: [2.35, 0, 0, -2.35, 0, 1812] },
    transform: [2.0, 0, 0, 2.0, 0, 0],
    annotationMode: 1,
  }).promise;

  // Fast-flip jump from Page 2 -> Page 5 (pageDelta = 3 >= 2, scrollPx = 5000 >= 2400 -> fast-flip mode!)
  // Page 5 is 85% visible (primary), Page 6 is only 15% peeking at bottom edge!
  container3.scrollTop = 0;
  container3.fire("scroll");
  visible3.clear();
  visible3.add(5);
  visible3.add(6);
  ppCtx3.PDFViewerApplication.pdfViewer.currentPageNumber = 5;
  container3.scrollTop = 5000;
  const p5c = makeRectCanvas(2800, 3624);
  const p6c = makeRectCanvas(2800, 3624);
  pages3[4].canvas = p5c;
  pages3[5].canvas = p6c;
  await pages3[4].pdfPage.render({
    canvas: p5c,
    viewport: { width: 1400, height: 1812, transform: [2.35, 0, 0, -2.35, 0, 1812] },
    transform: [2.0, 0, 0, 2.0, 0, 0],
    annotationMode: 1,
  }).promise;
  await pages3[5].pdfPage.render({
    canvas: p6c,
    viewport: { width: 1400, height: 1812, transform: [2.35, 0, 0, -2.35, 0, 1812] },
    transform: [2.0, 0, 0, 2.0, 0, 0],
    annotationMode: 1,
  }).promise;
  container3.fire("scroll");

  // Wait 280ms (past 140ms scroll settle AND past 220ms slow dwell, still inside 520ms fast-flip dwell!):
  // 1) Fast-flip dwell holds Page 5 at 3.6 MP (no wasted full-res render on quick glance!)
  // 2) Immediate excess VRAM guard demoted oldest off-screen Page 1 right at 140ms settle!
  await new Promise((r) => setTimeout(r, 280));
  assert.equal(pages3[4].canvas, p5c, "Fast-flip brief glance (280ms < 520ms) must keep Page 5 at 3.6 MP");
  assert.notEqual(pages3[0].canvas, p1c, "Excess off-screen unlimited Page 1 must be demoted immediately at settle");
  assert.equal(p1c.width, 0, "Demoted Page 1 old full-res canvas backing store freed immediately");

  // Click OUTSIDE .page (e.g. scrollbar) -> must NOT trigger instant upgrade!
  container3.fire("pointerdown", { target: { closest: () => null } });
  assert.equal(pages3[4].canvas, p5c, "Clicking scrollbar outside .page must NOT trigger instant upgrade");

  // Click INSIDE .page -> explicit reading intent skips remaining fast-flip dwell IMMEDIATELY (0ms)!
  container3.fire("pointerdown", { target: { closest: (sel) => (sel === ".page" ? {} : null) } });
  assert.notEqual(pages3[4].canvas, p5c, "Clicking inside .page must IMMEDIATELY upgrade primary Page 5 to unlimited!");
  assert.equal(pages3[4].canvas.width, 2800, "Upgraded primary Page 5 reaches full 2800px native");
  assert.equal(pages3[5].canvas, p6c, "Barely peeking edge Page 6 (<35% visible) must STAY at 3.6 MP (zero wasted VRAM!)");
  assert.ok(pages3[5].canvas.width * pages3[5].canvas.height <= 3650000);

  // Verify C source declares ZOT_RENDER_FLAG_NO_BG_PRERENDER and guards schedule_bg_prerenders
  const dllSrc = fs.readFileSync(path.join(ROOT, "native/zot_dll.c"), "utf8");
  assert.ok(dllSrc.includes("ZOT_RENDER_FLAG_NO_BG_PRERENDER"), "zot_dll.c must define ZOT_RENDER_FLAG_NO_BG_PRERENDER");
  assert.ok(dllSrc.includes("if (!skip_bg_prerender"), "zot_dll.c must skip bg pre-renders on unlimited adaptive renders");

  ppCtx3.__zotMuPDFControl.uninstall();
  console.log("  PASS: Rhythm-aware fast-flip dwell, 0ms page-click upgrade, scrollbar guard, primary-viewport filter & immediate excess VRAM demotion verified");
}

console.log("\n[ALL 23 VERIFICATION SUITES PASSED]");
