import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProviderType, Meeting } from "../lib/types";

const shortcuts = vi.hoisted(() => new Map<string, (event: { state: string }) => void>());
const captureFailure = vi.hoisted(() => ({ message: "" }));
const registerFailure = vi.hoisted(() => ({ key: "" }));
const emitted = vi.hoisted(() => [] as Array<[string, unknown]>);
const invoked = vi.hoisted(() => [] as Array<[string, Record<string, unknown> | undefined]>);
const eventHandlers = vi.hoisted(() => new Map<string, () => void>());
const windowState = vi.hoisted(() => ({ overlayVisible: false }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: async (key: string, handler: (event: { state: string }) => void) => {
    if (key === registerFailure.key) throw new Error("already registered");
    shortcuts.set(key, handler);
  },
  unregister: async (key: string) => { shortcuts.delete(key); },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: () => void) => {
    eventHandlers.set(event, handler);
    return () => { eventHandlers.delete(event); };
  },
  emit: async (event: string, payload?: unknown) => { emitted.push([event, payload]); },
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    invoked.push([command, args]);
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
    WebviewWindow: {
      getByLabel: async (name: string) =>
        name === "overlay" && windowState.overlayVisible
          ? { isVisible: async () => true, isMinimized: async () => false }
          : null,
    },
  }));
  const { useGlobalShortcut } = await import("./useGlobalShortcut");
  const { useMeetingStore } = await import("../stores/meetingStore");
  const { useConfigStore } = await import("../stores/configStore");
  useConfigStore.setState({ stealthShortcut: "", meetingAudioConfig: null });
  stores.push(useMeetingStore);
  renderHook(() => useGlobalShortcut());
  // The launcher holds Ctrl+, too; the overlay's last key is Ctrl+B.
  await waitFor(() => expect(shortcuts.has(label === "launcher" ? "CmdOrCtrl+," : "CmdOrCtrl+B")).toBe(true));
  return useMeetingStore;
}

beforeEach(() => {
  invoked.length = 0;
  shortcuts.clear();
  eventHandlers.clear();
  windowState.overlayVisible = false;
  captureFailure.message = "";
  registerFailure.key = "";
});
afterEach(() => {
  cleanup();
  for (const store of stores.splice(0)) store.getState().stopTimer();
  vi.restoreAllMocks();
});

it("starts recording in the launcher that owns Web Speech when the overlay loads last", async () => {
  const launcher = await mountWindow("launcher");
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
  await act(async () => { shortcuts.get("CmdOrCtrl+M")!({ state: "Pressed" }); });
  await waitFor(() => expect(launcher.getState().isRecording).toBe(true));
  // Every window is told (the overlay is the one on screen).
  await waitFor(() => expect(emitted).toEqual(expect.arrayContaining([
    ["capture_warning", expect.stringContaining("System audio recording permission denied")],
  ])));
  expect(launcher.getState().activeMeeting?.id).toBe("shortcut-meeting");
});

it("a number key stops a running automatic answer and runs what you asked for", async () => {
  const useMeetingStore = await mountWindow("overlay");
  useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting });
  const { useStreamStore } = await import("../stores/streamStore");
  const { useQuestionStore } = await import("../stores/questionStore");
  useStreamStore.getState().startStream("Assist", "m", "p", { requestId: "auto-1" });
  useQuestionStore.getState().setAutoAnswer({
    requestId: "auto-1", segmentId: "line", question: "Why?", early: false, done: Promise.resolve(),
  });

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1" }));
  });
  await waitFor(() => expect(invoked.map(([command]) => command)).toContain("generate_assist"));
  expect(invoked.find(([command]) => command === "cancel_generation")?.[1]).toEqual({ requestId: "auto-1" });
});

it("the keys come from Settings > Hotkeys: a changed binding runs the action, the old key stops", async () => {
  const useMeetingStore = await mountWindow("overlay");
  const { useConfigStore } = await import("../stores/configStore");
  useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting });
  act(() => useConfigStore.getState().setHotkeys({ ...useConfigStore.getState().hotkeys, mode_say: "Q" }));

  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1" })); });
  await new Promise((r) => setTimeout(r, 20));
  expect(invoked.map(([command]) => command)).not.toContain("generate_assist");

  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ" })); });
  await waitFor(() => expect(invoked.map(([command]) => command)).toContain("generate_assist"));
  expect(invoked.find(([command]) => command === "generate_assist")?.[1]).toMatchObject({ mode: "WhatToSay" });
});

