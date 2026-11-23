/* global ctypes, self, TextDecoder */
"use strict";

const decoder = new TextDecoder("utf-8");

let lib = null;
let engHandle = null;
let fnVersion = null;
let fnEngineCreate = null;
let fnEngineDestroy = null;
let fnEngineTrim = null;
let fnEngineEvictPath = null;
let fnFreeBuf = null;
let fnPdfFulltext = null;
let fnPdfPageData = null;
let fnPdfOutline = null;
let fnPdfRecognizerData = null;
let fnPdfHasAnnots = null;
let fnOsTrimMemory = null;
let fnScanFiles = null;

function readUtf8AndFree(ptr, byteLen) {
  if (!ptr || ptr.isNull()) return null;
  try {
    if (byteLen <= 0) return "";
    // Fast C++ SpiderMonkey UTF-8 decode (~0.05ms vs 10-30ms JS byte loop over ctypes CData!).
    // All zot_turbo_* outputs are NUL-terminated StrBufs with embedded NUL stripped.
    try {
      const cptr = ctypes.cast(ptr, ctypes.char.ptr);
      if (typeof cptr.readStringReplaceMalformed === "function") {
        return cptr.readStringReplaceMalformed();
      }
      if (typeof cptr.readString === "function") {
        return cptr.readString();
      }
    } catch {}
    const byteArr = ctypes.cast(ptr, ctypes.uint8_t.array(byteLen).ptr).contents;
    const u8 = new Uint8Array(byteLen);
    for (let i = 0; i < byteLen; i++) {
      u8[i] = byteArr[i];
    }
    return decoder.decode(u8);
  } finally {
    try {
      fnFreeBuf(ptr);
    } catch {}
  }
}

