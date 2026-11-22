import { beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ has: vi.fn() }));
vi.mock("./ipc", () => ({ hasApiKey: (p: string) => ipc.has(p) }));

import { hasSttCredential, isValidWhisperBaseUrl, isWhisperApiConfigured } from "./whisperApi";

beforeEach(() => ipc.has.mockReset());

it("counts Whisper API as configured with a key or a base URL", () => {
  expect(isWhisperApiConfigured(false, false)).toBe(false);
  expect(isWhisperApiConfigured(true, false)).toBe(true);
  expect(isWhisperApiConfigured(false, true)).toBe(true);
});

it("treats a stored endpoint alone as a configured Whisper API", async () => {
  ipc.has.mockImplementation(async (p: string) => p === "whisper_api_base_url");
  expect(await hasSttCredential("whisper_api")).toBe(true);
});

it("reports Whisper API unconfigured with neither key nor endpoint", async () => {
  ipc.has.mockResolvedValue(false);
  expect(await hasSttCredential("whisper_api")).toBe(false);
});

it("leaves other providers on the plain key check", async () => {
  ipc.has.mockImplementation(async (p: string) => p === "deepgram_base_url");
  expect(await hasSttCredential("deepgram")).toBe(false);
  expect(ipc.has).toHaveBeenCalledTimes(1);
});

it("validates the endpoint scheme", () => {
  expect(isValidWhisperBaseUrl("")).toBe(true);
  expect(isValidWhisperBaseUrl("http://127.0.0.1:8000/v1")).toBe(true);
  expect(isValidWhisperBaseUrl("https://example.com")).toBe(true);
  expect(isValidWhisperBaseUrl("127.0.0.1:8000")).toBe(false);
  expect(isValidWhisperBaseUrl("ftp://x")).toBe(false);
});
