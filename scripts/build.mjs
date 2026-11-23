import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NATIVE_DIR = path.join(ROOT, "native");
const PLUGIN_DIR = path.join(ROOT, "plugin");
const BIN_DIR = path.join(PLUGIN_DIR, "bin");
const DIST_DIR = path.join(ROOT, "dist");

const args = new Set(process.argv.slice(2));
const NATIVE_ONLY = args.has("--native-only");
const PACK_ONLY = args.has("--pack-only");

function resolveMuPDFDirs() {
  const siblingMuPDF = path.resolve(ROOT, "..", "zotero-mupdf-engine", "engine", "third_party", "mupdf");
  const localMuPDF = path.join(ROOT, "third_party", "mupdf");
  const incDir =
    process.env.MUPDF_INC_DIR ||
    (fs.existsSync(path.join(localMuPDF, "include"))
      ? path.join(localMuPDF, "include")
      : path.join(siblingMuPDF, "include"));
  const libDir =
    process.env.MUPDF_LIB_DIR ||
    (fs.existsSync(path.join(localMuPDF, "libs"))
      ? path.join(localMuPDF, "libs")
      : path.join(siblingMuPDF, "libs"));
  return { incDir, libDir };
}

const NATIVE_SOURCES = [
  path.join(NATIVE_DIR, "mupdf_render.c"),
  path.join(NATIVE_DIR, "zot_dll.c"),
  path.join(NATIVE_DIR, "zot_turbo.c"),
];

function buildWindowsX64() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const gccDir = process.env.GCC_DIR || "";
  const gccExe = gccDir ? path.join(gccDir, "gcc.exe") : "gcc";
  const objdumpExe = gccDir ? path.join(gccDir, "objdump.exe") : "objdump";
  const dllOut = path.join(BIN_DIR, "zotero-turbo-native-win-x64.dll");
  const { incDir, libDir } = resolveMuPDFDirs();

  console.log(`[build] Compiling UNIFIED Zotero Turbo + MuPDF Render DLL (windows/x64)...`);
  const t0 = Date.now();
  execFileSync(
    gccExe,
    [
      "-shared",
      "-O2",
      "-s",
      `-I${incDir}`,
      `-I${NATIVE_DIR}`,
      ...NATIVE_SOURCES,
      `-L${libDir}`,
      "-lmupdf_windows_amd64",
      "-lmupdfthird_windows_amd64",
      "-lm",
      "-lcomdlg32",
      "-lgdi32",
      "-static-libgcc",
      "-Wl,--gc-sections",
      "-o",
      dllOut,
    ],
    { stdio: "inherit" }
  );
  const st = fs.statSync(dllOut);
  console.log(`[build] Built unified ${dllOut} (${(st.size / 1024 / 1024).toFixed(2)} MB) in ${Date.now() - t0} ms`);

  const dump = execFileSync(objdumpExe, ["-p", dllOut], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const imports = [...dump.matchAll(/DLL Name:\s+(\S+)/g)].map((m) => m[1]);
  const badImports = imports.filter(
    (n) => !/^(KERNEL32\.dll|api-ms-win-crt-.*\.dll|GDI32\.dll|COMDLG32\.dll|msvcrt\.dll)$/i.test(n)
  );
  if (badImports.length > 0) {
    throw new Error("Unexpected non-system DLL dependencies: " + badImports.join(", "));
  }
  console.log(`[verify] Unified DLL imports clean (${imports.length} Windows system DLLs only)`);

  // Run BOTH C test suites against the single unified DLL!
  for (const [srcName, exeName] of [
    ["test_dll.c", "test_dll.exe"],
    ["test_turbo.c", "test_turbo.exe"],
  ]) {
    const exeOut = path.join(NATIVE_DIR, exeName);
    execFileSync(gccExe, ["-O2", `-I${NATIVE_DIR}`, path.join(NATIVE_DIR, srcName), dllOut, "-o", exeOut], {
      stdio: "inherit",
    });
    console.log(`[verify] Running native C suite ${exeName}...`);
    execFileSync(exeOut, [], {
      stdio: "inherit",
      cwd: NATIVE_DIR,
      env: { ...process.env, PATH: `${BIN_DIR};${process.env.PATH || ""}` },
    });
    try {
      fs.unlinkSync(exeOut);
    } catch {}
  }
}