it("a held action key runs the action once", async () => {
  const useMeetingStore = await mountWindow("overlay");
  useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2", repeat: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2", repeat: true }));
  });
  await waitFor(() => expect(invoked.some(([command]) => command === "generate_assist")).toBe(true));
  expect(invoked.filter(([command]) => command === "generate_assist")).toHaveLength(1);
});

it("a modifier binding such as Ctrl+K runs its action", async () => {
  const useMeetingStore = await mountWindow("overlay");
  const { useConfigStore } = await import("../stores/configStore");
  useMeetingStore.setState({ activeMeeting: { id: "m" } as Meeting });
  act(() => useConfigStore.getState().setHotkeys({ ...useConfigStore.getState().hotkeys, mode_assist: "Ctrl+K" }));
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true })); });
  await waitFor(() => expect(invoked.map(([command]) => command)).toContain("generate_assist"));
  expect(invoked.find(([command]) => command === "generate_assist")?.[1]).toMatchObject({ mode: "Assist" });
});

it("holds the Assist shortcut in the overlay only while a meeting runs", async () => {
  const overlay = await mountWindow("overlay");
  const { DEFAULT_ASSIST_SHORTCUT } = await import("../stores/configStore");
  expect(shortcuts.has(DEFAULT_ASSIST_SHORTCUT)).toBe(false);

  act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
  await waitFor(() => expect(shortcuts.has(DEFAULT_ASSIST_SHORTCUT)).toBe(true));

  act(() => overlay.setState({ activeMeeting: null }));
  await waitFor(() => expect(shortcuts.has(DEFAULT_ASSIST_SHORTCUT)).toBe(false));
});

it("leaves the Assist shortcut to the overlay", async () => {
  const launcher = await mountWindow("launcher");
  const { DEFAULT_ASSIST_SHORTCUT } = await import("../stores/configStore");
  act(() => launcher.setState({ activeMeeting: { id: "m1" } as Meeting }));
  await new Promise((r) => setTimeout(r, 20));
  expect(shortcuts.has(DEFAULT_ASSIST_SHORTCUT)).toBe(false);
});

