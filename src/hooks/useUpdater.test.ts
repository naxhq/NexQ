import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const listeners = new Map<string, Set<Handler>>();
const emitted: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
  emit: async (name: string) => {
    emitted.push(name);
  },
}));

const confirm = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirm(...args),
}));

const installUpdateNow = vi.fn();
vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  installUpdateNow: () => installUpdateNow(),
}));

const windowLabel = vi.hoisted(() => ({ value: "launcher" }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: windowLabel.value }),
}));

import { endMeetingFromThisWindow, restartToUpdate, MEETING_END_TIMEOUT_MS } from "./useUpdater";
import { useMeetingStore } from "../stores/meetingStore";
import { useToastStore } from "../stores/toastStore";
import { useUpdaterStore } from "../stores/updaterStore";

function windowEnded(window: string) {
  listeners.get("nexq:meeting_ended")?.forEach((cb) => cb({ payload: { window } }));
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("restartToUpdate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    emitted.length = 0;
    confirm.mockReset();
    installUpdateNow.mockReset();
    installUpdateNow.mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
    useMeetingStore.setState({ activeMeeting: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("installs right away when no meeting is active", async () => {
    await restartToUpdate();

    expect(confirm).not.toHaveBeenCalled();
    expect(installUpdateNow).toHaveBeenCalledTimes(1);
  });

  it("during a demo leaves the demo and installs, without a confirm or waiting on windows", async () => {
    const { useDemoStore } = await import("../demo/demoStore");
    useDemoStore.getState().activate("live-interview", "play");
    useMeetingStore.setState({ activeMeeting: { id: "demo-meeting" } as never });

    await restartToUpdate();

    expect(confirm).not.toHaveBeenCalled();
    expect(emitted).not.toContain("tray_stop_meeting");
    expect(useDemoStore.getState().isDemoActive).toBe(false);
    expect(installUpdateNow).toHaveBeenCalledTimes(1);
  });

  it("a stop request during a demo still reports this window as done", async () => {
    const { useDemoStore } = await import("../demo/demoStore");
    useDemoStore.getState().activate("live-interview", "play");
    useMeetingStore.setState({ activeMeeting: { id: "demo-meeting" } as never });

    await useMeetingStore.getState().endMeetingFlow();
    await flush();

    expect(useDemoStore.getState().isDemoActive).toBe(false);
    expect(emitted).toContain("nexq:meeting_ended");
  });

  it("does nothing when the user cancels the meeting prompt", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(false);

    await restartToUpdate();

    expect(emitted).not.toContain("tray_stop_meeting");
    expect(installUpdateNow).not.toHaveBeenCalled();
  });

  it("ends the meeting in every window before installing", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(true);

    const run = restartToUpdate();
    await flush();
    expect(emitted).toContain("tray_stop_meeting");

    windowEnded("launcher");
    await flush();
    expect(installUpdateNow).not.toHaveBeenCalled();

    windowEnded("overlay");
    await run;
    expect(installUpdateNow).toHaveBeenCalledTimes(1);
  });

  it("aborts the install and warns if a window doesn't finish ending the meeting", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(true);

    const run = restartToUpdate();
    await flush();
    windowEnded("launcher");
    await vi.advanceTimersByTimeAsync(MEETING_END_TIMEOUT_MS);
    await run;

    expect(installUpdateNow).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some((t) => t.type === "error")).toBe(true);
  });
});

describe("restartToUpdate: the installing flag (other notices stay away)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    emitted.length = 0;
    confirm.mockReset();
    installUpdateNow.mockReset().mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
    useMeetingStore.setState({ activeMeeting: null });
    useUpdaterStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is on while the install runs, and stays on once it was handed to the installer", async () => {
    let release: () => void = () => {};
    installUpdateNow.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    const run = restartToUpdate();
    await flush();
    expect(useUpdaterStore.getState().installing).toBe(true);
    release();
    await run;
    expect(useUpdaterStore.getState().installing).toBe(true);
  });

  it("is on while a running meeting is ended, so its end event can't raise a notice", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(true);
    const run = restartToUpdate();
    await flush();
    expect(useUpdaterStore.getState().installing).toBe(true);
    windowEnded("launcher");
    windowEnded("overlay");
    await run;
  });

  it("goes off when the user cancels", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(false);
    await restartToUpdate();
    expect(useUpdaterStore.getState().installing).toBe(false);
  });

  it("goes off when the meeting could not be saved", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never });
    confirm.mockResolvedValue(true);
    const run = restartToUpdate();
    await flush();
    await vi.advanceTimersByTimeAsync(MEETING_END_TIMEOUT_MS);
    await run;
    expect(useUpdaterStore.getState().installing).toBe(false);
  });

  it("goes off when the install fails", async () => {
    installUpdateNow.mockRejectedValue(new Error("disk full"));
    await restartToUpdate();
    expect(useUpdaterStore.getState().installing).toBe(false);
  });
});

describe("endMeetingFromThisWindow", () => {
  const endMeetingFlow = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    emitted.length = 0;
    endMeetingFlow.mockReset().mockResolvedValue(undefined);
    windowLabel.value = "launcher";
    useMeetingStore.setState({ activeMeeting: null, overlayMeetingId: null, endMeetingFlow } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("from the launcher, ends through every window when the overlay holds the meeting", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, overlayMeetingId: "m1" });

    let ended: boolean | undefined;
    const run = endMeetingFromThisWindow().then((ok) => (ended = ok));
    await flush();
    expect(emitted).toContain("tray_stop_meeting");
    expect(endMeetingFlow).not.toHaveBeenCalled(); // the launcher runs it from tray_stop_meeting

    windowEnded("launcher");
    await flush();
    expect(ended).toBeUndefined(); // still waiting for the overlay to save

    windowEnded("overlay");
    await run;
    expect(ended).toBe(true);
  });

  it("reports failure when the overlay never finishes", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, overlayMeetingId: "m1" });
    const run = endMeetingFromThisWindow();
    await flush();
    windowEnded("launcher");
    await vi.advanceTimersByTimeAsync(MEETING_END_TIMEOUT_MS);
    expect(await run).toBe(false);
  });

  it("from the launcher, ends by itself when no overlay took the meeting", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, overlayMeetingId: null });
    expect(await endMeetingFromThisWindow()).toBe(true);
    expect(endMeetingFlow).toHaveBeenCalledTimes(1);
    expect(emitted).not.toContain("tray_stop_meeting");
  });

  it("the overlay ends by itself", async () => {
    windowLabel.value = "overlay";
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as never, overlayMeetingId: "m1" });
    expect(await endMeetingFromThisWindow()).toBe(true);
    expect(endMeetingFlow).toHaveBeenCalledTimes(1);
    expect(emitted).not.toContain("tray_stop_meeting");
  });

  it("does nothing without a meeting", async () => {
    expect(await endMeetingFromThisWindow()).toBe(true);
    expect(endMeetingFlow).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });
});
