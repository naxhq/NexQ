import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const checkForUpdate = vi.fn();
const downloadUpdate = vi.fn();
const installUpdateNow = vi.fn();
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  checkForUpdate: () => checkForUpdate(),
  downloadUpdate: () => downloadUpdate(),
  installUpdateNow: () => installUpdateNow(),
}));

const openExternal = vi.fn();
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (url: string) => openExternal(url),
}));

vi.mock("../lib/version", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/version")>()),
  NEXQ_VERSION: "2.32.0",
}));

import { UpdateDialog } from "./UpdateDialog";
import { UpdateReadyToast } from "./UpdateToast";
import { UpdatePill } from "./ServiceStatusBar";
import { useUpdaterStore } from "../stores/updaterStore";
import { useMeetingStore } from "../stores/meetingStore";

const CHANGELOG = `# [2.35.0](https://x/compare) (2026-11-06)


### Features

* **modal:** the newest change ([aaa1111](https://x/commit))
# [2.34.0](https://x/compare) (2026-11-05)


### Bug Fixes

* **llm:** the custom endpoint shows its real error ([bbb2222](https://x/commit))


### Features

* **stt:** answers come as soon as the speaker finishes ([ccc3333](https://x/commit))
# [2.33.0](https://x/compare) (2026-11-04)


### Features

* **overlay:** Auto-Answer is off by default ([ddd4444](https://x/commit))
# [2.32.0](https://x/compare) (2026-11-04)


### Features

* **overlay:** already installed, must not show ([eee5555](https://x/commit))
`;

const info = (version: string) => ({ version, body: null, date: null });
const state = () => useUpdaterStore.getState();
const fetchMock = vi.fn();

function stubChangelog() {
  fetchMock.mockImplementation(async () => ({ ok: true, text: async () => CHANGELOG }));
}

function openWith(version = "2.34.0") {
  state().setReady(version);
  render(<UpdateDialog />);
  act(() => state().setDialogOpen(true));
}

describe("UpdateDialog", () => {
  beforeEach(() => {
    state().reset();
    useUpdaterStore.setState({ autoUpdate: true, skippedVersion: undefined });
    useMeetingStore.setState({ activeMeeting: null });
    checkForUpdate.mockReset().mockResolvedValue(null);
    downloadUpdate.mockReset();
    installUpdateNow.mockReset().mockResolvedValue(undefined);
    openExternal.mockReset().mockResolvedValue(undefined);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    stubChangelog();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is hidden until opened", () => {
    state().setReady("2.34.0");
    render(<UpdateDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows what's new in every version since the one running", async () => {
    openWith();

    expect(screen.getByRole("heading", { name: "2.34.0" })).toBeTruthy();
    await screen.findByText("Answers come as soon as the speaker finishes");
    expect(screen.getByText("The custom endpoint shows its real error")).toBeTruthy();
    expect(screen.getByText("Auto-Answer is off by default")).toBeTruthy();
    expect(screen.getByText(/2\.32\.0/)).toBeTruthy();
    expect(screen.queryByText("Already installed, must not show")).toBeNull();
    expect(screen.queryByText("The newest change")).toBeNull();
  });

  it("installs only when the install button is clicked", async () => {
    openWith();
    await screen.findByText("Answers come as soon as the speaker finishes");
    expect(installUpdateNow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /install/i }));

    await waitFor(() => expect(installUpdateNow).toHaveBeenCalledTimes(1));
  });

  it("can't install while a newer version is being fetched, then shows that version", async () => {
    let finish: (value: unknown) => void = () => {};
    downloadUpdate.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    checkForUpdate.mockResolvedValue(info("2.35.0"));
    state().setReady("2.34.0");
    render(<UpdateDialog />);

    const { openUpdateDialog } = await import("../hooks/useUpdater");
    act(() => openUpdateDialog());

    const button = await screen.findByRole("button", { name: /getting 2\.35\.0/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => finish(info("2.35.0")));

    expect(await screen.findByRole("heading", { name: "2.35.0" })).toBeTruthy();
    await screen.findByText("The newest change");
    const install = screen.getByRole("button", { name: /install/i }) as HTMLButtonElement;
    expect(install.disabled).toBe(false);
  });

  it("still offers the install when the notes can't be loaded", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    openWith();

    await screen.findByText(/couldn't load/i);
    fireEvent.click(screen.getByRole("button", { name: /install/i }));
    await waitFor(() => expect(installUpdateNow).toHaveBeenCalledTimes(1));
  });

  it("links to the full notes of the exact release", async () => {
    openWith();
    fireEvent.click(screen.getByRole("button", { name: /full release notes/i }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/naxhq/NexQ/releases/tag/v2.34.0");
  });

  it("Later closes it without installing and keeps the update ready", async () => {
    openWith();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installUpdateNow).not.toHaveBeenCalled();
    expect(state().phase).toBe("ready");
  });

  it("Escape closes it", async () => {
    openWith();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disappears if the version is skipped meanwhile", async () => {
    openWith();
    act(() => state().skip("2.34.0"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the ways into the dialog", () => {
  beforeEach(() => {
    state().reset();
    useUpdaterStore.setState({ autoUpdate: true, skippedVersion: undefined });
    checkForUpdate.mockReset().mockResolvedValue(null);
    installUpdateNow.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    stubChangelog();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the footer pill opens it and doesn't install", () => {
    state().setReady("2.34.0");
    render(<UpdatePill />);

    fireEvent.click(screen.getByRole("button", { name: /2\.34\.0/ }));

    expect(state().dialogOpen).toBe(true);
    expect(installUpdateNow).not.toHaveBeenCalled();
  });

  it("the ready notice opens it instead of leaving the app", () => {
    openExternal.mockReset();
    state().setReady("2.34.0");
    render(<UpdateReadyToast />);

    fireEvent.click(screen.getByRole("button", { name: /what's new/i }));

    expect(state().dialogOpen).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
