import { renderHook, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useStealthCursor } from "./useStealthCursor";
import { useConfigStore } from "../stores/configStore";

const flag = () => document.documentElement.dataset.stealthCursor;

afterEach(() => {
  cleanup();
  useConfigStore.setState({ stealthMode: false });
  delete document.documentElement.dataset.stealthCursor;
});

describe("useStealthCursor", () => {
  it("marks the overlay window's <html> while stealth mode is on", () => {
    useConfigStore.setState({ stealthMode: true });
    renderHook(() => useStealthCursor("overlay"));
    expect(flag()).toBe("true");
  });

  it("marks it off when stealth mode is off", () => {
    useConfigStore.setState({ stealthMode: false });
    renderHook(() => useStealthCursor("overlay"));
    expect(flag()).toBe("false");
  });

  it("follows a stealth change without a remount", () => {
    useConfigStore.setState({ stealthMode: false });
    const { rerender } = renderHook(() => useStealthCursor("overlay"));
    useConfigStore.setState({ stealthMode: true });
    rerender();
    expect(flag()).toBe("true");
  });

  it("never touches the launcher window's cursors", () => {
    useConfigStore.setState({ stealthMode: true });
    renderHook(() => useStealthCursor("launcher"));
    expect(flag()).toBeUndefined();
  });

  it("removes the mark when the overlay window unmounts it", () => {
    useConfigStore.setState({ stealthMode: true });
    const { unmount } = renderHook(() => useStealthCursor("overlay"));
    unmount();
    expect(flag()).toBeUndefined();
  });
});
