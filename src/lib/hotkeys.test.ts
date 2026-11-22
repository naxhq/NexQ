import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  OVERLAY_SINGLE_KEYS,
  canonicalHotkey,
  hotkeyConflict,
  hotkeyFromEvent,
  hotkeysAsTaken,
  isLegacyHotkeyConfig,
  matchesHotkey,
  migrateSavedHotkeys,
  modeForKeyEvent,
  modeHotkey,
  sanitizeHotkeys,
} from "./hotkeys";

const key = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("hotkeys: defaults are what the app really uses", () => {
  it("Space runs Assist and 1 to 5 run the other actions, with no modifier", () => {
    expect(DEFAULT_HOTKEYS).toEqual({
      mode_assist: "Space",
      mode_say: "1",
      mode_shorten: "2",
      mode_followup: "3",
      mode_recap: "4",
      mode_ask: "5",
    });
    expect(modeForKeyEvent(key("Space"), DEFAULT_HOTKEYS)).toBe("Assist");
    expect(modeForKeyEvent(key("Digit1"), DEFAULT_HOTKEYS)).toBe("WhatToSay");
    expect(modeForKeyEvent(key("Numpad2"), DEFAULT_HOTKEYS)).toBe("Shorten");
    expect(modeForKeyEvent(key("Digit3"), DEFAULT_HOTKEYS)).toBe("FollowUp");
    expect(modeForKeyEvent(key("Digit4"), DEFAULT_HOTKEYS)).toBe("Recap");
    expect(modeForKeyEvent(key("Digit5"), DEFAULT_HOTKEYS)).toBe("AskQuestion");
  });

  it("a key with a modifier held does not run the plain binding", () => {
    expect(modeForKeyEvent(key("Digit1", { ctrlKey: true }), DEFAULT_HOTKEYS)).toBeNull();
    expect(modeForKeyEvent(key("Space", { ctrlKey: true, shiftKey: true }), DEFAULT_HOTKEYS)).toBeNull();
  });

  it("modeHotkey reports the current key per mode", () => {
    expect(modeHotkey("WhatToSay")).toBe("1");
    expect(modeHotkey("Assist", { ...DEFAULT_HOTKEYS, mode_assist: "Q" })).toBe("Q");
    expect(modeHotkey("MeetingSummary")).toBe("");
  });
});

describe("hotkeys: recording and matching", () => {
  it("turns a key press into one spelling", () => {
    expect(hotkeyFromEvent(key("KeyK", { shiftKey: true, ctrlKey: true }))).toBe("Ctrl+Shift+K");
    expect(hotkeyFromEvent(key("Digit7"))).toBe("7");
    expect(hotkeyFromEvent(key("F9", { altKey: true }))).toBe("Alt+F9");
    expect(hotkeyFromEvent(key("ControlLeft"))).toBeNull();
    expect(canonicalHotkey("ctrl+shift+k")).toBe("Ctrl+Shift+K");
    expect(canonicalHotkey("Shift+Ctrl+K")).toBe("Ctrl+Shift+K");
  });

  it("a changed binding is what the handler matches", () => {
    const changed = { ...DEFAULT_HOTKEYS, mode_say: "Q" };
    expect(modeForKeyEvent(key("KeyQ"), changed)).toBe("WhatToSay");
    expect(modeForKeyEvent(key("Digit1"), changed)).toBeNull();
    expect(matchesHotkey(key("KeyQ", { ctrlKey: true }), "Q")).toBe(false);
    expect(matchesHotkey(key("KeyQ", { ctrlKey: true }), "Ctrl+Q")).toBe(true);
  });
});

describe("hotkeys: conflicts", () => {
  it("refuses another action's key, built-in shortcuts, overlay single keys and the General shortcuts", () => {
    expect(hotkeyConflict("2", "mode_say", DEFAULT_HOTKEYS)).toBe("Shorten");
    expect(hotkeyConflict("Ctrl+M", "mode_say", DEFAULT_HOTKEYS)).toBe("Start / end meeting");
    expect(hotkeyConflict("B", "mode_say", DEFAULT_HOTKEYS)).toBe("Add bookmark");
    expect(
      hotkeyConflict("Ctrl+Shift+H", "mode_say", DEFAULT_HOTKEYS, { "CmdOrCtrl+Shift+H": "Hide from screen share" }),
    ).toBe("Hide from screen share");
    expect(hotkeyConflict("1", "mode_say", DEFAULT_HOTKEYS)).toBeNull();
    expect(hotkeyConflict("Q", "mode_say", DEFAULT_HOTKEYS)).toBeNull();
  });
});

