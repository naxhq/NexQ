import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

import { UpdateReadyToast } from "./UpdateToast";
import { useUpdaterStore } from "../stores/updaterStore";

describe("UpdateReadyToast tells the rest of the app when it is on screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUpdaterStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("flags itself while showing and clears the flag when it goes", () => {
    render(<UpdateReadyToast />);
    expect(useUpdaterStore.getState().readyToastVisible).toBe(false);

    act(() => useUpdaterStore.getState().setReady("9.9.9", "notes"));
    expect(screen.getByText("NexQ v9.9.9 is ready")).toBeInTheDocument();
    expect(useUpdaterStore.getState().readyToastVisible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(12_001);
    });
    expect(useUpdaterStore.getState().readyToastVisible).toBe(false);
  });

  it("clears the flag when it unmounts while showing", () => {
    const { unmount } = render(<UpdateReadyToast />);
    act(() => useUpdaterStore.getState().setReady("9.9.9", "notes"));
    expect(useUpdaterStore.getState().readyToastVisible).toBe(true);
    unmount();
    expect(useUpdaterStore.getState().readyToastVisible).toBe(false);
  });
});