function buildMacOS() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const arch = (process.env.TARGET_ARCH || process.arch) === "arm64" ? "arm64" : "x64";
  const clangArch = arch === "arm64" ? "arm64" : "x86_64";
  const cc = process.env.CC || "clang";
  const libName = `zotero-turbo-native-darwin-${arch}.dylib`;
  const dylibOut = path.join(BIN_DIR, libName);
  const { incDir, libDir } = resolveMuPDFDirs();

  execFileSync(
    cc,
    [
      "-dynamiclib",
      "-O2",
      "-fPIC",
      "-fvisibility=hidden",
      "-arch",
      clangArch,
      `-I${incDir}`,
      `-I${NATIVE_DIR}`,
      ...NATIVE_SOURCES,
      path.join(libDir, "libmupdf.a"),
      path.join(libDir, "libmupdf-third.a"),
      "-lm",
      "-lpthread",
      "-Wl,-dead_strip",
      "-Wl,-exported_symbol,_zot_dll_*",
      "-Wl,-exported_symbol,_zot_turbo_*",
      "-install_name",
      `@rpath/${libName}`,
      "-o",
      dylibOut,
    ],
    { stdio: "inherit" }
  );
  execFileSync("strip", ["-x", dylibOut], { stdio: "inherit" });
  if (process.env.SKIP_NATIVE_TEST !== "1") {
    for (const [srcName, binName] of [
      ["test_dll.c", "test_dll"],
      ["test_turbo.c", "test_turbo"],
    ]) {
      const binOut = path.join(NATIVE_DIR, binName);
      execFileSync(
        cc,
        ["-O2", "-arch", clangArch, `-I${NATIVE_DIR}`, path.join(NATIVE_DIR, srcName), dylibOut, `-Wl,-rpath,${BIN_DIR}`, "-lpthread", "-o", binOut],
        { stdio: "inherit" }
      );
      execFileSync(binOut, [], { stdio: "inherit", cwd: NATIVE_DIR });
      try { fs.unlinkSync(binOut); } catch {}
    }
  }
}

function buildLinuxX64() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const cc = process.env.CC || "gcc";
  const soName = "zotero-turbo-native-linux-x64.so";
  const soOut = path.join(BIN_DIR, soName);
  const { incDir, libDir } = resolveMuPDFDirs();

  execFileSync(
    cc,
    [
      "-shared",
      "-O2",
      "-s",
      "-fPIC",
      "-fvisibility=hidden",
      `-I${incDir}`,
      `-I${NATIVE_DIR}`,
      ...NATIVE_SOURCES,
      path.join(libDir, "libmupdf.a"),
      path.join(libDir, "libmupdf-third.a"),
      "-lm",
      "-lpthread",
      "-Wl,--gc-sections",
      "-Wl,--exclude-libs,ALL",
      "-o",
      soOut,
    ],
    { stdio: "inherit" }
  );
  if (process.env.SKIP_NATIVE_TEST !== "1") {
    for (const [srcName, binName] of [
      ["test_dll.c", "test_dll"],
      ["test_turbo.c", "test_turbo"],
    ]) {
      const binOut = path.join(NATIVE_DIR, binName);
      execFileSync(
        cc,
        ["-O2", `-I${NATIVE_DIR}`, path.join(NATIVE_DIR, srcName), soOut, `-Wl,-rpath,${BIN_DIR}`, "-lpthread", "-o", binOut],
        { stdio: "inherit" }
      );
      execFileSync(binOut, [], { stdio: "inherit", cwd: NATIVE_DIR });
      try { fs.unlinkSync(binOut); } catch {}
    }
  }
}

function packXPI() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
  const xpiName = `zotero-turbo-${manifest.version}.xpi`;
  const xpiPath = path.join(DIST_DIR, xpiName);
  if (fs.existsSync(xpiPath)) fs.unlinkSync(xpiPath);

  if (process.platform === "win32") {
    const psCmd = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = '${PLUGIN_DIR.replace(/'/g, "''")}'
$dst = '${xpiPath.replace(/'/g, "''")}'
$zip = [System.IO.Compression.ZipFile]::Open($dst, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}
`;
    execFileSync("pwsh", ["-NoProfile", "-Command", psCmd], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-r", "-9", xpiPath, "."], { cwd: PLUGIN_DIR, stdio: "inherit" });
  }
  const st = fs.statSync(xpiPath);
  console.log(`[pack] Built ${xpiPath} (${(st.size / 1024 / 1024).toFixed(2)} MB)`);
}

if (!PACK_ONLY) {
  if (process.platform === "win32") buildWindowsX64();
  else if (process.platform === "darwin") buildMacOS();
  else if (process.platform === "linux") buildLinuxX64();
  else throw new Error("Unsupported platform: " + process.platform);
}
if (!NATIVE_ONLY) {
  packXPI();
}
