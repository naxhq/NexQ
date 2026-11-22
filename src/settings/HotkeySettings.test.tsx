import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => void saved.set(key, value),
    onKeyChange: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));

async function mount() {
  vi.resetModules();
  const { useConfigStore } = await import("../stores/configStore");
  const { HotkeySettings } = await import("./HotkeySettings");
  render(<HotkeySettings />);
  return useConfigStore;
}

const row = (label: string) => screen.getByRole("button", { name: new RegExp(`Change hotkey for ${label},`) });

beforeEach(() => {
  saved.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows the keys the app really uses", async () => {
  await mount();
  expect(row("Assist").textContent).toContain("Space");
  expect(row("What to Say").textContent).toContain("1");
  expect(row("Ask Question").textContent).toContain("5");
  expect(screen.queryByText("Ctrl+1")).toBeNull();
});

it("rebinding an action changes the saved setting the handler reads", async () => {
  const store = await mount();
  fireEvent.click(row("What to Say"));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ" }));
  });
  expect(store.getState().hotkeys.mode_say).toBe("Q");
  expect(row("What to Say").textContent).toContain("Q");
  await vi.waitFor(() => expect(saved.get("hotkeys")).toMatchObject({ mode_say: "Q" }));
});

it("refuses a key another action already has, and keeps listening", async () => {
  const store = await mount();
  fireEvent.click(row("What to Say"));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2" }));
  });
  expect(store.getState().hotkeys.mode_say).toBe("1");
  expect(store.getState().hotkeys.mode_shorten).toBe("2");
  expect(screen.getByText("Press a key...")).toBeTruthy();
});

it("Tab ends the recording, moves focus on and changes nothing", async () => {
  const store = await mount();
  fireEvent.click(row("What to Say"));
  expect(screen.getByText("Press a key...")).toBeTruthy();
  const tab = new KeyboardEvent("keydown", { code: "Tab", cancelable: true });
  await act(async () => {
    window.dispatchEvent(tab);
  });
  expect(tab.defaultPrevented).toBe(false);
  expect(screen.queryByText("Press a key...")).toBeNull();
  expect(store.getState().hotkeys.mode_say).toBe("1");
});

it("refuses the editing keys such as Ctrl+C and keeps listening", async () => {
  const store = await mount();
  fireEvent.click(row("What to Say"));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC", ctrlKey: true }));
  });
  expect(store.getState().hotkeys.mode_say).toBe("1");
  expect(screen.getByText("Press a key...")).toBeTruthy();
});

it("announces the recording to screen readers", async () => {
  await mount();
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("");
  fireEvent.click(row("Recap"));
  expect(status.textContent).toContain("Press a key for Recap");
});

it("Reset to Defaults restores the real keys", async () => {
  const store = await mount();
  act(() => store.getState().setHotkeys({ ...store.getState().hotkeys, mode_say: "Q", mode_assist: "Ctrl+K" }));
  expect(row("What to Say").textContent).toContain("Q");

  fireEvent.click(screen.getByRole("button", { name: "Reset all hotkeys to defaults" }));
  expect(store.getState().hotkeys).toEqual({
    mode_assist: "Space", mode_say: "1", mode_shorten: "2", mode_followup: "3", mode_recap: "4", mode_ask: "5",
  });
  await vi.waitFor(() => expect(saved.get("hotkeys")).toMatchObject({ mode_say: "1", mode_ask: "5" }));
});
