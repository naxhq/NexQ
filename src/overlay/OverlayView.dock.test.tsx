import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/windows", async () => {
  const actual = await vi.importActual<typeof import("../lib/windows")>("../lib/windows");
  return { ...actual, showLauncherWindow: vi.fn().mockResolvedValue(undefined) };
});

import { OverlayView } from "./OverlayView";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useDemoStore } from "../demo/demoStore";
import { SCREENSHOT_EVENT } from "../lib/screenCapture";
import {
  DEFAULT_PANELS,
  dockReducer,
  initialDockState,
  readingBackingAlpha,
  type DockAction,
  type DockState,
} from "./dock";
import type { Meeting } from "../lib/types";

const realSetDock = useConfigStore.getState().setOverlayDock;
const realSetTransient = useConfigStore.getState().setOverlayDockTransient;
let seq = 0;
let setDock: ReturnType<typeof vi.fn>;
let setTransient: ReturnType<typeof vi.fn>;

function dockWith(...actions: DockAction[]): DockState {
  return actions.reduce(dockReducer, initialDockState(DEFAULT_PANELS));
}

function renderOverlay(meetingId = `dock-meeting-${++seq}`) {
  useMeetingStore.setState({
    activeMeeting: { id: meetingId, title: "Standup" } as Meeting,
    currentView: "overlay",
    audioMode: "online",
    isRecording: true,
  });
  return render(<OverlayView />);
}

const panel = (id: string) => document.querySelector<HTMLElement>(`[data-dock-panel="${id}"]`)!;
const shown = (id: string) => panel(id).getAttribute("data-visible") === "true";
const key = (k: string, init: KeyboardEventInit = {}) => act(() => void fireEvent.keyDown(window, { key: k, ...init }));
const headerBtn = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

beforeAll(() => {
  mockWindows("overlay");
  mockIPC(() => []);
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
});

beforeEach(() => {
  setDock = vi.fn();
  setTransient = vi.fn();
  useConfigStore.setState({
    overlayDock: null,
    overlayDockTransient: [],
    setOverlayDock: setDock as never,
    setOverlayDockTransient: setTransient as never,
    overlayOpacity: 0.65,
  });
});

afterEach(() => {
  cleanup();
  useMeetingStore.setState({ activeMeeting: null, currentView: "launcher", isRecording: false });
  useDemoStore.setState({ isDemoActive: false });
  useConfigStore.setState({ setOverlayDock: realSetDock, setOverlayDockTransient: realSetTransient });
});