describe("capture screen shortcut", () => {
  async function overlayWithProvider(provider: LLMProviderType) {
    const overlay = await mountWindow("overlay");
    const { DEFAULT_CAPTURE_SHORTCUT, useConfigStore } = await import("../stores/configStore");
    useConfigStore.setState({ llmProvider: provider });
    return { overlay, useConfigStore, key: DEFAULT_CAPTURE_SHORTCUT };
  }
  const captured = () => invoked.map(([command]) => command).includes("capture_screen_under_cursor");

  it("is Ctrl+Shift+S by default", async () => {
    const { key } = await overlayWithProvider("claude_cli");
    expect(key).toBe("CmdOrCtrl+Shift+S");
  });

  it("is held in the overlay only during a meeting with a provider that reads images", async () => {
    const { overlay, useConfigStore, key } = await overlayWithProvider("claude_cli");
    expect(shortcuts.has(key)).toBe(false);

    act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await waitFor(() => expect(shortcuts.has(key)).toBe(true));

    // Another provider can't read images: the key goes back to other apps.
    act(() => useConfigStore.setState({ llmProvider: "openai" }));
    await waitFor(() => expect(shortcuts.has(key)).toBe(false));
    act(() => useConfigStore.setState({ llmProvider: "claude_cli" }));
    await waitFor(() => expect(shortcuts.has(key)).toBe(true));

    act(() => overlay.setState({ activeMeeting: null }));
    await waitFor(() => expect(shortcuts.has(key)).toBe(false));
  });

  it("is not held with another provider even during a meeting", async () => {
    const { overlay, key } = await overlayWithProvider("openai");
    act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await waitFor(() => expect(shortcuts.has("CmdOrCtrl+Shift+Space")).toBe(true));
    expect(shortcuts.has(key)).toBe(false);
  });

  it("is left to the overlay", async () => {
    const launcher = await mountWindow("launcher");
    const { DEFAULT_CAPTURE_SHORTCUT, useConfigStore } = await import("../stores/configStore");
    useConfigStore.setState({ llmProvider: "claude_cli" });
    act(() => launcher.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await new Promise((r) => setTimeout(r, 20));
    expect(shortcuts.has(DEFAULT_CAPTURE_SHORTCUT)).toBe(false);
  });

  it("captures when pressed, and ignores the key release", async () => {
    const { overlay, key } = await overlayWithProvider("claude_cli");
    act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await waitFor(() => expect(shortcuts.has(key)).toBe(true));

    await act(async () => { shortcuts.get(key)!({ state: "Released" }); });
    expect(captured()).toBe(false);
    await act(async () => { shortcuts.get(key)!({ state: "Pressed" }); });
    await waitFor(() => expect(captured()).toBe(true));
  });

  it("yields to Assist when bound to the same keys", async () => {
    const { overlay, useConfigStore } = await overlayWithProvider("claude_cli");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => useConfigStore.setState({ assistShortcut: "Ctrl+Shift+S" }));
    act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await waitFor(() => expect(shortcuts.has("Ctrl+Shift+S")).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    // Assist holds it; pressing it does not capture.
    await act(async () => { shortcuts.get("Ctrl+Shift+S")!({ state: "Pressed" }); });
    await new Promise((r) => setTimeout(r, 20));
    expect(captured()).toBe(false);
  });

  it("yields to Hide from screen share when bound to the same keys", async () => {
    const { overlay, useConfigStore, key } = await overlayWithProvider("claude_cli");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => useConfigStore.setState({ stealthShortcut: key }));
    act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await waitFor(() => expect(shortcuts.has(key)).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { shortcuts.get(key)!({ state: "Pressed" }); });
    await new Promise((r) => setTimeout(r, 20));
    expect(captured()).toBe(false);
  });

  it("never takes a built-in shortcut", async () => {
    const { overlay, useConfigStore } = await overlayWithProvider("claude_cli");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => useConfigStore.setState({ captureShortcut: "CmdOrCtrl+B" }));
    act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await new Promise((r) => setTimeout(r, 30));
    await act(async () => { shortcuts.get("CmdOrCtrl+B")?.({ state: "Pressed" }); });
    await new Promise((r) => setTimeout(r, 20));
    expect(captured()).toBe(false);
  });

  it("is not registered on macOS (Windows only for now)", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    const { overlay, key } = await overlayWithProvider("claude_cli");
    act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await new Promise((r) => setTimeout(r, 30));
    expect(shortcuts.has(key)).toBe(false);
  });

  it("tells the user once, pointing to Settings, when the key can't be registered", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registerFailure.key = "CmdOrCtrl+Shift+S";
    const { overlay, useConfigStore } = await overlayWithProvider("claude_cli");
    const { useToastStore } = await import("../stores/toastStore");
    const toasts = () => useToastStore.getState().toasts.filter((t) => t.message.includes("Settings > General"));

    act(() => overlay.setState({ activeMeeting: { id: "m1" } as Meeting }));
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].message).toContain("Ctrl+Shift+S");
    expect(toasts()[0].type).toBe("warning");

    // A second try (another meeting, the provider switched back) stays quiet.
    useToastStore.setState({ toasts: [] });
    act(() => overlay.setState({ activeMeeting: null }));
    act(() => useConfigStore.setState({ llmProvider: "openai" }));
    act(() => useConfigStore.setState({ llmProvider: "claude_cli" }));
    act(() => overlay.setState({ activeMeeting: { id: "m2" } as Meeting }));
    await new Promise((r) => setTimeout(r, 50));
    expect(toasts()).toHaveLength(0);
  });
});

