import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Meeting } from "../lib/types";

const shortcuts = vi.hoisted(() => new Map<string, (event: { state: string }) => void>());
const captureFailure = vi.hoisted(() => ({ message: "" }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: async (key: string, handler: (event: { state: string }) => void) => { shortcuts.set(key, handler); },
  unregister: async (key: string) => { shortcuts.delete(key); },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
  emit: async () => {},
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "start_capture" && captureFailure.message) throw captureFailure.message;
    if (command === "start_meeting") {
      const meeting: Meeting = {
        id: "shortcut-meeting", title: "Shortcut meeting", start_time: "2026-10-24T00:00:00Z",
        end_time: null, duration_seconds: null, transcript: [], ai_interactions: [],
        summary: null, config_snapshot: null,
      };
      return JSON.stringify(meeting);
    }
    return null;
  },
}));

const stores: Array<{ getState: () => { stopTimer: () => void } }> = [];

async function mountWindow(label: "launcher" | "overlay") {
  // Static imports would share Zustand stores across the simulated webviews.
  vi.resetModules();
  vi.doMock("@tauri-apps/api/webviewWindow", () => ({
    getCurrentWebviewWindow: () => ({ label }),
    WebviewWindow: { getByLabel: async () => null },
  }));
  const { useGlobalShortcut } = await import("./useGlobalShortcut");
  const { useMeetingStore } = await import("../stores/meetingStore");
  const { useConfigStore } = await import("../stores/configStore");
  useConfigStore.setState({ stealthShortcut: "", meetingAudioConfig: null });
  stores.push(useMeetingStore);
  renderHook(() => useGlobalShortcut());
  await waitFor(() => expect(shortcuts.has("CmdOrCtrl+,")).toBe(true));
  return useMeetingStore;
}

beforeEach(() => {
  shortcuts.clear();
  captureFailure.message = "";
});
afterEach(() => {
  cleanup();
  for (const store of stores.splice(0)) store.getState().stopTimer();
  vi.restoreAllMocks();
});

it("starts recording in the launcher that owns Web Speech when the overlay loads last", async () => {
  const launcher = await mountWindow("launcher");
  shortcuts.delete("CmdOrCtrl+,");
  const overlay = await mountWindow("overlay");

  await act(async () => { shortcuts.get("CmdOrCtrl+M")!({ state: "Pressed" }); });
  await waitFor(() => expect(launcher.getState().isRecording || overlay.getState().isRecording).toBe(true));
  await waitFor(() => expect(launcher.getState().isRecording).toBe(true));
  expect(launcher.getState().activeMeeting?.id).toBe("shortcut-meeting");
  expect(overlay.getState().isRecording).toBe(false);
});

it("reports denied audio capture while retaining the created meeting", async () => {
  captureFailure.message = "System audio recording permission denied";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const launcher = await mountWindow("launcher");
  const { useToastStore } = await import("../stores/toastStore");
  await act(async () => { shortcuts.get("CmdOrCtrl+M")!({ state: "Pressed" }); });
  await waitFor(() => expect(launcher.getState().isRecording).toBe(true));
  expect(useToastStore.getState().toasts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "error", message: expect.stringContaining("System audio recording permission denied") }),
  ]));
  expect(launcher.getState().activeMeeting?.id).toBe("shortcut-meeting");
});
