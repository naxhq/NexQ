import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toggleStealthMode } = vi.hoisted(() => ({
  toggleStealthMode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../hooks/useGlobalShortcut", () => ({ toggleStealthMode }));
vi.mock("../lib/shortcutLabel", () => ({ formatShortcut: (s: string) => s }));

import { LauncherStealthButton } from "./LauncherStealthButton";
import { useConfigStore } from "../stores/configStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useConfigStore.setState({ stealthMode: false });
});

describe("LauncherStealthButton", () => {
  it("reads 'Visible in screen share' and the ScreenShare icon when stealth is off", () => {
    useConfigStore.setState({ stealthMode: false });
    render(<LauncherStealthButton />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toContain("Visible in screen share");
  });

  it("reads 'Hidden from screen share' and is pressed when stealth is on", () => {
    useConfigStore.setState({ stealthMode: true });
    render(<LauncherStealthButton />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toContain("Hidden from screen share");
  });

  it("toggles stealth on click (the off-switch available after a meeting ends)", () => {
    useConfigStore.setState({ stealthMode: true });
    render(<LauncherStealthButton />);
    fireEvent.click(screen.getByRole("button"));
    expect(toggleStealthMode).toHaveBeenCalledTimes(1);
  });
});
