import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkForUpdate = vi.fn();
const downloadUpdate = vi.fn();
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  checkForUpdate: () => checkForUpdate(),
  downloadUpdate: () => downloadUpdate(),
}));

import {
  checkForUpdates,
  openUpdateDialog,
  refreshReadyUpdate,
  UPDATE_CHECK_LIMIT_MS,
} from "./useUpdater";
import { useUpdaterStore } from "../stores/updaterStore";

const info = (version: string) => ({ version, body: null, date: null });
const state = () => useUpdaterStore.getState();

function ready(version = "2.33.0") {
  state().setReady(version);
}

describe("an update is already downloaded and a newer one comes out", () => {
  beforeEach(() => {
    checkForUpdate.mockReset();
    downloadUpdate.mockReset();
    state().reset();
    useUpdaterStore.setState({ autoUpdate: true, skippedVersion: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the regular check still looks, and swaps the waiting download for the newer one", async () => {
    ready();
    checkForUpdate.mockResolvedValue(info("2.34.0"));
    downloadUpdate.mockResolvedValue(info("2.34.0"));

    await checkForUpdates();

    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(state().version).toBe("2.34.0");
    expect(state().phase).toBe("ready");
  });

  it("stays ready the whole time, so the footer pill never disappears", async () => {
    ready();
    checkForUpdate.mockResolvedValue(info("2.34.0"));
    let finish: (value: unknown) => void = () => {};
    downloadUpdate.mockReturnValue(new Promise((resolve) => (finish = resolve)));

    const run = refreshReadyUpdate();
    await vi.waitFor(() => expect(state().refresh).toBe("downloading"));
    state().addProgress(100, 1000);

    expect(state().phase).toBe("ready");
    expect(state().version).toBe("2.33.0");
    expect(state().refreshVersion).toBe("2.34.0");
    expect(state().progress).toEqual({ received: 100, total: 1000 });

    finish(info("2.34.0"));
    await run;
    expect(state().refresh).toBe("idle");
    expect(state().refreshVersion).toBeUndefined();
    expect(state().version).toBe("2.34.0");
  });

  it("does nothing when the waiting download is still the newest", async () => {
    ready("2.34.0");
    checkForUpdate.mockResolvedValue(info("2.34.0"));

    await checkForUpdates();

    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(state().version).toBe("2.34.0");
  });

  it("never swaps for an older version", async () => {
    ready("2.34.0");
    checkForUpdate.mockResolvedValue(info("2.33.0"));

    await checkForUpdates();

    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(state().version).toBe("2.34.0");
  });

  it("keeps what's downloaded when GitHub can't be reached", async () => {
    ready();
    checkForUpdate.mockRejectedValue("offline");

    await checkForUpdates();

    expect(state().phase).toBe("ready");
    expect(state().version).toBe("2.33.0");
    expect(state().refresh).toBe("idle");
    expect(state().error).toBeUndefined();
  });

  it("keeps what's downloaded when the newer download fails", async () => {
    ready();
    checkForUpdate.mockResolvedValue(info("2.34.0"));
    downloadUpdate.mockRejectedValue("connection reset");

    await checkForUpdates();

    expect(state().phase).toBe("ready");
    expect(state().version).toBe("2.33.0");
    expect(state().refresh).toBe("idle");
    expect(state().error).toBeUndefined();
  });

  it("stops waiting for a check that hangs", async () => {
    vi.useFakeTimers();
    ready();
    checkForUpdate.mockReturnValue(new Promise(() => {}));

    const run = refreshReadyUpdate();
    expect(state().refresh).toBe("checking");
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_LIMIT_MS);
    await run;

    expect(state().refresh).toBe("idle");
    expect(state().version).toBe("2.33.0");
  });

  it("doesn't start a second check while one is running", async () => {
    ready();
    checkForUpdate.mockReturnValue(new Promise(() => {}));

    void refreshReadyUpdate();
    void refreshReadyUpdate();

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("respects a skipped version, even when the user is about to install", async () => {
    ready();
    useUpdaterStore.setState({ skippedVersion: "2.34.0" });
    checkForUpdate.mockResolvedValue(info("2.34.0"));

    await refreshReadyUpdate({ explicit: true });

    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(state().version).toBe("2.33.0");
  });

  it("with automatic updates off, downloads only when the user is about to install", async () => {
    ready();
    useUpdaterStore.setState({ autoUpdate: false });
    checkForUpdate.mockResolvedValue(info("2.34.0"));
    downloadUpdate.mockResolvedValue(info("2.34.0"));

    await checkForUpdates();
    expect(downloadUpdate).not.toHaveBeenCalled();

    await refreshReadyUpdate({ explicit: true });
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(state().version).toBe("2.34.0");
  });

  it("opening the dialog looks for a newer version right away", async () => {
    ready();
    checkForUpdate.mockResolvedValue(info("2.34.0"));
    downloadUpdate.mockResolvedValue(info("2.34.0"));

    openUpdateDialog();

    expect(state().dialogOpen).toBe(true);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(state().version).toBe("2.34.0"));
  });
});