describe("Settings shortcut (Ctrl+,)", () => {
  const press = () => act(async () => { shortcuts.get("CmdOrCtrl+,")!({ state: "Pressed" }); });

  it("opens the dashboard's Settings page from the launcher and closes it again", async () => {
    const launcher = await mountWindow("launcher");
    await press();
    await waitFor(() => expect(launcher.getState().currentView).toBe("settings"));
    await press();
    await waitFor(() => expect(launcher.getState().currentView).toBe("launcher"));
  });

  it("is held by the launcher only, so the overlay window cannot take the key over", async () => {
    await mountWindow("launcher");
    const launcherHandler = shortcuts.get("CmdOrCtrl+,");
    await mountWindow("overlay");
    expect(shortcuts.get("CmdOrCtrl+,")).toBe(launcherHandler);
  });

  it("hands the press to the overlay window while the meeting overlay is on screen", async () => {
    const launcher = await mountWindow("launcher");
    const overlay = await mountWindow("overlay");
    overlay.setState({ currentView: "overlay" });
    windowState.overlayVisible = true;
    emitted.length = 0;

    await press();
    await waitFor(() => expect(emitted).toEqual([["nexq:toggle_settings", undefined]]));
    expect(launcher.getState().currentView).toBe("launcher");

    // The overlay window toggles its own Settings panel when told.
    await act(async () => { eventHandlers.get("nexq:toggle_settings")!(); });
    expect(overlay.getState().settingsOpen).toBe(true);
    await act(async () => { eventHandlers.get("nexq:toggle_settings")!(); });
    expect(overlay.getState().settingsOpen).toBe(false);
  });
});

describe("meeting shortcut (Ctrl+M) and demos", () => {
  const press = () => act(async () => { shortcuts.get("CmdOrCtrl+M")!({ state: "Pressed" }); });
  const commands = () => invoked.map(([command]) => command);

  it("during a demo exits the demo and starts a real meeting, never ending the demo's", async () => {
    const launcher = await mountWindow("launcher");
    const { useDemoStore } = await import("../demo/demoStore");
    act(() => {
      useDemoStore.getState().activate("live-interview", "play");
      launcher.setState({ activeMeeting: { id: "demo-meeting" } as Meeting, isRecording: true });
    });

    await press();
    await waitFor(() => expect(launcher.getState().activeMeeting?.id).toBe("shortcut-meeting"));
    expect(useDemoStore.getState().isDemoActive).toBe(false);
    expect(commands()).toContain("start_meeting");
    expect(commands()).not.toContain("stop_capture");
    expect(commands()).not.toContain("append_transcript_segment");
    expect(commands()).not.toContain("end_meeting");
  });

  it("with a real meeting still ends it", async () => {
    const launcher = await mountWindow("launcher");
    act(() => launcher.setState({ activeMeeting: { id: "real" } as Meeting, isRecording: true }));

    await press();
    await waitFor(() => expect(launcher.getState().activeMeeting).toBeNull());
    expect(commands()).toContain("stop_capture");
    expect(commands()).toContain("end_meeting");
    expect(commands()).not.toContain("start_meeting");
  });

  it("ending a demo's meeting by any other path leaves the demo without stopping capture or saving", async () => {
    const launcher = await mountWindow("launcher");
    const { useDemoStore } = await import("../demo/demoStore");
    act(() => {
      useDemoStore.getState().activate("live-interview", "play");
      launcher.setState({ activeMeeting: { id: "demo-meeting" } as Meeting });
    });

    await act(async () => { await launcher.getState().endMeetingFlow(); });
    expect(useDemoStore.getState().isDemoActive).toBe(false);
    expect(commands()).not.toContain("stop_capture");
    expect(commands()).not.toContain("end_meeting");
  });
});

describe("Ctrl+B and the in-meeting keys leave editors and buttons alone", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("hands Ctrl+B to a focused rich-text editor (bold) instead of switching windows", async () => {
    await mountWindow("overlay");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    const seen: KeyboardEvent[] = [];
    editor.addEventListener("keydown", (e) => seen.push(e));
    windowState.overlayVisible = true;
    emitted.length = 0;

    await act(async () => { shortcuts.get("CmdOrCtrl+B")!({ state: "Pressed" }); });
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe("b");
    expect(seen[0].ctrlKey).toBe(true);
  });

  it("does not run an action key when Space is pressed on a focused button", async () => {
    const store = await mountWindow("overlay");
    store.setState({ activeMeeting: { id: "m", title: "t", start_time: "", end_time: null, duration_seconds: null, transcript: [], ai_interactions: [], summary: null, config_snapshot: null } });
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const event = new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);

    // The same key on the page itself still belongs to the action.
    const free = new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true });
    document.body.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(true);
  });
});
