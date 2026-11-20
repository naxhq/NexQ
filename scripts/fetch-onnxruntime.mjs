// Stages the ONNX Runtime shared library into src-tauri/ort/ so Tauri can bundle
// it with the app (see bundle.resources in tauri.windows.conf.json / tauri.macos.conf.json).
//
// Why a shared library instead of the `ort` crate's prebuilt static build: that
// static build is compiled with BMI2/AVX2 code in shared STL functions, which
// crashed NexQ at launch (0xC000001D) on CPUs lacking those extensions (issue #6).
// Microsoft's official binary does runtime CPU dispatch and is only loaded when a
// local ONNX model is actually used.
//
// Windows also needs the dynamic MSVC runtime shipped app-local because the
// installer skips vc_redist when *any* version is present, and binaries built with
// recent MSVC crash against an older system msvcp140.dll.
//
// Where the library comes from: Microsoft's release archive on GitHub first. If
// that download fails (release downloads time out in bursts), Microsoft's official
// Microsoft.ML.OnnxRuntime package on NuGet is used instead. Both are checked
// against a pinned SHA-256, so a wrong or tampered archive is never staged.
//
// Idempotent: skips the download when the staged file already matches.

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { fetchWithRetry } from "./fetch-retry.mjs";

// Must be >= the ONNX Runtime minor version the `ort` crate targets (ort 2.0.0-rc.12 → 1.24).
// Changing it means new checksums for every archive below.
export const ORT_VERSION = "1.24.2";

const VC_RUNTIME_DLLS = ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

const RELEASE_URL = `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}`;
const NUGET_URL = `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${ORT_VERSION}/microsoft.ml.onnxruntime.${ORT_VERSION}.nupkg`;
// SHA-256 of the .nupkg file itself, not of the library inside it. Cross-check it
// against the package hash in the NuGet catalog entry for this version, and
// recompute it whenever ORT_VERSION changes.
const NUGET_SHA256 = "782564d3d68e87269ea1812cc94710ad06fe014faf093f01a6f89d0bd58719d3";

/**
 * Where each platform's library comes from: the primary archive and the NuGet
 * fallback, each with its checksum, the one archive member to extract and the
 * archive format. macOS: Microsoft publishes arm64 only for 1.24.2 (Apple Silicon).
 */
const SOURCES = {
  win32: {
    primary: {
      url: `${RELEASE_URL}/onnxruntime-win-x64-${ORT_VERSION}.zip`,
      sha256: "8e3e9c826375352e29cb2614fe44f3d7a4b0ff7b8028ad7a456af9d949a7e8b0",
      member: `onnxruntime-win-x64-${ORT_VERSION}/lib/onnxruntime.dll`,
      format: "zip",
    },
    fallback: {
      url: NUGET_URL,
      sha256: NUGET_SHA256,
      member: "runtimes/win-x64/native/onnxruntime.dll",
      format: "zip",
    },
  },
  darwin: {
    primary: {
      url: `${RELEASE_URL}/onnxruntime-osx-arm64-${ORT_VERSION}.tgz`,
      sha256: "0af4fa503e8ea285245b47ee42d0a7461b8156a81270857da0c1d4ecf858abde",
      member: `onnxruntime-osx-arm64-${ORT_VERSION}/lib/libonnxruntime.${ORT_VERSION}.dylib`,
      format: "tgz",
    },
    fallback: {
      url: NUGET_URL,
      sha256: NUGET_SHA256,
      member: "runtimes/osx-arm64/native/libonnxruntime.dylib",
      format: "zip", // a .nupkg is a zip
    },
  },
};

/** What to save the download as and which member of it to extract. Pure. */
export function extractionPlan(platform, source) {
  const entry = SOURCES[platform]?.[source];
  if (!entry) throw new Error(`no ONNX Runtime ${source} source for platform: ${platform}`);
  return {
    archiveName: source === "fallback" ? "ort.nupkg" : `ort.${entry.format}`,
    member: entry.member,
    format: entry.format,
  };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "ort");
const stampPath = join(outDir, ".version");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isCurrent = (fileName) =>
  existsSync(join(outDir, fileName)) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, "utf8").trim() === ORT_VERSION;

function verifyChecksum(url, buf, expectedSha) {
  const actual = sha256(buf);
  if (actual !== expectedSha) {
    throw new Error(`checksum mismatch for ${url}\n  expected ${expectedSha}\n  got      ${actual}`);
  }
  return buf;
}

