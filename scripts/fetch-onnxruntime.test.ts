// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JavaScript build script
import { ORT_VERSION, downloadRuntimeArchive, extractArchiveMember, extractionPlan, isEntryPoint } from "./fetch-onnxruntime.mjs";

const primaryUrl = "https://example.test/onnxruntime.zip";
const fallbackUrl = "https://example.test/microsoft.ml.onnxruntime.nupkg";
const primaryArchive = "GitHub release archive";
const fallbackArchive = "Microsoft NuGet archive";
const checksum = (data: string) => createHash("sha256").update(data).digest("hex");
const archives = {
  primary: { url: primaryUrl, sha256: checksum(primaryArchive) },
  fallback: { url: fallbackUrl, sha256: checksum(fallbackArchive) },
};

describe("downloadRuntimeArchive", () => {
  it("uses the verified primary release when it is available", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(primaryArchive));

    const download = await downloadRuntimeArchive({ ...archives, fetchImpl });

    expect(download).toEqual({ bytes: Buffer.from(primaryArchive), source: "primary" });
    expect(fetchImpl.mock.calls).toEqual([[primaryUrl]]);
  });

  it.each(["download failed: HTTP 404", "download failed: fetch failed (5 attempts)"])(
    "uses the verified fallback after a primary download error (%s)",
    async (error) => {
      const fetchImpl = vi.fn()
        .mockRejectedValueOnce(new Error(error))
        .mockResolvedValueOnce(new Response(fallbackArchive));

      const download = await downloadRuntimeArchive({ ...archives, fetchImpl });

      expect(download).toEqual({ bytes: Buffer.from(fallbackArchive), source: "fallback" });
      expect(fetchImpl.mock.calls).toEqual([[primaryUrl], [fallbackUrl]]);
    },
  );

  it("fails closed when the primary archive has the wrong checksum", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("unexpected data"));

    await expect(downloadRuntimeArchive({ ...archives, fetchImpl })).rejects.toThrow(/checksum mismatch/i);
    expect(fetchImpl.mock.calls).toEqual([[primaryUrl]]);
  });

  it("fails closed when the fallback archive has the wrong checksum", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("download failed: HTTP 404"))
      .mockResolvedValueOnce(new Response("unexpected data"));

    await expect(downloadRuntimeArchive({ ...archives, fetchImpl })).rejects.toThrow(/checksum mismatch/i);
    expect(fetchImpl.mock.calls).toEqual([[primaryUrl], [fallbackUrl]]);
  });

  it("names both failures when neither source can be downloaded", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("download failed: HTTP 404"))
      .mockRejectedValueOnce(new Error("download failed: fetch failed (5 attempts)"));

    const failure = await downloadRuntimeArchive({ ...archives, fetchImpl }).catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(primaryUrl);
    expect(message).toContain("HTTP 404");
    expect(message).toContain(fallbackUrl);
    expect(message).toContain("fetch failed (5 attempts)");
  });
});

describe("extractionPlan", () => {
  it.each([
    ["win32", "primary", { archiveName: "ort.zip", member: `onnxruntime-win-x64-${ORT_VERSION}/lib/onnxruntime.dll`, format: "zip" }],
    ["win32", "fallback", { archiveName: "ort.nupkg", member: "runtimes/win-x64/native/onnxruntime.dll", format: "zip" }],
    ["darwin", "primary", { archiveName: "ort.tgz", member: `onnxruntime-osx-arm64-${ORT_VERSION}/lib/libonnxruntime.${ORT_VERSION}.dylib`, format: "tgz" }],
    ["darwin", "fallback", { archiveName: "ort.nupkg", member: "runtimes/osx-arm64/native/libonnxruntime.dylib", format: "zip" }],
  ])("plans the %s %s source", (platform, source, plan) => {
    expect(extractionPlan(platform, source)).toEqual(plan);
  });

  it("refuses a platform without a source", () => {
    expect(() => extractionPlan("linux", "primary")).toThrow(/linux/);
  });
});

