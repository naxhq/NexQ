// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JavaScript build script
import { downloadRuntimeArchive, extractArchiveMember, getNugetRuntimeMember } from "./fetch-onnxruntime.mjs";

const primaryUrl = "https://example.test/onnxruntime.zip";
const fallbackUrl = "https://example.test/microsoft.ml.onnxruntime.nupkg";
const primaryArchive = "GitHub release archive";
const fallbackArchive = "Microsoft NuGet archive";
const checksum = (data: string) => createHash("sha256").update(data).digest("hex");
const archives = {
  primaryUrl,
  primarySha256: checksum(primaryArchive),
  fallbackUrl,
  fallbackSha256: checksum(fallbackArchive),
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
});

describe("getNugetRuntimeMember", () => {
  it.each([
    ["win32", "runtimes/win-x64/native/onnxruntime.dll"],
    ["darwin", "runtimes/osx-arm64/native/libonnxruntime.dylib"],
  ])("selects the native library for %s", (platform, member) => {
    expect(getNugetRuntimeMember(platform)).toBe(member);
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
      extractArchiveMember({ archivePath, destination, member, format, platform, execFileSyncImpl });
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
});