async function downloadBytes(url, fetchImpl) {
  console.log(`[fetch-onnxruntime] downloading ${url}`);
  const response = await fetchImpl(url);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Download the primary archive, falling back to Microsoft's official NuGet package
 * only for transport/HTTP failures. A checksum mismatch is an integrity failure
 * and never falls back. Each source is `{ url, sha256 }`. When both sources fail
 * the error names both.
 */
export async function downloadRuntimeArchive({ primary, fallback, fetchImpl = fetchWithRetry }) {
  let primaryBytes;
  try {
    primaryBytes = await downloadBytes(primary.url, fetchImpl);
  } catch (primaryError) {
    console.warn(`[fetch-onnxruntime] primary download failed (${primaryError.message}); trying official NuGet package`);
    try {
      const fallbackBytes = await downloadBytes(fallback.url, fetchImpl);
      return { bytes: verifyChecksum(fallback.url, fallbackBytes, fallback.sha256), source: "fallback" };
    } catch (fallbackError) {
      throw new Error(
        "could not get ONNX Runtime from either source\n" +
          `  primary  ${primary.url}: ${primaryError.message}\n` +
          `  fallback ${fallback.url}: ${fallbackError.message}`,
        { cause: fallbackError },
      );
    }
  }
  // Verified outside the try, so a mismatch fails closed instead of falling back.
  return { bytes: verifyChecksum(primary.url, primaryBytes, primary.sha256), source: "primary" };
}

/** Extract one exact archive member using the system tar implementation. */
export function extractArchiveMember({ archivePath, destination, member, format, platform, extractionDir, execFileSyncImpl = execFileSync }) {
  if (!extractionDir) throw new Error("extractArchiveMember needs an extractionDir");
  // Use Windows' system bsdtar so Git Bash's GNU tar cannot intercept ZIP extraction.
  const tar = platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  const formatArgs = format === "tgz" ? ["-xzf"] : ["-xf"];
  execFileSyncImpl(tar, [...formatArgs, archivePath, "-C", extractionDir, member], { stdio: "inherit" });
  const extractedPath = join(extractionDir, ...member.split("/"));
  copyFileSync(extractedPath, destination);
}

/** Download the library for `platform` and extract it to `destination`. */
async function downloadAndExtract(platform, destination) {
  const { primary, fallback } = SOURCES[platform];
  const { bytes, source } = await downloadRuntimeArchive({ primary, fallback });
  const { archiveName, member, format } = extractionPlan(platform, source);
  const tmp = mkdtempSync(join(tmpdir(), "nexq-ort-"));
  try {
    const archivePath = join(tmp, archiveName);
    writeFileSync(archivePath, bytes);
    extractArchiveMember({ archivePath, destination, member, format, platform, extractionDir: tmp });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function stageWindows() {
  const dll = "onnxruntime.dll";
  if (isCurrent(dll)) {
    console.log(`[fetch-onnxruntime] ${dll} ${ORT_VERSION} already staged`);
  } else {
    await downloadAndExtract("win32", join(outDir, dll));
    writeFileSync(stampPath, ORT_VERSION + "\n");
    console.log(`[fetch-onnxruntime] staged ${dll} ${ORT_VERSION}`);
  }
  stageVcRuntime();
}

async function stageMac() {
  const dylib = "libonnxruntime.dylib";
  if (isCurrent(dylib)) {
    console.log(`[fetch-onnxruntime] ${dylib} ${ORT_VERSION} already staged`);
    return;
  }
  if (process.arch !== "arm64") {
    throw new Error(
      `Microsoft does not publish an x86_64 macOS ONNX Runtime for v${ORT_VERSION}. ` +
        "An Apple Silicon (arm64) Mac is required (or build without local ONNX features)."
    );
  }
  await downloadAndExtract("darwin", join(outDir, dylib));
  writeFileSync(stampPath, ORT_VERSION + "\n");
  console.log(`[fetch-onnxruntime] staged ${dylib} ${ORT_VERSION}`);
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

async function main() {
  mkdirSync(outDir, { recursive: true });
  try {
    if (process.platform === "win32") {
      await stageWindows();
    } else if (process.platform === "darwin") {
      await stageMac();
    } else {
      console.log(`[fetch-onnxruntime] ${process.platform} — skipping (no bundled ONNX Runtime)`);
    }
  } catch (e) {
    console.error(`[fetch-onnxruntime] ${e.message}`);
    process.exitCode = 1;
  }
}

/**
 * Whether this module was started as the script (`node scripts/fetch-onnxruntime.mjs`)
 * rather than imported. Compares file URLs first; if they differ in form only
 * (symlinks, drive-letter case), falls back to comparing real paths.
 */
export function isEntryPoint(argv1, moduleUrl) {
  if (!argv1) return false;
  if (pathToFileURL(argv1).href === moduleUrl) return true;
  try {
    return realpathSync.native(fileURLToPath(moduleUrl)) === realpathSync.native(argv1);
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  await main();
}
