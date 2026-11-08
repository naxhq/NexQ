import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JavaScript build script
import { fetchWithRetry } from "./fetch-retry.mjs";

const response = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;
const noWait = () => Promise.resolve();

describe("fetchWithRetry", () => {
  it("tries again after a gateway timeout and returns the answer that worked", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(504))
      .mockResolvedValueOnce(response(502))
      .mockResolvedValueOnce(response(200));
    const res = await fetchWithRetry("https://x/file", { fetchImpl, sleep: noWait });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("tries again after a network error", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response(200));
    const res = await fetchWithRetry("https://x/file", { fetchImpl, sleep: noWait });
    expect(res.status).toBe(200);
  });

  it("doesn't retry an answer that won't change, like a missing file", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(404));
    await expect(fetchWithRetry("https://x/file", { fetchImpl, sleep: noWait })).rejects.toThrow(
      "download failed: HTTP 404",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt with the last error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(504));
    await expect(
      fetchWithRetry("https://x/file", { fetchImpl, sleep: noWait, attempts: 4 }),
    ).rejects.toThrow("download failed: HTTP 504 (4 attempts)");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("waits longer before each new attempt", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(response(503));
    await expect(fetchWithRetry("https://x/file", { fetchImpl, sleep, attempts: 4, delayMs: 1000 })).rejects.toThrow();
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  });
});
