/* global Zotero, Components, ChromeUtils, IOUtils, PathUtils */
"use strict";

var ZotTurboSystemAccel = (function () {
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  class SystemAccelerator {
    constructor({ getPref }) {
      this.getPref = getPref;
      this._origImportEmbeddedImage = null;
      this._wrappedImportEmbeddedImage = null;
      this._idleOptTimer = null;
      this._destroyed = false;

      this.stats = {
        sqliteTuned: false,
        sqliteInfo: {},
        sqliteLastOptimizeAt: 0,
        webpCompressedCount: 0,
        webpSkippedCount: 0,
        webpBytesBefore: 0,
        webpBytesAfter: 0,
      };
    }

    async init() {
      await this.applySQLitePragmas();
      this._hookNoteImageImport();

      this._idleOptTimer = setTimeout(() => {
        if (!this._destroyed && this.getPref("sqliteTuneEnabled", true)) {
          this.runIdleOptimize({ truncateWal: false }).catch(() => {});
        }
      }, 45 * 1000);
    }

    getMemorySnapshot() {
      const snap = { residentMB: 0, heapMB: 0, ok: false };
      try {
        const mgr = Components.classes["@mozilla.org/memory-reporter-manager;1"].getService(
          Components.interfaces.nsIMemoryReporterManager
        );
        if (mgr) {
          const res = Number(mgr.residentFast || mgr.resident || 0);
          const heap = Number(mgr.heapAllocated || 0);
          snap.residentMB = res > 0 ? res / (1024 * 1024) : 0;
          snap.heapMB = heap > 0 ? heap / (1024 * 1024) : 0;
          snap.ok = res > 0;
        }
      } catch {}
      return snap;
    }

    async applySQLitePragmas() {
      if (!Zotero.DB || typeof Zotero.DB.queryAsync !== "function") return;
      const enabled = !!this.getPref("sqliteTuneEnabled", true);
      const cacheMB = Math.max(8, Math.min(256, Number(this.getPref("sqliteCacheMB", 64)) || 64));
      const mmapMB = Math.max(0, Math.min(1024, Number(this.getPref("sqliteMmapMB", 256)) || 256));

      try {
        if (enabled) {
          await Zotero.DB.queryAsync(`PRAGMA cache_size = -${cacheMB * 1024}`);
          await Zotero.DB.queryAsync("PRAGMA temp_store = MEMORY");
          await Zotero.DB.queryAsync(`PRAGMA mmap_size = ${mmapMB * 1024 * 1024}`);

          try {
            const ftCacheMB = Math.max(8, Math.floor(cacheMB / 2));
            const ftMmapMB = Math.floor(mmapMB / 2);
            await Zotero.DB.queryAsync(`PRAGMA ftindex.cache_size = -${ftCacheMB * 1024}`);
            await Zotero.DB.queryAsync(`PRAGMA ftindex.mmap_size = ${ftMmapMB * 1024 * 1024}`);
          } catch {}

          this.stats.sqliteTuned = true;
        } else {
          await Zotero.DB.queryAsync("PRAGMA cache_size = -8192");
          await Zotero.DB.queryAsync("PRAGMA mmap_size = 0");
          this.stats.sqliteTuned = false;
        }
        await this.refreshSQLiteInfo();
      } catch (err) {
        Zotero.debug("[ZotTurbo] SQLite PRAGMA tune error: " + (err?.message || err));
      }
    }

    async refreshSQLiteInfo() {
      try {
        const cacheSize = await Zotero.DB.valueQueryAsync("PRAGMA cache_size");
        const mmapSize = await Zotero.DB.valueQueryAsync("PRAGMA mmap_size");
        const tempStore = await Zotero.DB.valueQueryAsync("PRAGMA temp_store");
        const journalMode = await Zotero.DB.valueQueryAsync("PRAGMA journal_mode");
        const pageSize = Number(await Zotero.DB.valueQueryAsync("PRAGMA page_size")) || 4096;
        const pageCount = Number(await Zotero.DB.valueQueryAsync("PRAGMA page_count")) || 0;
        const freelistCount = Number(await Zotero.DB.valueQueryAsync("PRAGMA freelist_count")) || 0;

        let ftSizeMB = 0;
        let ftFreelistMB = 0;
        try {
          const ftPs = Number(await Zotero.DB.valueQueryAsync("PRAGMA ftindex.page_size")) || 4096;
          const ftPc = Number(await Zotero.DB.valueQueryAsync("PRAGMA ftindex.page_count")) || 0;
          const ftFl = Number(await Zotero.DB.valueQueryAsync("PRAGMA ftindex.freelist_count")) || 0;
          ftSizeMB = (ftPc * ftPs) / (1024 * 1024);
          ftFreelistMB = (ftFl * ftPs) / (1024 * 1024);
        } catch {}

        let walMB = 0;
        try {
          if (typeof IOUtils !== "undefined" && typeof PathUtils !== "undefined" && Zotero.DataDirectory?.dir) {
            for (const fname of ["zotero.sqlite-wal", "fulltext.sqlite-wal"]) {
              const p = PathUtils.join(Zotero.DataDirectory.dir, fname);
              try {
                const st = await IOUtils.stat(p);
                if (st && st.size > 0) walMB += st.size / (1024 * 1024);
              } catch {}
            }
          }
        } catch {}

        const mainSizeMB = (pageCount * pageSize) / (1024 * 1024);
        const mainFreelistMB = (freelistCount * pageSize) / (1024 * 1024);

        this.stats.sqliteInfo = {
          cacheSize,
          cacheMB: cacheSize < 0 ? Math.round(-cacheSize / 1024) : Math.round((cacheSize * pageSize) / (1024 * 1024)),
          mmapMB: Math.round((Number(mmapSize) || 0) / (1024 * 1024)),
          tempStore: tempStore === 2 ? "MEMORY" : tempStore === 1 ? "FILE" : "DEFAULT",
          journalMode: String(journalMode || ""),
          pageSize,
          mainSizeMB,
          mainFreelistMB,
          mainWastePct: pageCount > 0 ? (freelistCount / pageCount) * 100 : 0,
          ftSizeMB,
          ftFreelistMB,
          walMB,
        };
      } catch {}
      return this.stats.sqliteInfo;
    }

    async runIdleOptimize({ truncateWal = false, mergeFts5 = false } = {}) {
      if (this._destroyed || !Zotero.DB) return { ok: false };
      const t0 = Date.now();
      let fts5Merged = 0;
      try {
        await Zotero.DB.queryAsync("PRAGMA analysis_limit = 1000");
        await Zotero.DB.queryAsync("PRAGMA optimize");
        if (mergeFts5) {
          for (const tbl of ["fulltextContent", "fulltextContentCJK", "fulltextNotes", "fulltextNotesCJK"]) {
            try {
              await Zotero.DB.queryAsync(`INSERT INTO ftindex.${tbl}(${tbl}, rank) VALUES('merge', 200)`);
              fts5Merged++;
            } catch {}
          }
        }
        await Zotero.DB.queryAsync(truncateWal ? "PRAGMA wal_checkpoint(TRUNCATE)" : "PRAGMA wal_checkpoint(PASSIVE)");
        if (truncateWal) {
          try {
            await Zotero.DB.queryAsync("PRAGMA ftindex.wal_checkpoint(TRUNCATE)");
          } catch {}
        }
        this.stats.sqliteLastOptimizeAt = Date.now();
        await this.refreshSQLiteInfo();
        return { ok: true, ms: Date.now() - t0, fts5Merged, info: this.stats.sqliteInfo };
      } catch (err) {
        Zotero.debug("[ZotTurbo] SQLite optimize error: " + (err?.message || err));
        return { ok: false, error: err?.message || String(err) };
      }
    }

    async runVacuum() {
      if (this._destroyed || !Zotero.DB || typeof Zotero.DB.vacuum !== "function") {
        return { ok: false, error: "当前 Zotero 版本不支持在线原子 VACUUM" };
      }
      const beforeInfo = await this.refreshSQLiteInfo();
      const beforeMB = Number(beforeInfo?.mainSizeMB) || 0;
      const t0 = Date.now();
      try {
        const performed = await Zotero.DB.vacuum({ force: true });
        await this.applySQLitePragmas();
        const afterInfo = await this.refreshSQLiteInfo();
        const afterMB = Number(afterInfo?.mainSizeMB) || 0;
        return {
          ok: true,
          performed: !!performed,
          ms: Date.now() - t0,
          beforeMB,
          afterMB,
          freedMB: Math.max(0, beforeMB - afterMB),
        };
      } catch (err) {
        Zotero.debug("[ZotTurbo] SQLite vacuum error: " + (err?.message || err));
        return { ok: false, error: err?.message || String(err) };
      }
    }

    async _transcodeBlobToWebP(blob, { quality = 0.85, maxDim = 2560 } = {}) {
      const win = Zotero.getMainWindow();
      if (!win || typeof win.createImageBitmap !== "function") return null;

      const bitmap = await win.createImageBitmap(blob);
      try {
        let w = bitmap.width;
        let h = bitmap.height;
        if (w <= 0 || h <= 0) return null;

        if (maxDim > 0 && (w > maxDim || h > maxDim)) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.max(1, Math.round(w * ratio));
          h = Math.max(1, Math.round(h * ratio));
        }

        let webpBlob = null;
        if (typeof win.OffscreenCanvas === "function") {
          const canvas = new win.OffscreenCanvas(w, h);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0, w, h);
          webpBlob = await canvas.convertToBlob({ type: "image/webp", quality });
        } else {
          const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0, w, h);
          webpBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
        }
        return webpBlob;
      } finally {
        try {
          bitmap.close();
        } catch {}
      }
    }

    _hookNoteImageImport() {
      if (!Zotero.Attachments || typeof Zotero.Attachments.importEmbeddedImage !== "function") return;
      const origImport = Zotero.Attachments.importEmbeddedImage;
      this._origImportEmbeddedImage = origImport;
      const self = this;

      const wrappedImport = async function zotTurboImportEmbeddedImage(params) {
        if (self._destroyed || !self.getPref("noteWebpEnabled", true) || !params || !params.blob) {
          return origImport.call(this, params);
        }

        const blob = params.blob;
        const mime = String(blob.type || "").toLowerCase();
        const minKB = Math.max(8, Math.min(4096, Number(self.getPref("noteWebpMinKB", 64)) || 64));
        const qualityPct = Math.max(40, Math.min(98, Number(self.getPref("noteWebpQuality", 85)) || 85));
        const maxDim = Math.max(0, Math.min(8192, Number(self.getPref("noteWebpMaxDim", 2560)) || 2560));

        if ((mime === "image/png" || mime === "image/bmp") && blob.size >= minKB * 1024) {
          try {
            const webpBlob = await self._transcodeBlobToWebP(blob, {
              quality: qualityPct / 100,
              maxDim,
            });
            if (webpBlob && webpBlob.type === "image/webp" && webpBlob.size > 0 && webpBlob.size < blob.size * 0.92) {
              self.stats.webpCompressedCount++;
              self.stats.webpBytesBefore += blob.size;
              self.stats.webpBytesAfter += webpBlob.size;
              Zotero.debug(
                `[ZotTurbo] Note image PNG->WebP: ${(blob.size / 1024).toFixed(1)} KB -> ${(webpBlob.size / 1024).toFixed(1)} KB`
              );
              return origImport.call(this, { ...params, blob: webpBlob });
            } else {
              self.stats.webpSkippedCount++;
            }
          } catch (err) {
            Zotero.debug("[ZotTurbo] WebP transcode skipped: " + (err?.message || err));
            self.stats.webpSkippedCount++;
          }
        }

        return origImport.call(this, params);
      };
      this._wrappedImportEmbeddedImage = wrappedImport;
      Zotero.Attachments.importEmbeddedImage = wrappedImport;
    }

    async scanLegacyNoteImages() {
      const minKB = Math.max(8, Math.min(4096, Number(this.getPref("noteWebpMinKB", 64)) || 64));
      const minBytes = minKB * 1024;
      const candidates = [];
      let totalBytes = 0;

      if (!Zotero.DB || typeof Zotero.DB.queryAsync !== "function" || !Zotero.Items?.getAsync) {
        return { count: 0, totalMB: 0, minKB, candidates };
      }

      const linkMode = Zotero.Attachments?.LINK_MODE_EMBEDDED_IMAGE ?? 4;
      const rows = await Zotero.DB.queryAsync(
        `SELECT IA.itemID, IA.contentType FROM itemAttachments IA
         JOIN items I ON I.itemID = IA.itemID
         WHERE IA.linkMode = ?
           AND IA.contentType IN ('image/png', 'image/bmp')
           AND I.itemID NOT IN (SELECT itemID FROM deletedItems)`,
        [linkMode]
      );

      for (const row of rows || []) {
        try {
          const item = await Zotero.Items.getAsync(row.itemID);
          if (!item || item.deleted || !item.isAttachment?.()) continue;
          if (item.library && item.library.editable === false) continue;
          const filePath = await item.getFilePathAsync();
          if (!filePath) continue;
          const st = await IOUtils.stat(filePath);
          if (!st || st.type !== "regular" || st.size < minBytes) continue;
          candidates.push({
            itemID: item.id,
            path: filePath,
            sizeBytes: st.size,
            mime: String(row.contentType || item.attachmentContentType || "image/png").toLowerCase(),
          });
          totalBytes += st.size;
        } catch {}
      }

      return {
        count: candidates.length,
        totalMB: totalBytes / (1024 * 1024),
        minKB,
        candidates,
      };
    }

    async compressLegacyNoteImages(onProgress) {
      const scan = await this.scanLegacyNoteImages();
      const qualityPct = Math.max(40, Math.min(98, Number(this.getPref("noteWebpQuality", 85)) || 85));
      const maxDim = Math.max(0, Math.min(8192, Number(this.getPref("noteWebpMaxDim", 2560)) || 2560));
      const win = Zotero.getMainWindow?.();
      if (!win || typeof win.Blob !== "function") {
        return { ok: false, error: "无法访问主窗口编码器", converted: 0, skipped: 0, failed: 0, savedMB: 0 };
      }

      let converted = 0;
      let skipped = 0;
      let failed = 0;
      let bytesBefore = 0;
      let bytesAfter = 0;
      const total = scan.candidates.length;

      for (let i = 0; i < total; i++) {
        if (this._destroyed) break;
        const c = scan.candidates[i];
        try {
          const item = await Zotero.Items.getAsync(c.itemID);
          if (!item || item.deleted) {
            skipped++;
            continue;
          }
          const oldPath = await item.getFilePathAsync();
          if (!oldPath) {
            skipped++;
            continue;
          }
          const rawBytes = await IOUtils.read(oldPath);
          if (!rawBytes || rawBytes.byteLength < c.sizeBytes * 0.5) {
            skipped++;
            continue;
          }
          const origBlob = new win.Blob([rawBytes], { type: c.mime });
          const webpBlob = await this._transcodeBlobToWebP(origBlob, {
            quality: qualityPct / 100,
            maxDim,
          });
          if (!webpBlob || webpBlob.type !== "image/webp" || webpBlob.size <= 0 || webpBlob.size >= rawBytes.byteLength * 0.92) {
            skipped++;
            this.stats.webpSkippedCount++;
            continue;
          }

          const webpBuf = new Uint8Array(await webpBlob.arrayBuffer());
          const parentDir = PathUtils.parent(oldPath);
          const newPath = PathUtils.join(parentDir, "image.webp");
          const tmpPath = newPath + ".ztmp";

          await IOUtils.write(tmpPath, webpBuf);
          await IOUtils.move(tmpPath, newPath);

          try {
            item.attachmentPath = "storage:image.webp";
            item.attachmentContentType = "image/webp";
            await item.saveTx();
            try {
              item._updateAttachmentStates?.(true);
            } catch {}
          } catch (saveErr) {
            // Roll back newly written file so original PNG remains 100% intact
            await IOUtils.remove(newPath, { ignoreAbsent: true }).catch(() => {});
            throw saveErr;
          }

          if (oldPath !== newPath) {
            await IOUtils.remove(oldPath, { ignoreAbsent: true }).catch(() => {});
          }

          converted++;
          bytesBefore += rawBytes.byteLength;
          bytesAfter += webpBuf.byteLength;
          this.stats.webpCompressedCount++;
          this.stats.webpBytesBefore += rawBytes.byteLength;
          this.stats.webpBytesAfter += webpBuf.byteLength;
        } catch (err) {
          failed++;
          Zotero.debug("[ZotTurbo] Legacy PNG->WebP skipped item " + c.itemID + ": " + (err?.message || err));
        }

        try {
          onProgress?.({
            done: i + 1,
            total,
            converted,
            savedMB: Math.max(0, bytesBefore - bytesAfter) / (1024 * 1024),
          });
        } catch {}

        await new Promise((r) => setTimeout(r, 0));
      }

      return {
        ok: true,
        total,
        converted,
        skipped,
        failed,
        savedMB: Math.max(0, bytesBefore - bytesAfter) / (1024 * 1024),
      };
    }

    async runHealthAudit() {
      const report = {
        timestamp: Date.now(),
        dataDir: Zotero.DataDirectory?.dir || "",
        memory: this.getMemorySnapshot(),
        sqlite: await this.refreshSQLiteInfo(),
        largeDataFiles: [],
        addons: [],
        hints: [],
      };

      // 1. Scan installed extensions & XPI footprint
      const activeAddonNames = new Set();
      try {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const exts = await AddonManager.getAddonsByTypes(["extension"]);
        const extDir =
          typeof PathUtils !== "undefined" && (PathUtils.profileDir || Zotero.Profile?.dir)
            ? PathUtils.join(PathUtils.profileDir || Zotero.Profile.dir, "extensions")
            : "";

        for (const a of exts || []) {
          if (!a || a.id === "zotero-turbo@happyany.github.io") continue;
          let sizeKB = 0;
          if (extDir && typeof IOUtils !== "undefined") {
            try {
              const xpiPath = PathUtils.join(extDir, `${a.id}.xpi`);
              const st = await IOUtils.stat(xpiPath);
              if (st && st.size > 0) sizeKB = st.size / 1024;
            } catch {}
          }
          const isActive = !!(a.isActive && !a.userDisabled);
          if (isActive) {
            activeAddonNames.add(String(a.id || "").toLowerCase());
            activeAddonNames.add(String(a.name || "").toLowerCase());
          }
          report.addons.push({
            id: a.id,
            name: a.name || a.id,
            version: a.version || "",
            active: isActive,
            sizeKB,
          });
        }
        report.addons.sort((a, b) => (b.active - a.active) || (b.sizeKB - a.sizeKB));
      } catch (err) {
        Zotero.debug("[ZotTurbo] Health audit addons scan skipped: " + (err?.message || err));
      }

      // 2. Scan Zotero Data Directory top-level large files (read-only!)
      const CORE_FILES = new Set([
        "zotero.sqlite",
        "zotero.sqlite-wal",
        "zotero.sqlite-shm",
        "zotero.sqlite-journal",
        "fulltext.sqlite",
        "fulltext.sqlite-wal",
        "fulltext.sqlite-shm",
      ]);

      try {
        if (report.dataDir && typeof IOUtils !== "undefined" && typeof IOUtils.getChildren === "function") {
          const children = await IOUtils.getChildren(report.dataDir);
          for (const childPath of children || []) {
            try {
              const st = await IOUtils.stat(childPath);
              if (!st || st.type !== "regular") continue;
              const sizeMB = st.size / (1024 * 1024);
              if (sizeMB < 1.0) continue;
              const name = PathUtils.filename(childPath);
              const lower = name.toLowerCase();
              let category = "数据文件";
              let note = "";

              if (CORE_FILES.has(lower)) {
                category = lower.endsWith("-wal") ? "核心 WAL" : "核心数据库";
                if (lower.endsWith("-wal") && sizeMB > 20) {
                  note = "WAL 偏大，可点「优化 SQLite & WAL」截断";
                }
              } else if (lower.startsWith("zotero.sqlite") && (lower.includes(".bak") || /\.\d+$/.test(lower))) {
                category = "自动备份";
                note = "Zotero 历史备份文件";
              } else if (lower.endsWith(".sqlite") || lower.endsWith(".sqlite-wal") || lower.endsWith(".db")) {
                category = "第三方/孤儿库";
                const stem = lower.replace(/(-index)?\.sqlite(-wal)?$|\.db$/, "");
                const matchedActive = [...activeAddonNames].some((n) => n && (n.includes(stem) || stem.includes(n.split("@")[0])));
                note = matchedActive ? "活跃第三方插件数据库" : "疑似已禁用/卸载插件遗留，可手动核查清理";
              } else if (lower.endsWith(".json") && sizeMB >= 2) {
                category = "大配置/缓存";
                note = "较大 JSON 文件，可能拖慢启动解析";
              }

              report.largeDataFiles.push({ name, path: childPath, sizeMB, category, note });
            } catch {}
          }
          report.largeDataFiles.sort((a, b) => b.sizeMB - a.sizeMB);
          report.largeDataFiles = report.largeDataFiles.slice(0, 12);
        }
      } catch (err) {
        Zotero.debug("[ZotTurbo] Health audit dataDir scan skipped: " + (err?.message || err));
      }

      // 3. Build concise actionable hints
      const orphans = report.largeDataFiles.filter((f) => f.note.includes("疑似已禁用"));
      if (orphans.length > 0) {
        const sum = orphans.reduce((s, f) => s + f.sizeMB, 0);
        report.hints.push(`发现 ${orphans.length} 个疑似遗留插件数据库（共 ${sum.toFixed(1)} MB），可点「打开数据目录」手动确认后清理。`);
      }
      if (report.sqlite?.walMB > 20) {
        report.hints.push(`当前 SQLite WAL 达 ${report.sqlite.walMB.toFixed(1)} MB，建议点击上方「优化 SQLite & WAL」。`);
      }
      if (report.sqlite?.mainWastePct > 15) {
        report.hints.push(`主库空洞率 ${report.sqlite.mainWastePct.toFixed(1)}%，说明经历过较多删除操作。`);
      }
      const heavyAddons = report.addons.filter((a) => a.active && a.sizeKB >= 5120);
      if (heavyAddons.length > 0) {
        report.hints.push(
          `较重的活跃扩展：${heavyAddons.map((a) => `${a.name} (${(a.sizeKB / 1024).toFixed(1)} MB)`).join("、")}，如遇界面卡顿可检查其定时刷新/列渲染设置。`
        );
      }
      if (report.hints.length === 0) {
        report.hints.push("数据目录与扩展状态整体健康，未发现明显异常膨胀。");
      }

      return report;
    }

    revealDataDir() {
      try {
        const dir = Zotero.DataDirectory?.dir;
        if (dir && Zotero.File?.reveal) {
          const target = typeof PathUtils !== "undefined" ? PathUtils.join(dir, "zotero.sqlite") : dir;
          Promise.resolve(Zotero.File.reveal(target))
            .catch(() => Promise.resolve(Zotero.File.reveal(dir)).catch(() => {}));
          return true;
        }
      } catch {}
      return false;
    }

    getStats() {
      const savedBytes = Math.max(0, this.stats.webpBytesBefore - this.stats.webpBytesAfter);
      return {
        ...this.stats,
        memory: this.getMemorySnapshot(),
        webpSavedMB: savedBytes / (1024 * 1024),
        webpSavedRatio:
          this.stats.webpBytesBefore > 0 ? (savedBytes / this.stats.webpBytesBefore) * 100 : 0,
      };
    }

    async shutdown() {
      this._destroyed = true;
      if (this._idleOptTimer) {
        clearTimeout(this._idleOptTimer);
        this._idleOptTimer = null;
      }
      if (this._origImportEmbeddedImage && Zotero.Attachments) {
        if (Zotero.Attachments.importEmbeddedImage === this._wrappedImportEmbeddedImage) {
          Zotero.Attachments.importEmbeddedImage = this._origImportEmbeddedImage;
        }
        this._origImportEmbeddedImage = null;
        this._wrappedImportEmbeddedImage = null;
      }
    }
  }

  return { SystemAccelerator };
})();