describe("extractArchiveMember", () => {
  it.each([
    ["win32", "zip", "runtimes/win-x64/native/onnxruntime.dll", "-xf"],
    ["darwin", "zip", "runtimes/osx-arm64/native/libonnxruntime.dylib", "-xf"],
    ["darwin", "tgz", "onnxruntime-osx-arm64-1.24.2/lib/libonnxruntime.1.24.2.dylib", "-xzf"],
  ])("extracts one %s library from a %s archive", (platform, format, member, flag) => {
    const tmp = mkdtempSync(join(tmpdir(), "nexq-ort-test-"));
    const archivePath = join(tmp, "archive");
    const destination = join(tmp, "staged-library");
    const execFileSyncImpl = vi.fn(() => {
      const extracted = join(tmp, ...member.split("/"));
      mkdirSync(dirname(extracted), { recursive: true });
      writeFileSync(extracted, "native runtime");
    });

    try {
      extractArchiveMember({ archivePath, destination, member, format, platform, extractionDir: tmp, execFileSyncImpl });
      const tar = platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";
      expect(execFileSyncImpl).toHaveBeenCalledExactlyOnceWith(
        tar, [flag, archivePath, "-C", tmp, member], { stdio: "inherit" },
      );
      expect(readFileSync(destination, "utf8")).toBe("native runtime");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("needs to be told where to extract", () => {
    expect(() =>
      extractArchiveMember({ archivePath: "a.zip", destination: "out", member: "m", format: "zip", platform: "win32" }),
    ).toThrow(/extractionDir/);
  });

  // Real tar.exe, real zip: the same shape as the NuGet package.
  it.skipIf(process.platform !== "win32")("extracts a library from a real zip with Windows' tar", () => {
    const { member } = extractionPlan("win32", "fallback");
    const tmp = mkdtempSync(join(tmpdir(), "nexq-ort-test-"));
    try {
      const source = join(tmp, "source");
      const extractionDir = join(tmp, "extracted");
      mkdirSync(join(source, ...dirname(member).split("/")), { recursive: true });
      mkdirSync(extractionDir);
      writeFileSync(join(source, ...member.split("/")), "dummy dll bytes");
      const archivePath = join(tmp, "ort.nupkg.zip");
      const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      execFileSync(systemTar, ["-a", "-c", "-f", archivePath, "-C", source, member]);

      const destination = join(tmp, "onnxruntime.dll");
      extractArchiveMember({ archivePath, destination, member, format: "zip", platform: "win32", extractionDir });

      expect(readFileSync(destination, "utf8")).toBe("dummy dll bytes");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("running as a script", () => {
  const scriptPath = fileURLToPath(new URL("./fetch-onnxruntime.mjs", import.meta.url));
  const scriptUrl = pathToFileURL(scriptPath).href;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("is the entry point when node is started on it", () => {
    expect(isEntryPoint(scriptPath, scriptUrl)).toBe(true);
  });

  it("is the entry point when the path is spelled differently", () => {
    expect(isEntryPoint(join(dirname(scriptPath), "..", "scripts", "fetch-onnxruntime.mjs"), scriptUrl)).toBe(true);
    if (process.platform === "win32") {
      expect(isEntryPoint(scriptPath.replace(/^[A-Za-z]:/, (d) => d.toLowerCase()), scriptUrl)).toBe(true);
    }
  });

  it("is not the entry point when another script started or nothing did", () => {
    expect(isEntryPoint(join(dirname(scriptPath), "fetch-retry.mjs"), scriptUrl)).toBe(false);
    expect(isEntryPoint(join(dirname(scriptPath), "does-not-exist.mjs"), scriptUrl)).toBe(false);
    expect(isEntryPoint(undefined, scriptUrl)).toBe(false);
  });

  it("does nothing when imported", async () => {
    vi.resetModules();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = process.exitCode;

    await import("./fetch-onnxruntime.mjs");

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
  });
});