describe("the meeting window's dock", () => {
  it("starts as Classic: transcript and assistant side by side, the rest hidden", () => {
    renderOverlay();
    expect(shown("transcript")).toBe(true);
    expect(shown("assistant")).toBe(true);
    for (const p of ["notes", "brief", "points", "bookmarks", "stats", "calllog", "devlog"]) {
      expect(shown(p)).toBe(false);
    }
  });

  it("keeps header, status bar and the controls outside the dock, in the old order", () => {
    renderOverlay();
    const dock = screen.getByRole("group", { name: "Meeting panels" });
    for (const name of ["Mute mic (You)", "Mute them", "Settings", "End meeting", "Layout"]) {
      const b = screen.getByRole("button", { name });
      expect(dock.contains(b)).toBe(false);
    }
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    const at = (n: string) => names.findIndex((x) => x?.startsWith(n));
    expect(at("Mute mic")).toBeLessThan(at("Focus AI panel"));
    expect(at("Focus AI panel")).toBeLessThan(at("Layout"));
    expect(at("Layout")).toBeLessThan(at("Speaker Stats"));
    expect(at("Speaker Stats")).toBeLessThan(at("Bookmarks"));
    expect(at("Bookmarks")).toBeLessThan(at("AI Call Log"));
    expect(at("AI Call Log")).toBeLessThan(at("Dev Log"));
    expect(at("Dev Log")).toBeLessThan(at("End meeting"));
  });

  it("the header buttons and S / K / Ctrl+Shift+L show and hide their panels", () => {
    renderOverlay();
    headerBtn("Speaker Stats (S)");
    expect(shown("stats")).toBe(true);
    headerBtn("Speaker Stats (S)");
    expect(shown("stats")).toBe(false);

    key("s");
    expect(shown("stats")).toBe(true);
    key("s");
    expect(shown("stats")).toBe(false);
    key("k");
    expect(shown("bookmarks")).toBe(true);
    key("L", { ctrlKey: true, shiftKey: true });
    expect(shown("devlog")).toBe(true);
    headerBtn("AI Call Log");
    expect(shown("calllog")).toBe(true);
    expect(screen.getByRole("button", { name: "AI Call Log" }).getAttribute("aria-pressed")).toBe("true");
    headerBtn("AI Call Log");
    expect(shown("calllog")).toBe(false);
  });

  it("Escape closes every panel opened on the fly at once, and never the assistant", () => {
    renderOverlay();
    key("s");
    key("k");
    key("Escape");
    expect(shown("bookmarks")).toBe(false);
    expect(shown("stats")).toBe(false);
    expect(shown("assistant")).toBe(true);
    expect(shown("transcript")).toBe(true);
  });

  it("a locked layout still opens and closes panels", () => {
    useConfigStore.setState({ overlayDock: dockWith({ type: "lock", locked: true }) });
    renderOverlay();
    key("s");
    expect(shown("stats")).toBe(true);
    key("Escape");
    expect(shown("stats")).toBe(false);
  });

  it("Escape leaves a panel the layout itself shows alone", () => {
    useConfigStore.setState({ overlayDock: dockWith({ type: "show", panel: "stats" }) });
    renderOverlay("meeting-keep-stats");
    expect(shown("stats")).toBe(true);
    key("Escape");
    expect(shown("stats")).toBe(true);
  });

  it("the old cycle button collapses a side to a strip and back", () => {
    renderOverlay();
    headerBtn("Focus AI panel");
    expect(screen.getByRole("button", { name: "Expand Transcript panel" })).toBeTruthy();
    headerBtn("Focus Transcript");
    expect(screen.getByRole("button", { name: "Expand Assistant panel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Expand Transcript panel" })).toBeNull();
    headerBtn("Split view");
    expect(screen.queryByRole("button", { name: /^Expand/ })).toBeNull();
  });

  it("the assistant is mounted once: nothing in it remounts when panels move or collapse", () => {
    renderOverlay();
    const ask = screen.getAllByRole("button").find((b) => b.getAttribute("aria-label")?.startsWith("Ask"));
    expect(ask).toBeTruthy();
    key("s");
    headerBtn("Focus AI panel");
    headerBtn("Focus Transcript");
    headerBtn("Split view");
    expect(ask!.isConnected).toBe(true);
    expect(screen.getAllByRole("button").find((b) => b.getAttribute("aria-label")?.startsWith("Ask"))).toBe(ask);
  });

  it("the Ask key brings a hidden assistant back", () => {
    useConfigStore.setState({ overlayDock: dockWith({ type: "hide", panel: "assistant" }) });
    renderOverlay();
    expect(shown("assistant")).toBe(false);
    act(() => void window.dispatchEvent(new Event("nexq:toggle-ask-input")));
    expect(shown("assistant")).toBe(true);
  });

  it("a screenshot brings the assistant back even when the layout is locked", () => {
    useConfigStore.setState({
      overlayDock: dockWith({ type: "hide", panel: "assistant" }, { type: "lock", locked: true }),
    });
    renderOverlay();
    expect(shown("assistant")).toBe(false);
    act(() => void window.dispatchEvent(new Event(SCREENSHOT_EVENT, { cancelable: true })));
    expect(shown("assistant")).toBe(true);
  });

  it("a screenshot expands a collapsed assistant strip", () => {
    renderOverlay();
    headerBtn("Focus AI panel");
    headerBtn("Focus Transcript");
    expect(screen.getByRole("button", { name: "Expand Assistant panel" })).toBeTruthy();
    act(() => void window.dispatchEvent(new Event(SCREENSHOT_EVENT, { cancelable: true })));
    expect(screen.queryByRole("button", { name: "Expand Assistant panel" })).toBeNull();
  });

  it("reading panels carry the reading backing, which stays at 85% when the window is nearly clear", () => {
    useConfigStore.setState({ overlayOpacity: 0.1 });
    renderOverlay();
    const root = screen.getByRole("group", { name: "Meeting panels" });
    expect(Number(root.style.getPropertyValue("--dock-reading-alpha"))).toBeCloseTo(readingBackingAlpha(0.1), 5);
    expect(document.querySelectorAll('[data-dock-surface][data-reading="true"]').length).toBe(2);
  });
});

