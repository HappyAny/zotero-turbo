/* global ctypes, self */
"use strict";

let lib = null;
let engHandle = null;
let workerHandle = null;
let fnVersion = null;
let fnAcquire = null;
let fnRelease = null;
let fnWorkerCreate = null;
let fnWorkerTrim = null;
let fnWorkerDestroy = null;
let fnRenderRGBA = null;
let fnRenderThumbRGBA = null;

// Lean 1-slot warm ArrayBuffer pool per worker with 5s idle auto-purge:
// avoids Windows 4KB page-fault storms during continuous scrolling while returning to 0 MB when idle!
const MAX_POOL_BUFFERS = 1;
const POOL_IDLE_MS = 5000;
const bufferPool = [];
let poolPurgeTimer = null;

function clearPoolPurgeTimer() {
  if (poolPurgeTimer !== null) {
    clearTimeout(poolPurgeTimer);
    poolPurgeTimer = null;
  }
}

function schedulePoolPurge() {
  clearPoolPurgeTimer();
  if (bufferPool.length === 0) return;
  poolPurgeTimer = setTimeout(() => {
    poolPurgeTimer = null;
    bufferPool.length = 0;
  }, POOL_IDLE_MS);
}

function acquireBuffer(byteLen) {
  for (let i = bufferPool.length - 1; i >= 0; i--) {
    if (bufferPool[i].byteLength === byteLen) {
      const buf = bufferPool[i];
      bufferPool.splice(i, 1);
      if (bufferPool.length === 0) clearPoolPurgeTimer();
      return buf;
    }
  }
  // Drop stale-size pooled buffers immediately so zoom/resize never pins dead 25MB buffers
  if (bufferPool.length > 0) {
    bufferPool.length = 0;
    clearPoolPurgeTimer();
  }
  return new ArrayBuffer(byteLen);
}

function releaseBuffer(buf) {
  if (!buf || !(buf instanceof ArrayBuffer)) return;
  const len = buf.byteLength;
  if (len <= 0 || len > 64 * 1024 * 1024) return;
  // Don't pool tiny thumbnail buffers so main-page HiDPI buffer stays warm
  if (len < 1024 * 1024) return;
  bufferPool.length = 0;
  bufferPool.push(buf);
  while (bufferPool.length > MAX_POOL_BUFFERS) {
    bufferPool.shift();
  }
  schedulePoolPurge();
}

function parseHexRGBInt(hexStr) {
  if (typeof hexStr !== "string") return -1;
  let s = hexStr.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  if (s.length !== 6) return -1;
  const v = parseInt(s, 16);
  return Number.isFinite(v) ? v : -1;
}

