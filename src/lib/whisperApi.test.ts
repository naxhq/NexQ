import { beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ has: vi.fn() }));
vi.mock("./ipc", () => ({ hasApiKey: (p: string) => ipc.has(p) }));

import { hasSttCredential, isCustomWhisperEndpoint, isInsecureRemoteHttp, isValidWhisperBaseUrl, isWhisperApiConfigured } from "./whisperApi";

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

it("does not count a custom server key alone as configured", async () => {
  ipc.has.mockImplementation(async (p: string) => p === "whisper_api_custom_key");
  expect(await hasSttCredential("whisper_api")).toBe(false);
});

it("flags http endpoints on other machines only", () => {
  expect(isInsecureRemoteHttp("http://192.168.1.20:8000/v1")).toBe(true);
  expect(isInsecureRemoteHttp("http://speech.example.com/v1")).toBe(true);
  expect(isInsecureRemoteHttp("http://localhost:8000/v1")).toBe(false);
  expect(isInsecureRemoteHttp("http://127.0.0.1:8000/v1")).toBe(false);
  expect(isInsecureRemoteHttp("http://[::1]:8000/v1")).toBe(false);
  expect(isInsecureRemoteHttp("https://speech.example.com/v1")).toBe(false);
  expect(isInsecureRemoteHttp("")).toBe(false);
});

it("recognizes a custom endpoint like the backend does", () => {
  expect(isCustomWhisperEndpoint("")).toBe(false);
  expect(isCustomWhisperEndpoint("   ")).toBe(false);
  expect(isCustomWhisperEndpoint("https://api.openai.com/v1")).toBe(false);
  expect(isCustomWhisperEndpoint(" HTTPS://API.OpenAI.com/v1/ ")).toBe(false);
  expect(isCustomWhisperEndpoint("https://api.openai.com/v1/audio/transcriptions")).toBe(false);
  expect(isCustomWhisperEndpoint("https://api.openai.com/v1/audio/transcriptions/")).toBe(false);
  expect(isCustomWhisperEndpoint("http://127.0.0.1:8000/v1")).toBe(true);
  expect(isCustomWhisperEndpoint("http://127.0.0.1:8000/v1/audio/transcriptions")).toBe(true);
  expect(isCustomWhisperEndpoint("https://api.openai.com/v2")).toBe(true);
});
