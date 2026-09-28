#!/usr/bin/env node
// Stages ONNX Runtime + the MSVC C++ runtime into src-tauri/ort/ so Tauri can bundle
// them next to nexq.exe (see bundle.resources in tauri.conf.json).
//
// Why a DLL instead of the `ort` crate's prebuilt static library: that static build
// is compiled with BMI2/AVX2 code in shared STL functions, which crashed NexQ at
// launch (0xC000001D) on CPUs / x64 emulators without those extensions (issue #6).
// Microsoft's official onnxruntime.dll does runtime CPU dispatch and is only loaded
// when a local ONNX model is actually used.
//
// The official DLL links the dynamic MSVC runtime. We ship msvcp140/vcruntime140
// app-local because the installer skips vc_redist when *any* version is present, and
// binaries built with recent MSVC crash against an older system msvcp140.dll.
//
// Idempotent: skips the download when the staged files already match.

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Must be >= the ONNX Runtime minor version the `ort` crate targets (ort 2.0.0-rc.12 → 1.24).
const ORT_VERSION = "1.24.2";
const ORT_ZIP_URL = `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-win-x64-${ORT_VERSION}.zip`;
const ORT_ZIP_SHA256 = "8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0";
const VC_RUNTIME_DLLS = ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "ort");
const stampPath = join(outDir, ".version");

if (process.platform !== "win32") {
  console.log("[fetch-onnxruntime] not on Windows — skipping");
  process.exit(0);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function stageOnnxRuntime() {
  const dllPath = join(outDir, "onnxruntime.dll");
  if (existsSync(dllPath) && existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === ORT_VERSION) {
    console.log(`[fetch-onnxruntime] onnxruntime.dll ${ORT_VERSION} already staged`);
    return;
  }
  return (async () => {
    console.log(`[fetch-onnxruntime] downloading ${ORT_ZIP_URL}`);
    const res = await fetch(ORT_ZIP_URL);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    const actual = sha256(zip);
    if (actual !== ORT_ZIP_SHA256) {
      throw new Error(`checksum mismatch for ${ORT_ZIP_URL}\n  expected ${ORT_ZIP_SHA256}\n  got      ${actual}`);
    }
    const tmp = mkdtempSync(join(tmpdir(), "nexq-ort-"));
    try {
      const zipPath = join(tmp, "ort.zip");
      writeFileSync(zipPath, zip);
      // Windows' bsdtar extracts zip archives; call it by full path so a GNU tar
      // from Git Bash / MSYS on PATH (which can't) isn't picked up instead.
      const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      execFileSync(tar, ["-xf", zipPath, "-C", tmp], { stdio: "inherit" });
      copyFileSync(join(tmp, `onnxruntime-win-x64-${ORT_VERSION}`, "lib", "onnxruntime.dll"), dllPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    writeFileSync(stampPath, ORT_VERSION + "\n");
    console.log(`[fetch-onnxruntime] staged onnxruntime.dll ${ORT_VERSION}`);
  })();
}

/** Newest Microsoft.VC14x.CRT folder from the installed Visual Studio / Build Tools. */
function findVcRedistDir() {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) return null;
  const installs = execFileSync(vswhere, ["-products", "*", "-property", "installationPath"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  const candidates = [];
  for (const install of installs) {
    const msvc = join(install, "VC", "Redist", "MSVC");
    if (!existsSync(msvc)) continue;
    for (const ver of readdirSync(msvc).filter((v) => /^\d+\.\d+\.\d+$/.test(v))) {
      const x64 = join(msvc, ver, "x64");
      if (!existsSync(x64)) continue;
      const crt = readdirSync(x64).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d));
      if (crt) candidates.push({ ver, dir: join(x64, crt) });
    }
  }
  const cmp = (a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  };
  candidates.sort((a, b) => cmp(b.ver, a.ver));
  return candidates[0] ?? null;
}

function stageVcRuntime() {
  const redist = findVcRedistDir();
  if (!redist) {
    throw new Error("MSVC redistributable folder not found (install Visual Studio Build Tools with the C++ workload)");
  }
  for (const dll of VC_RUNTIME_DLLS) {
    const src = join(redist.dir, dll);
    const dst = join(outDir, dll);
    if (existsSync(dst) && sha256(readFileSync(dst)) === sha256(readFileSync(src))) continue;
    copyFileSync(src, dst);
  }
  console.log(`[fetch-onnxruntime] staged MSVC runtime ${redist.ver}`);
}

mkdirSync(outDir, { recursive: true });
try {
  await stageOnnxRuntime();
  stageVcRuntime();
} catch (e) {
  console.error(`[fetch-onnxruntime] ${e.message}`);
  process.exit(1);
}
