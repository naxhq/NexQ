import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the webview window + plugin-os BEFORE importing the component.
const minimize = vi.fn().mockResolvedValue(undefined);
const toggleMaximize = vi.fn().mockResolvedValue(undefined);
const close = vi.fn().mockResolvedValue(undefined);
const isMaximized = vi.fn().mockResolvedValue(false);
const isFocused = vi.fn().mockResolvedValue(true);
const onResized = vi.fn().mockResolvedValue(() => {});
const onFocusChanged = vi.fn().mockResolvedValue(() => {});

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    minimize,
    toggleMaximize,
    close,
    isMaximized,
    isFocused,
    onResized,
    onFocusChanged,
  }),
}));

const mockPlatform = vi.fn(() => "windows");
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => mockPlatform(),
}));

import { LauncherTitleBar } from "./LauncherTitleBar";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LauncherTitleBar on Windows", () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue("windows");
  });

  it("renders three window-control buttons with the right labels", async () => {
    render(<LauncherTitleBar />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    });
  });

  it("calls minimize/toggleMaximize/close on the matching click", async () => {
    render(<LauncherTitleBar />);
    await waitFor(() => screen.getByRole("button", { name: "Minimize" }));

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(minimize).toHaveBeenCalledTimes(1);
    expect(toggleMaximize).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("shows the NexQ wordmark and icon in the drag region", async () => {
    render(<LauncherTitleBar />);
    await waitFor(() => screen.getByText("NexQ"));
    expect(screen.getByText("NexQ")).toBeTruthy();
  });
});

describe("LauncherTitleBar on macOS", () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue("macos");
  });

  it("renders no window-control buttons (native traffic lights are drawn by the OS)", async () => {
    render(<LauncherTitleBar />);
    // Give the effect a tick to flip isMac.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Minimize" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    });
    // The NexQ wordmark still renders alongside the traffic lights.
    expect(screen.getByText("NexQ")).toBeTruthy();
  });
});
