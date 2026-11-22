import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOTKEYS,
  canonicalHotkey,
  hotkeyConflict,
  hotkeyFromEvent,
  matchesHotkey,
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
    const clean = sanitizeHotkeys(old);
    expect(clean).toEqual(DEFAULT_HOTKEYS);
    expect(Object.keys(clean).sort()).toEqual(Object.keys(DEFAULT_HOTKEYS).sort());
  });

  it("keeps a real choice, even next to a bogus value", () => {
    const clean = sanitizeHotkeys({ ...DEFAULT_HOTKEYS, mode_say: "ctrl+shift+k", mode_recap: "Ctrl+4" });
    expect(clean.mode_say).toBe("Ctrl+Shift+K");
    expect(clean.mode_recap).toBe("4");
  });

  it("unreadable, reserved or clashing values fall back to the defaults", () => {
    expect(sanitizeHotkeys({ mode_say: 42 }).mode_say).toBe("1");
    expect(sanitizeHotkeys({ mode_say: "Ctrl+M" }).mode_say).toBe("1");
    expect(sanitizeHotkeys({ mode_say: "B" }).mode_say).toBe("1");
    // Two actions on one key, and a default that would clash: start over.
    expect(sanitizeHotkeys({ mode_say: "2" })).toEqual(DEFAULT_HOTKEYS);
    expect(sanitizeHotkeys({ mode_say: "Q", mode_shorten: "Q" })).toEqual({ ...DEFAULT_HOTKEYS, mode_say: "Q" });
  });
});