function initDLL(msg) {
  if (lib && engHandle) {
    return { ok: true, version: fnVersion().readString() };
  }
  lib = ctypes.open(msg.dllPath);

  fnVersion = lib.declare("zot_turbo_version", ctypes.default_abi, ctypes.char.ptr);
  fnEngineCreate = lib.declare("zot_turbo_engine_create", ctypes.default_abi, ctypes.voidptr_t, ctypes.int);
  fnEngineDestroy = lib.declare("zot_turbo_engine_destroy", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
  fnEngineTrim = lib.declare("zot_turbo_engine_trim", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t, ctypes.int);
  fnEngineEvictPath = lib.declare(
    "zot_turbo_engine_evict_path",
    ctypes.default_abi,
    ctypes.void_t,
    ctypes.voidptr_t,
    ctypes.char.ptr
  );
  fnFreeBuf = lib.declare("zot_turbo_free_buf", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);

  fnPdfFulltext = lib.declare(
    "zot_turbo_pdf_fulltext",
    ctypes.default_abi,
    ctypes.voidptr_t,
    ctypes.voidptr_t, // eng
    ctypes.char.ptr, // utf8_path
    ctypes.int, // max_pages
    ctypes.int.ptr, // out_len
    ctypes.int.ptr, // out_extracted_pages
    ctypes.int.ptr, // out_total_pages
    ctypes.int.ptr // out_err
  );

  fnPdfPageData = lib.declare(
    "zot_turbo_pdf_page_data",
    ctypes.default_abi,
    ctypes.voidptr_t,
    ctypes.voidptr_t, // eng
    ctypes.char.ptr, // utf8_path
    ctypes.int, // page_index
    ctypes.int.ptr, // out_len
    ctypes.int.ptr // out_err
  );

  fnPdfOutline = lib.declare(
    "zot_turbo_pdf_outline",
    ctypes.default_abi,
    ctypes.voidptr_t,
    ctypes.voidptr_t, // eng
    ctypes.char.ptr, // utf8_path
    ctypes.int.ptr, // out_len
    ctypes.int.ptr // out_err
  );

  fnPdfRecognizerData = lib.declare(
    "zot_turbo_pdf_recognizer_data",
    ctypes.default_abi,
    ctypes.voidptr_t,
    ctypes.voidptr_t, // eng
    ctypes.char.ptr, // utf8_path
    ctypes.int, // max_pages
    ctypes.int.ptr, // out_len
    ctypes.int.ptr // out_err
  );

  fnPdfHasAnnots = lib.declare(
    "zot_turbo_pdf_has_annots",
    ctypes.default_abi,
    ctypes.int,
    ctypes.voidptr_t, // eng
    ctypes.char.ptr // utf8_path
  );

  fnOsTrimMemory = lib.declare(
    "zot_turbo_os_trim_memory",
    ctypes.default_abi,
    ctypes.void_t,
    ctypes.int // trim_working_set
  );

  fnScanFiles = lib.declare(
    "zot_turbo_scan_files",
    ctypes.default_abi,
    ctypes.voidptr_t,
    ctypes.char.ptr, // paths_newline_sep
    ctypes.char.ptr, // needle_utf8
    ctypes.int, // flags
    ctypes.int, // max_bytes_per_file
    ctypes.int, // num_threads
    ctypes.int.ptr, // out_len
    ctypes.int.ptr, // out_scanned_count
    ctypes.int.ptr // out_err
  );

  const storeMB = Math.max(8, Math.min(256, Number(msg.storeMB) || 48));
  engHandle = fnEngineCreate(storeMB);
  if (!engHandle || engHandle.isNull()) {
    throw new Error("zot_turbo_engine_create returned NULL");
  }

  return { ok: true, version: fnVersion().readString() };
}

function handleFulltext(msg) {
  if (!engHandle) throw new Error("Native engine not initialized");
  const outLen = ctypes.int(0);
  const outExtracted = ctypes.int(0);
  const outTotal = ctypes.int(0);
  const outErr = ctypes.int(0);
  const t0 = performance.now();
  const ptr = fnPdfFulltext(
    engHandle,
    String(msg.path || ""),
    Number(msg.maxPages) > 0 ? Number(msg.maxPages) : 0,
    outLen.address(),
    outExtracted.address(),
    outTotal.address(),
    outErr.address()
  );
  const errCode = outErr.value;
  if (!ptr || ptr.isNull() || errCode !== 0) {
    if (ptr && !ptr.isNull()) {
      try {
        fnFreeBuf(ptr);
      } catch {}
    }
    return {
      ok: false,
      errCode: errCode || -2,
      needsPassword: errCode === -3,
      ms: performance.now() - t0,
    };
  }
  const text = readUtf8AndFree(ptr, outLen.value);
  return {
    ok: true,
    text,
    extractedPages: outExtracted.value,
    totalPages: outTotal.value,
    ms: performance.now() - t0,
  };
}

function handlePageData(msg) {
  if (!engHandle) throw new Error("Native engine not initialized");
  const outLen = ctypes.int(0);
  const outErr = ctypes.int(0);
  const t0 = performance.now();
  const ptr = fnPdfPageData(
    engHandle,
    String(msg.path || ""),
    Number(msg.pageIndex) | 0,
    outLen.address(),
    outErr.address()
  );
  const errCode = outErr.value;
  if (!ptr || ptr.isNull() || errCode !== 0) {
    if (ptr && !ptr.isNull()) {
      try {
        fnFreeBuf(ptr);
      } catch {}
    }
    return {
      ok: false,
      errCode: errCode || -2,
      needsPassword: errCode === -3,
      ms: performance.now() - t0,
    };
  }
  const json = readUtf8AndFree(ptr, outLen.value);
  return {
    ok: true,
    json,
    ms: performance.now() - t0,
  };
}

function handleOutline(msg) {
  if (!engHandle) throw new Error("Native engine not initialized");
  const outLen = ctypes.int(0);
  const outErr = ctypes.int(0);
  const t0 = performance.now();
  const ptr = fnPdfOutline(engHandle, String(msg.path || ""), outLen.address(), outErr.address());
  const errCode = outErr.value;
  if (!ptr || ptr.isNull() || errCode !== 0) {
    if (ptr && !ptr.isNull()) {
      try { fnFreeBuf(ptr); } catch {}
    }
    return { ok: false, errCode: errCode || -2, noOutline: errCode === 1, ms: performance.now() - t0 };
  }
  const json = readUtf8AndFree(ptr, outLen.value);
  return { ok: true, json, ms: performance.now() - t0 };
}

function handleRecognizerData(msg) {
  if (!engHandle) throw new Error("Native engine not initialized");
  const outLen = ctypes.int(0);
  const outErr = ctypes.int(0);
  const t0 = performance.now();
  const ptr = fnPdfRecognizerData(
    engHandle,
    String(msg.path || ""),
    Number(msg.maxPages) > 0 ? Number(msg.maxPages) : 5,
    outLen.address(),
    outErr.address()
  );
  const errCode = outErr.value;
  if (!ptr || ptr.isNull() || errCode !== 0) {
    if (ptr && !ptr.isNull()) {
      try { fnFreeBuf(ptr); } catch {}
    }
    return { ok: false, errCode: errCode || -2, needsPassword: errCode === -3, ms: performance.now() - t0 };
  }
  const json = readUtf8AndFree(ptr, outLen.value);
  return { ok: true, json, ms: performance.now() - t0 };
}

function handleHasAnnots(msg) {
  if (!engHandle) throw new Error("Native engine not initialized");
  const t0 = performance.now();
  const rc = fnPdfHasAnnots(engHandle, String(msg.path || ""));
  const ms = performance.now() - t0;
  if (rc === 0 || rc === 1) {
    return { ok: true, hasAnnotations: rc === 1, ms };
  }
  return { ok: false, errCode: rc, needsPassword: rc === -3, ms };
}

function handleScanFiles(msg) {
  if (!lib) throw new Error("Native library not initialized");
  const outLen = ctypes.int(0);
  const outScanned = ctypes.int(0);
  const outErr = ctypes.int(0);
  const t0 = performance.now();
  const ptr = fnScanFiles(
    String(msg.pathsBlob || ""),
    String(msg.needle || ""),
    Number(msg.flags) | 0,
    Number(msg.maxBytes) > 0 ? Number(msg.maxBytes) : 500000,
    Number(msg.threads) > 0 ? Number(msg.threads) : 0,
    outLen.address(),
    outScanned.address(),
    outErr.address()
  );
  const errCode = outErr.value;
  if (!ptr || ptr.isNull() || errCode !== 0) {
    if (ptr && !ptr.isNull()) {
      try {
        fnFreeBuf(ptr);
      } catch {}
    }
    return {
      ok: false,
      errCode: errCode || -2,
      ms: performance.now() - t0,
    };
  }
  const json = readUtf8AndFree(ptr, outLen.value);
  return {
    ok: true,
    indicesJson: json,
    scanned: outScanned.value,
    ms: performance.now() - t0,
  };
}

function handleShutdown() {
  try {
    if (engHandle && fnEngineDestroy) {
      fnEngineDestroy(engHandle);
    }
  } catch {}
  engHandle = null;
  try {
    if (lib) lib.close();
  } catch {}
  lib = null;
  return { ok: true };
}

self.onmessage = function onWorkerMessage(ev) {
  const msg = ev.data;
  if (!msg || !msg.op) return;
  const id = msg.id;
  try {
    let result;
    switch (msg.op) {
      case "init":
        result = initDLL(msg);
        break;
      case "fulltext":
        result = handleFulltext(msg);
        break;
      case "pageData":
        result = handlePageData(msg);
        break;
      case "outline":
        result = handleOutline(msg);
        break;
      case "recognizerData":
        result = handleRecognizerData(msg);
        break;
      case "hasAnnots":
        result = handleHasAnnots(msg);
        break;
      case "scanFiles":
        result = handleScanFiles(msg);
        break;
      case "evictPath":
        if (engHandle && fnEngineEvictPath && msg.path) {
          fnEngineEvictPath(engHandle, String(msg.path));
        }
        result = { ok: true };
        break;
      case "trim":
        if (engHandle && fnEngineTrim) {
          fnEngineTrim(engHandle, msg.aggressive ? 1 : 0);
        }
        result = { ok: true };
        break;
      case "osTrim":
        if (fnOsTrimMemory) {
          fnOsTrimMemory(msg.trimWorkingSet ? 1 : 0);
        }
        result = { ok: true };
        break;
      case "shutdown":
        result = handleShutdown();
        break;
      default:
        throw new Error("Unknown op: " + msg.op);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};
