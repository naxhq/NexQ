// The launcher and the overlay each have their own aiActionsStore. Auto-Answer
// runs in the overlay, but its switch is usually flipped in the launcher's
// Settings. They meet in the plugin-store, modelled here as in
// configStore.crossWindow.test.ts: one shared map, and a write tells every
// window that listens for the key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AllActionConfigs } from "../lib/types";

const STORE_KEY = "ai_action_configs";

const saved = vi.hoisted(() => new Map<string, unknown>());
const keyListeners = vi.hoisted(() => [] as Array<{ key: string; cb: (v: unknown) => void }>);
/** While `hold` is set, change notices wait here until a test delivers them. */
const notices = vi.hoisted(() => ({ hold: false, waiting: [] as Array<() => void> }));

/** What comes back from the Rust side: the same value, its keys in sorted order. */
const sortKeys = vi.hoisted(() => (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sortKeys(v)]),
  );
});

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      const stored = sortKeys(structuredClone(value));
      saved.set(key, stored);
      // Like the Rust side: every window (the writer included) hears the change.
      const tell = () => {
        for (const l of [...keyListeners]) if (l.key === key) l.cb(structuredClone(stored));
      };
      if (notices.hold) notices.waiting.push(tell);
      else tell();
    },
    onKeyChange: async (key: string, cb: (v: unknown) => void) => {
      const listener = { key, cb };
      keyListeners.push(listener);
      return () => {
        const at = keyListeners.indexOf(listener);
        if (at >= 0) keyListeners.splice(at, 1);
      };
    },
  }),
}));

// The backend has no saved action configs of its own here, so a window without
// saved settings starts from the defaults.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_action_configs") throw new Error("no saved configs");
    return null;
  }),
}));

/** A window: a fresh module graph (its own store) that has started as App does. */
async function openWindow() {
  vi.resetModules();
  const { useAIActionsStore, watchSavedActionConfigs } = await import("./aiActionsStore");
  await useAIActionsStore.getState().loadConfigs();
  await watchSavedActionConfigs();
  return useAIActionsStore;
}

const savedDefaults = () => (saved.get(STORE_KEY) as AllActionConfigs | undefined)?.globalDefaults;

describe("AI action settings across windows", () => {
  beforeEach(() => {
    saved.clear();
    keyListeners.length = 0;
    notices.hold = false;
    notices.waiting.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Auto-Answer switched on in the launcher's Settings reaches the overlay without a restart", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    expect(overlay.getState().configs.globalDefaults.autoTrigger).toBe(false);

    launcher.getState().updateGlobalDefaults({ autoTrigger: true });

    await vi.waitFor(() => expect(savedDefaults()?.autoTrigger).toBe(true));
    await vi.waitFor(() => expect(overlay.getState().configs.globalDefaults.autoTrigger).toBe(true));
  });

  it("a change made in the overlay afterwards doesn't switch Auto-Answer back off", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    launcher.getState().updateGlobalDefaults({ autoTrigger: true });
    await vi.waitFor(() => expect(savedDefaults()?.autoTrigger).toBe(true));

    // Anything the overlay saves (here: web search for Assist) writes its whole copy.
    overlay.getState().updateActionConfig("Assist", { webSearch: true });

    await vi.waitFor(() =>
      expect((saved.get(STORE_KEY) as AllActionConfigs).actions.Assist.webSearch).toBe(true),
    );
    expect(savedDefaults()?.autoTrigger).toBe(true);
    await vi.waitFor(() => expect(launcher.getState().configs.actions.Assist.webSearch).toBe(true));
    expect(launcher.getState().configs.globalDefaults.autoTrigger).toBe(true);
  });

  it("a window's own save coming back late doesn't undo what was typed since", async () => {
    const launcher = await openWindow();
    const overlay = await openWindow();
    notices.hold = true;

    launcher.getState().setCustomInstructions("Be brief");
    await vi.waitFor(() => expect(notices.waiting).toHaveLength(1));
    launcher.getState().setCustomInstructions("Be brief and concrete");
    await vi.waitFor(() => expect(notices.waiting).toHaveLength(2));

    // The notice of the first save arrives only now, after the newer edit.
    notices.waiting[0]();
    expect(launcher.getState().configs.customInstructions).toBe("Be brief and concrete");
    notices.waiting[1]();
    expect(launcher.getState().configs.customInstructions).toBe("Be brief and concrete");
    expect(overlay.getState().configs.customInstructions).toBe("Be brief and concrete");
  });

  it("the next app start still has it on", async () => {
    const launcher = await openWindow();
    await openWindow();
    launcher.getState().updateGlobalDefaults({ autoTrigger: true });
    await vi.waitFor(() => expect(savedDefaults()?.autoTrigger).toBe(true));

    const nextStart = await openWindow();
    expect(nextStart.getState().configs.globalDefaults.autoTrigger).toBe(true);
  });
});