describe("idle cost (a meeting open, nothing happening)", () => {
  it("runs no frame loop, no sub-second interval and no running animation of its own", async () => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const intervals: number[] = [];
    const realSet = window.setInterval.bind(window);
    const spy = vi.spyOn(window, "setInterval").mockImplementation(((cb: TimerHandler, ms?: number, ...a: unknown[]) => {
      intervals.push(ms ?? 0);
      return realSet(cb as () => void, ms, ...a);
    }) as typeof window.setInterval);
    try {
      renderOverlay();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      raf.mockClear();
      intervals.length = 0;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(raf).not.toHaveBeenCalled();
      expect(intervals.filter((ms) => ms < 1000)).toEqual([]);
    } finally {
      spy.mockRestore();
      raf.mockRestore();
      vi.useRealTimers();
    }
  });

  it("re-renders no panel for the clock: a second passing touches only the clock text", async () => {
    vi.useFakeTimers();
    try {
      renderOverlay();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      const dock = screen.getByRole("group", { name: "Meeting panels" });
      const seen: string[] = [];
      const mo = new MutationObserver((l) => l.forEach((m) => seen.push(m.type + ":" + (m.attributeName ?? ""))));
      mo.observe(dock, { subtree: true, childList: true, attributes: true, characterData: true });
      await act(async () => {
        useMeetingStore.setState({ elapsedMs: 5000 });
        await vi.advanceTimersByTimeAsync(2000);
      });
      mo.disconnect();
      expect(seen.filter((x) => x.includes("inert"))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Settings from the header", () => {
  it("gives focus back to the Settings button when the meeting view returns", () => {
    const first = renderOverlay("settings-focus");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    first.unmount();
    renderOverlay("settings-focus");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settings" }));
  });
});

describe("a narrow header", () => {
  it("moves the view toggles into one menu, all still reachable with their state and keys", () => {
    const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")!;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 500 });
    try {
      renderOverlay();
      expect(screen.queryByRole("button", { name: "Speaker Stats (S)" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "More view options" }));
      const items = screen.getAllByRole("menuitem").concat(screen.getAllByRole("menuitemcheckbox"));
      const names = items.map((i) => i.textContent);
      for (const n of ["Speaker stats", "Bookmarks", "AI call log", "Dev log", "Transparency", "Focus AI panel"]) {
        expect(names.some((t) => t?.includes(n))).toBe(true);
      }
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Speaker stats/ }));
      expect(shown("stats")).toBe(true);
      // the always-needed controls stay out of the menu
      for (const name of ["Mute mic (You)", "Layout", "Settings", "End meeting"]) {
        expect(screen.getByRole("button", { name })).toBeTruthy();
      }
    } finally {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", w);
    }
  });
});

describe("short areas", () => {
  it("a short transcript drops its toolbar and shows slim meters in the tab bar", () => {
    const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 150 });
    try {
      renderOverlay();
      expect(document.querySelector(".nq-dock-extra [role='group'][aria-label='Audio levels']")).toBeTruthy();
      expect(panel("transcript").querySelector(".hidden")).toBeTruthy();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", h);
    }
  });

  it("at a normal height nothing is dropped and the tab bar has no meters", () => {
    renderOverlay();
    expect(document.querySelector("[aria-label='Audio levels']")).toBeNull();
  });
});

describe("persistence", () => {
  it("saves the layout (flushed on unmount) and keeps what was opened", () => {
    const { unmount } = renderOverlay();
    key("s");
    unmount();
    expect(setDock).toHaveBeenCalled();
    const saved = setDock.mock.calls[setDock.mock.calls.length - 1]![0] as DockState;
    expect(saved.layout.hidden).not.toContain("stats");
    expect(saved.layout.hidden).toContain("notes");
  });

  it("a saved layout is what the next window opens with", () => {
    useConfigStore.setState({ overlayDock: dockWith({ type: "preset", preset: "notes" }) });
    renderOverlay();
    expect(shown("notes")).toBe(true);
    expect(shown("brief")).toBe(false);
  });

  it.each([["garbage"], [42], [{ layout: "x" }], [{ v: 1 }]])("corrupt data %# falls back to Classic", (bad) => {
    useConfigStore.setState({ overlayDock: bad });
    renderOverlay();
    expect(shown("transcript")).toBe(true);
    expect(shown("assistant")).toBe(true);
    expect(shown("notes")).toBe(false);
  });

  it("a saved layout missing a newer panel gets it back, hidden", () => {
    const old = JSON.parse(JSON.stringify(initialDockState(DEFAULT_PANELS))) as DockState;
    old.layout.hidden = old.layout.hidden.filter((p) => p !== "points");
    useConfigStore.setState({ overlayDock: old });
    renderOverlay();
    expect(panel("points")).toBeTruthy();
    expect(shown("points")).toBe(false);
  });

  it("a new meeting closes what the last one opened on the fly but keeps the arrangement", () => {
    useConfigStore.setState({
      overlayDock: dockWith({ type: "preset", preset: "notes" }, { type: "show", panel: "stats" }),
      overlayDockTransient: ["stats"],
    });
    renderOverlay("fresh-meeting-a");
    expect(shown("stats")).toBe(false);
    expect(shown("notes")).toBe(true);
  });

  it("the same meeting reopening the window keeps what was opened", () => {
    const first = renderOverlay("same-meeting");
    first.unmount();
    useConfigStore.setState({
      overlayDock: dockWith({ type: "show", panel: "stats" }),
      overlayDockTransient: ["stats"],
    });
    renderOverlay("same-meeting");
    expect(shown("stats")).toBe(true);
    key("Escape");
    expect(shown("stats")).toBe(false);
  });

  it("opening panels on the fly is remembered for the next start", () => {
    renderOverlay();
    key("s");
    expect(setTransient).toHaveBeenLastCalledWith(["stats"]);
    key("Escape");
    expect(setTransient).toHaveBeenLastCalledWith([]);
  });
});

describe("demo mode in the launcher window", () => {
  it("shows the layout but never writes it", () => {
    useDemoStore.setState({ isDemoActive: true });
    const { unmount } = renderOverlay();
    key("s");
    expect(shown("stats")).toBe(true);
    unmount();
    expect(setDock).not.toHaveBeenCalled();
    expect(setTransient).not.toHaveBeenCalled();
  });
});
