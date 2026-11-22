import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingShortcuts } from "./useMeetingShortcuts";
import { useMeetingStore } from "../stores/meetingStore";

const actions = () => ({
  addBookmark: vi.fn(),
  toggleStats: vi.fn(),
  toggleBookmarks: vi.fn(),
  toggleMute: vi.fn(),
  closeAllPanels: vi.fn(),
  toggleDevLog: vi.fn(),
});

function press(key: string, mods: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...mods }));
}

describe("useMeetingShortcuts", () => {
  let a: ReturnType<typeof actions>;
  beforeEach(() => {
    a = actions();
    useMeetingStore.setState({ isRecording: true });
    renderHook(() => useMeetingShortcuts(a));
  });
  afterEach(() => {
    cleanup();
    useMeetingStore.setState({ isRecording: false });
  });

  it("the bare B, S, K, M keys and Escape work", () => {
    press("b");
    press("s");
    press("k");
    press("m");
    press("Escape");
    expect(a.addBookmark).toHaveBeenCalledTimes(1);
    expect(a.toggleStats).toHaveBeenCalledTimes(1);
    expect(a.toggleBookmarks).toHaveBeenCalledTimes(1);
    expect(a.toggleMute).toHaveBeenCalledTimes(1);
    expect(a.closeAllPanels).toHaveBeenCalledTimes(1);
  });

  it("a key with a modifier belongs to the action keys, not to the single keys", () => {
    press("k", { ctrlKey: true });
    press("K", { shiftKey: true });
    press("m", { altKey: true });
    press("M", { shiftKey: true });
    press("s", { metaKey: true });
    expect(a.toggleBookmarks).not.toHaveBeenCalled();
    expect(a.toggleMute).not.toHaveBeenCalled();
    expect(a.toggleStats).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+L opens the dev log; Ctrl+B is the global overlay switch, not a bookmark", () => {
    press("b", { ctrlKey: true });
    press("L", { ctrlKey: true, shiftKey: true });
    expect(a.addBookmark).not.toHaveBeenCalled();
    expect(a.toggleDevLog).toHaveBeenCalledTimes(1);
  });
});