describe("hotkeys: loading an old saved config", () => {
  it("nothing saved gives the defaults", () => {
    expect(sanitizeHotkeys(undefined)).toEqual(DEFAULT_HOTKEYS);
    expect(sanitizeHotkeys(null)).toEqual(DEFAULT_HOTKEYS);
    expect(sanitizeHotkeys("junk")).toEqual(DEFAULT_HOTKEYS);
  });

  it("the old 'Reset' values (Ctrl+1..5) and the old unused fields are dropped", () => {
    const old = {
      toggle_assist: "Space",
      start_end_meeting: "Ctrl+M",
      show_hide: "Ctrl+B",
      open_settings: "Ctrl+,",
      escape: "Escape",
      mode_assist: "Space",
      mode_say: "Ctrl+1",
      mode_shorten: "Ctrl+2",
      mode_followup: "Ctrl+3",
      mode_recap: "Ctrl+4",
      mode_ask: "Ctrl+5",
    };
    const clean = migrateSavedHotkeys(old);
    expect(clean).toEqual(DEFAULT_HOTKEYS);
    expect(Object.keys(clean).sort()).toEqual(Object.keys(DEFAULT_HOTKEYS).sort());
  });

  it("keeps a real choice, even next to a bogus value", () => {
    const clean = sanitizeHotkeys({ ...DEFAULT_HOTKEYS, mode_say: "ctrl+shift+k", mode_recap: "Ctrl+4" });
    expect(clean.mode_say).toBe("Ctrl+Shift+K");
    expect(clean.mode_recap).toBe("Ctrl+4");
  });

  it("unreadable, reserved or clashing values fall back to the defaults", () => {
    expect(sanitizeHotkeys({ mode_say: 42 }).mode_say).toBe("1");
    expect(sanitizeHotkeys({ mode_say: "Ctrl+M" }).mode_say).toBe("1");
    expect(sanitizeHotkeys({ mode_say: "B" }).mode_say).toBe("1");
    // Two actions on one key, and a default that would clash: start over.
    expect(sanitizeHotkeys({ mode_say: "2" })).toEqual(DEFAULT_HOTKEYS);
    expect(sanitizeHotkeys({ mode_say: "Q", mode_shorten: "Q" })).toEqual({ ...DEFAULT_HOTKEYS, mode_say: "Q" });
  });

  it("Tab and Enter are never bindable", () => {
    expect(sanitizeHotkeys({ mode_say: "Tab" }).mode_say).toBe("1");
    expect(sanitizeHotkeys({ mode_say: "Enter" }).mode_say).toBe("1");
    expect(sanitizeHotkeys({ mode_say: "Ctrl+Tab" }).mode_say).toBe("1");
    expect(hotkeyFromEvent(key("Tab"))).toBeNull();
    expect(hotkeyFromEvent(key("Enter"))).toBeNull();
    expect(hotkeyFromEvent(key("NumpadEnter"))).toBeNull();
    expect(canonicalHotkey("Tab")).toBeNull();
  });

  it("the editing keys and the overlay single keys are never action keys", () => {
    for (const k of ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Ctrl+Y"]) {
      expect(hotkeyConflict(k, "mode_say", DEFAULT_HOTKEYS)).not.toBeNull();
      expect(sanitizeHotkeys({ mode_say: k }).mode_say).toBe("1");
    }
    for (const k of OVERLAY_SINGLE_KEYS) {
      expect(sanitizeHotkeys({ mode_say: k.key }).mode_say).toBe("1");
    }
    expect(hotkeyConflict("K", "mode_say", DEFAULT_HOTKEYS)).toBe("Bookmarks panel");
  });
});

describe("hotkeys: the action keys as taken entries", () => {
  it("names each binding so a global shortcut can't take it", () => {
    expect(hotkeysAsTaken({ ...DEFAULT_HOTKEYS, mode_assist: "Alt+K" })).toMatchObject({
      "Alt+K": "Assist key",
      "1": "What to Say key",
    });
  });
});

