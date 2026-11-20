import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  getStealthSupport: vi.fn(() => Promise.resolve({ supported: true, note: null })),
}));

import { StealthSettings } from "./StealthSettings";
import { useConfigStore } from "../stores/configStore";
import { useToastStore } from "../stores/toastStore";

const NOTE = /can't read images/i;

beforeEach(() => {
  useConfigStore.setState({
    llmProvider: "claude_cli",
    stealthShortcut: "CmdOrCtrl+Shift+H",
    assistShortcut: "CmdOrCtrl+Shift+Space",
    captureShortcut: "CmdOrCtrl+Shift+S",
  });
  useToastStore.setState({ toasts: [] });
});

afterEach(cleanup);

describe("StealthSettings capture shortcut row", () => {
  it("shows the shortcut and no note while the AI can read images", () => {
    render(<StealthSettings />);
    expect(screen.getByText("Capture screen into Ask")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Change shortcut, currently Ctrl\+Shift\+S$/ })).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("adds a one-line note when the chosen AI can't read images", () => {
    useConfigStore.setState({ llmProvider: "openai" });
    render(<StealthSettings />);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
  });

  it("refuses keys another shortcut already uses, in every direction", () => {
    render(<StealthSettings />);
    const press = (name: RegExp, init: KeyboardEventInit) => {
      fireEvent.click(screen.getByRole("button", { name }));
      fireEvent.keyDown(window, init);
    };
    // Capture <- Assist's keys.
    press(/currently Ctrl\+Shift\+S$/, { code: "Space", key: " ", ctrlKey: true, shiftKey: true });
    // Assist <- capture's keys.
    press(/currently Ctrl\+Shift\+Space$/, { code: "KeyS", key: "S", ctrlKey: true, shiftKey: true });
    // Hide from screen share <- capture's keys.
    press(/currently Ctrl\+Shift\+H$/, { code: "KeyS", key: "S", ctrlKey: true, shiftKey: true });

    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"Assist"'),
        expect.stringContaining('"Capture screen into Ask"'),
      ]),
    );
    expect(useConfigStore.getState().captureShortcut).toBe("CmdOrCtrl+Shift+S");
    expect(useConfigStore.getState().assistShortcut).toBe("CmdOrCtrl+Shift+Space");
    expect(useConfigStore.getState().stealthShortcut).toBe("CmdOrCtrl+Shift+H");
  });

  it("rebinds the capture shortcut to a free combination", () => {
    render(<StealthSettings />);
    fireEvent.click(screen.getByRole("button", { name: /currently Ctrl\+Shift\+S$/ }));
    fireEvent.keyDown(window, { code: "KeyK", key: "K", ctrlKey: true, altKey: true });
    expect(useConfigStore.getState().captureShortcut).toBe("CmdOrCtrl+Alt+K");
  });
});