function initDLL(msg) {
  if (lib) {
    return { ok: true, mupdfVersion: fnVersion().readString() };
  }
  lib = ctypes.open(msg.dllPath);

  fnVersion = lib.declare("zot_dll_version", ctypes.default_abi, ctypes.char.ptr);
  fnAcquire = lib.declare(
    "zot_dll_engine_acquire",
    ctypes.default_abi,
    ctypes.voidptr_t,
    ctypes.int,
    ctypes.int,
    ctypes.int
  );
  fnRelease = lib.declare("zot_dll_engine_release", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
  fnWorkerCreate = lib.declare("zot_dll_worker_create", ctypes.default_abi, ctypes.voidptr_t, ctypes.voidptr_t);
  fnWorkerTrim = lib.declare("zot_dll_worker_trim", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
  fnWorkerDestroy = lib.declare("zot_dll_worker_destroy", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
  fnRenderRGBA = lib.declare(
    "zot_dll_render_rgba",
    ctypes.default_abi,
    ctypes.int,
    ctypes.voidptr_t, // eng
    ctypes.voidptr_t, // worker
    ctypes.int, // req_id
    ctypes.char.ptr, // path_utf8
    ctypes.char.ptr, // password_utf8
    ctypes.int, // page_index
    ctypes.int, // width
    ctypes.int, // height
    ctypes.float, // m0
    ctypes.float, // m1
    ctypes.float, // m2
    ctypes.float, // m3
    ctypes.float, // m4
    ctypes.float, // m5
    ctypes.int, // include_annots
    ctypes.int, // aa_level
    ctypes.int, // theme_enabled
    ctypes.int, // bg_rgb
    ctypes.int, // fg_rgb
    ctypes.int, // invert_images
    ctypes.voidptr_t, // out_rgba (JS ArrayBuffer directly!)
    ctypes.float.ptr, // out_stats[4]
    ctypes.char.ptr, // err_buf
    ctypes.int // err_cap
  );
  fnRenderThumbRGBA = lib.declare(
    "zot_dll_render_thumb_rgba",
    ctypes.default_abi,
    ctypes.int,
    ctypes.voidptr_t, // eng
    ctypes.voidptr_t, // worker
    ctypes.int, // req_id
    ctypes.char.ptr, // path_utf8
    ctypes.char.ptr, // password_utf8
    ctypes.int, // page_index
    ctypes.int, // target_w
    ctypes.int, // max_h
    ctypes.int, // aa_level
    ctypes.int, // theme_enabled
    ctypes.int, // bg_rgb
    ctypes.int, // fg_rgb
    ctypes.int, // invert_images
    ctypes.voidptr_t, // out_rgba
    ctypes.float.ptr, // out_stats[4]
    ctypes.char.ptr, // err_buf
    ctypes.int // err_cap
  );

  engHandle = fnAcquire(msg.storeMB || 96, msg.pixCacheMB || 96, msg.bgWorkers ?? 1);
  if (!engHandle || engHandle.isNull()) {
    lib.close();
    lib = null;
    throw new Error("zot_dll_engine_acquire returned NULL");
  }
  workerHandle = fnWorkerCreate(engHandle);
  if (!workerHandle || workerHandle.isNull()) {
    fnRelease(engHandle);
    engHandle = null;
    lib.close();
    lib = null;
    throw new Error("zot_dll_worker_create returned NULL");
  }

  return { ok: true, mupdfVersion: fnVersion().readString() };
}

function shutdownDLL() {
  clearPoolPurgeTimer();
  bufferPool.length = 0;
  try {
    if (workerHandle && fnWorkerDestroy) {
      fnWorkerDestroy(workerHandle);
      workerHandle = null;
    }
    if (engHandle && fnRelease) {
      fnRelease(engHandle);
      engHandle = null;
    }
    if (lib) {
      lib.close();
      lib = null;
    }
  } catch {}
}

const StatsArray = ctypes.float.array(4);
const ErrArray = ctypes.char.array(256);

self.onmessage = function (ev) {
  const msg = ev.data;
  if (!msg) return;

  if (msg.cmd === "recycle") {
    releaseBuffer(msg.buf);
    return;
  }

  if (msg.cmd === "trim") {
    clearPoolPurgeTimer();
    bufferPool.length = 0;
    try {
      if (workerHandle && fnWorkerTrim) {
        fnWorkerTrim(workerHandle);
      }
    } catch {}
    return;
  }

  if (msg.cmd === "init") {
    try {
      const info = initDLL(msg);
      self.postMessage({
        cmd: "init",
        id: msg.id,
        ok: true,
        mupdfVersion: info.mupdfVersion,
      });
    } catch (e) {
      self.postMessage({ cmd: "init", id: msg.id, ok: false, error: String(e?.message || e) });
    }
    return;
  }

  if (msg.cmd === "shutdown") {
    shutdownDLL();
    self.postMessage({ cmd: "shutdown", id: msg.id, ok: true });
    self.close();
    return;
  }

  if (msg.cmd === "thumb") {
    const { jobId, nativeReqId, path, password, pageIndex, targetW, maxH, aaLevel, theme } = msg;
    try {
      if (!lib || !engHandle || !workerHandle || !fnRenderThumbRGBA) {
        throw new Error("Native MuPDF thumbnail worker not initialized");
      }
      const tw = Math.max(32, Math.min(640, targetW | 0));
      const mh = Math.max(32, Math.min(1280, maxH | 0));
      const buf = new ArrayBuffer(tw * mh * 4);
      const stats = new StatsArray();
      const errBuf = new ErrArray();

      let themeEnabled = 0;
      let bgRgb = 0;
      let fgRgb = 0;
      let invertImages = 0;
      if (theme && theme.background && theme.foreground) {
        const bg = parseHexRGBInt(theme.background);
        const fg = parseHexRGBInt(theme.foreground);
        if (bg >= 0 && fg >= 0) {
          themeEnabled = 1;
          bgRgb = bg;
          fgRgb = fg;
          invertImages = theme.invertImages ? 1 : 0;
        }
      }

      const rc = fnRenderThumbRGBA(
        engHandle,
        workerHandle,
        nativeReqId | 0,
        String(path || ""),
        String(password || ""),
        pageIndex | 0,
        tw,
        mh,
        aaLevel || 4,
        themeEnabled,
        bgRgb,
        fgRgb,
        invertImages,
        buf,
        stats,
        errBuf,
        256
      );

      if (rc === 1) {
        self.postMessage({ cmd: "thumb", jobId, ok: false, isCancelled: true, error: "aborted" });
        return;
      }
      if (rc !== 0) {
        const errMsg = errBuf.readString() || `mupdf thumb error rc=${rc}`;
        self.postMessage({ cmd: "thumb", jobId, ok: false, isCancelled: false, error: errMsg });
        return;
      }

      const actualW = Math.round(stats[1]);
      const actualH = Math.round(stats[2]);
      self.postMessage(
        {
          cmd: "thumb",
          jobId,
          ok: true,
          width: actualW,
          height: actualH,
          aspect: stats[3] || actualW / Math.max(1, actualH),
          renderMs: stats[0],
          buf,
        },
        [buf]
      );
    } catch (e) {
      self.postMessage({
        cmd: "thumb",
        jobId,
        ok: false,
        isCancelled: false,
        error: String(e?.message || e),
      });
    }
    return;
  }

  if (msg.cmd === "render") {
    const {
      jobId,
      nativeReqId,
      path,
      password,
      pageIndex,
      width,
      height,
      matrix,
      includeAnnots,
      aaLevel,
      theme,
    } = msg;

    let buf = null;
    try {
      if (!lib || !engHandle || !workerHandle) {
        throw new Error("Native MuPDF worker not initialized");
      }

      const byteLen = width * height * 4;
      buf = acquireBuffer(byteLen);
      const stats = new StatsArray();
      const errBuf = new ErrArray();

      let themeEnabled = 0;
      let bgRgb = 0;
      let fgRgb = 0;
      let invertImages = 0;
      if (theme && theme.background && theme.foreground) {
        const bg = parseHexRGBInt(theme.background);
        const fg = parseHexRGBInt(theme.foreground);
        if (bg >= 0 && fg >= 0) {
          themeEnabled = 1;
          bgRgb = bg;
          fgRgb = fg;
          invertImages = theme.invertImages ? 1 : 0;
        }
      }

      const rc = fnRenderRGBA(
        engHandle,
        workerHandle,
        nativeReqId | 0,
        String(path || ""),
        String(password || ""),
        pageIndex | 0,
        width | 0,
        height | 0,
        matrix[0],
        matrix[1],
        matrix[2],
        matrix[3],
        matrix[4],
        matrix[5],
        includeAnnots ? 1 : 0,
        aaLevel || 8,
        themeEnabled,
        bgRgb,
        fgRgb,
        invertImages,
        buf,
        stats,
        errBuf,
        256
      );

      if (rc === 1) {
        releaseBuffer(buf);
        self.postMessage({ cmd: "render", jobId, ok: false, isCancelled: true, error: "aborted" });
        return;
      }
      if (rc !== 0) {
        releaseBuffer(buf);
        const errMsg = errBuf.readString() || `mupdf native error rc=${rc}`;
        self.postMessage({ cmd: "render", jobId, ok: false, isCancelled: false, error: errMsg });
        return;
      }

      const tierNum = Math.round(stats[1]);
      const cacheTier = tierNum === 2 ? "pix" : tierNum === 1 ? "dl" : "cold";

      // Zero-copy Transferable ArrayBuffer handoff straight back to Chrome (~0.5ms, NO 40ms createImageBitmap!)
      const outBuf = buf;
      buf = null;
      self.postMessage(
        {
          cmd: "render",
          jobId,
          ok: true,
          width,
          height,
          renderMs: stats[0],
          cacheTier,
          cacheHit: tierNum >= 1,
          pageW: stats[2],
          pageH: stats[3],
          buf: outBuf,
        },
        [outBuf]
      );
    } catch (e) {
      if (buf) releaseBuffer(buf);
      self.postMessage({
        cmd: "render",
        jobId,
        ok: false,
        isCancelled: false,
        error: String(e?.message || e),
      });
    }
  }
};