describe("hotkeys: conflicts on a Mac", () => {
  // Recording Command+M gives "Ctrl+M" (the hotkey's Ctrl is Ctrl or Cmd), while
  // the built-in and General shortcuts are CmdOrCtrl accelerators.
  it("Ctrl/Cmd+M clashes with the CmdOrCtrl built-ins", () => {
    expect(hotkeyConflict("Ctrl+M", "mode_say", DEFAULT_HOTKEYS, {}, true)).toBe("Start / end meeting");
    expect(hotkeyConflict("Ctrl+Shift+D", "mode_say", DEFAULT_HOTKEYS, {}, true)).toBe("Demo mode");
  });

  it("clashes with a General shortcut stored as CmdOrCtrl, as Cmd, or as Control", () => {
    for (const accel of ["CmdOrCtrl+Shift+H", "Cmd+Shift+H", "Super+Shift+H", "Ctrl+Shift+H"]) {
      expect(hotkeyConflict("Ctrl+Shift+H", "mode_say", DEFAULT_HOTKEYS, { [accel]: "Hide" }, true)).toBe("Hide");
    }
    // Cmd and Control held together is a different shortcut
    expect(hotkeyConflict("Ctrl+Shift+H", "mode_say", DEFAULT_HOTKEYS, { "CmdOrCtrl+Ctrl+Shift+H": "Hide" }, true)).toBeNull();
  });

  it("on Windows the Win key is still not Ctrl", () => {
    expect(hotkeyConflict("Ctrl+Shift+H", "mode_say", DEFAULT_HOTKEYS, { "Super+Shift+H": "Hide" }, false)).toBeNull();
    expect(hotkeyConflict("Ctrl+Shift+H", "mode_say", DEFAULT_HOTKEYS, { "CmdOrCtrl+Shift+H": "Hide" }, false)).toBe("Hide");
  });

  it("a saved Ctrl+M is replaced by the default on a Mac too", () => {
    expect(sanitizeHotkeys({ mode_say: "Ctrl+M" }, true).mode_say).toBe("1");
    expect(sanitizeHotkeys({ mode_say: "Ctrl+B" }, true).mode_say).toBe("1");
    expect(sanitizeHotkeys({ mode_say: "Ctrl+K" }, true).mode_say).toBe("Ctrl+K");
  });

  it("the taken entries also carry the CmdOrCtrl spelling the shortcut pickers record", () => {
    const hk = { ...DEFAULT_HOTKEYS, mode_assist: "Ctrl+K" };
    expect(hotkeysAsTaken(hk, true)).toMatchObject({ "Ctrl+K": "Assist key", "CmdOrCtrl+K": "Assist key" });
    expect(hotkeysAsTaken(hk, false)).not.toHaveProperty("CmdOrCtrl+K");
  });
});

describe("hotkeys: a deliberate Ctrl+1..5", () => {
  it("is a free choice, not a conflict", () => {
    expect(hotkeyConflict("Ctrl+1", "mode_say", DEFAULT_HOTKEYS, {}, false)).toBeNull();
    for (const n of [1, 2, 3, 4, 5]) {
      const id = HOTKEY_ACTIONS[n].id;
      expect(sanitizeHotkeys({ ...DEFAULT_HOTKEYS, [id]: `Ctrl+${n}` })[id]).toBe(`Ctrl+${n}`);
    }
  });

  it("survives sanitizing again (setHotkeys, window sync, reload)", () => {
    const chosen = { ...DEFAULT_HOTKEYS, mode_say: "Ctrl+1" };
    const once = sanitizeHotkeys(chosen);
    expect(once.mode_say).toBe("Ctrl+1");
    expect(sanitizeHotkeys(once)).toEqual(once);
    expect(migrateSavedHotkeys(once)).toEqual(once);
  });

  it("only an identifiable old config is migrated", () => {
    const five = { mode_assist: "Space", mode_say: "Ctrl+1", mode_shorten: "Ctrl+2", mode_followup: "Ctrl+3", mode_recap: "Ctrl+4", mode_ask: "Ctrl+5" };
    // all five exactly Ctrl+1..5: the old Reset
    expect(isLegacyHotkeyConfig(five)).toBe(true);
    expect(migrateSavedHotkeys(five)).toEqual(DEFAULT_HOTKEYS);
    // the old shape (unused fields), even with one key changed
    const oldShape = { toggle_assist: "Space", start_end_meeting: "Ctrl+M", mode_say: "Ctrl+1", mode_recap: "Q" };
    expect(isLegacyHotkeyConfig(oldShape)).toBe(true);
    expect(migrateSavedHotkeys(oldShape)).toEqual({ ...DEFAULT_HOTKEYS, mode_recap: "Q" });
    // a single deliberate Ctrl+1, or four of five, is not
    expect(isLegacyHotkeyConfig({ ...DEFAULT_HOTKEYS, mode_say: "Ctrl+1" })).toBe(false);
    expect(isLegacyHotkeyConfig({ ...five, mode_ask: "5" })).toBe(false);
    expect(migrateSavedHotkeys({ ...five, mode_ask: "5" }).mode_say).toBe("Ctrl+1");
    expect(migrateSavedHotkeys({ ...DEFAULT_HOTKEYS, mode_say: "Ctrl+1" }).mode_say).toBe("Ctrl+1");
    expect(isLegacyHotkeyConfig(null)).toBe(false);
  });
});
