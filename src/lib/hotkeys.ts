// In-meeting action keys: the keys that run Assist and the other AI actions
// while a NexQ window has focus. The global shortcuts (Ctrl+M, Ctrl+B,
// Ctrl+, and the three in Settings > General) are separate and not stored here.

import type { HotkeyConfig, IntelligenceMode } from "./types";
import { normalizeAccelerator, reservedShortcutAction } from "./shortcutLabel";

export interface HotkeyAction {
  id: keyof HotkeyConfig;
  mode: IntelligenceMode;
  label: string;
}

/** Settings rows, in display order. */
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = [
  { id: "mode_assist", mode: "Assist", label: "Assist" },
  { id: "mode_say", mode: "WhatToSay", label: "What to Say" },
  { id: "mode_shorten", mode: "Shorten", label: "Shorten" },
  { id: "mode_followup", mode: "FollowUp", label: "Follow-Up" },
  { id: "mode_recap", mode: "Recap", label: "Recap" },
  { id: "mode_ask", mode: "AskQuestion", label: "Ask Question" },
];

export const DEFAULT_HOTKEYS: HotkeyConfig = {
  mode_assist: "Space",
  mode_say: "1",
  mode_shorten: "2",
  mode_followup: "3",
  mode_recap: "4",
  mode_ask: "5",
};

/**
 * Settings > Hotkeys once offered (and, after "Reset", saved) Ctrl+1..5 for
 * the five mode keys. Nothing ever read them, and the app really uses 1..5,
 * so a saved Ctrl+N is never a choice the user made.
 */
const LEGACY_DEFAULTS: Partial<Record<keyof HotkeyConfig, string>> = {
  mode_say: "Ctrl+1",
  mode_shorten: "Ctrl+2",
  mode_followup: "Ctrl+3",
  mode_recap: "Ctrl+4",
  mode_ask: "Ctrl+5",
};

/** Single keys the overlay already uses (see useMeetingShortcuts). */
const OVERLAY_SINGLE_KEYS: Record<string, string> = {
  B: "Add bookmark",
  S: "Speaker stats",
  K: "Bookmarks panel",
  M: "Mute",
};

interface ParsedHotkey {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const NAMED_KEYS = new Set(["Space", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** The key a physical key press stands for, or null when it can't be a hotkey. */
function keyFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (m) return m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NAMED_KEYS.has(code)) return code;
  if (code === "NumpadEnter") return "Enter";
  return null;
}

/** "Ctrl+Shift+K", "Space", "1" ... as parts, or null when it isn't a usable hotkey. */
export function parseHotkey(spec: unknown): ParsedHotkey | null {
  if (typeof spec !== "string" || !spec.trim()) return null;
  const out: ParsedHotkey = { ctrl: false, alt: false, shift: false, key: "" };
  for (const raw of spec.split("+").map((p) => p.trim())) {
    if (!raw) return null;
    switch (raw.toLowerCase()) {
      case "ctrl":
      case "control":
      case "cmd":
      case "command":
      case "cmdorctrl":
        out.ctrl = true;
        continue;
      case "alt":
      case "option":
        out.alt = true;
        continue;
      case "shift":
        out.shift = true;
        continue;
    }
    if (out.key) return null;
    const key = raw.length === 1 ? raw.toUpperCase() : raw;
    const ok = /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || NAMED_KEYS.has(key);
    if (!ok) return null;
    out.key = key;
  }
  return out.key ? out : null;
}

function format(p: ParsedHotkey): string {
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", p.key].filter(Boolean).join("+");
}

/** One spelling per hotkey ("ctrl+k" and "Ctrl+K" are the same), or null if unusable. */
export function canonicalHotkey(spec: unknown): string | null {
  const parsed = parseHotkey(spec);
  return parsed ? format(parsed) : null;
}

/** The hotkey a key press makes ("Ctrl" covers Cmd on a Mac), or null for a lone modifier or an unsupported key. */
export function hotkeyFromEvent(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
): string | null {
  const key = keyFromCode(e.code);
  if (!key) return null;
  return format({ ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey, key });
}

/** Does this key press exactly match the saved hotkey? (Modifiers must match too.) */
export function matchesHotkey(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  spec: string,
): boolean {
  const parsed = parseHotkey(spec);
  const pressed = keyFromCode(e.code);
  return (
    !!parsed &&
    pressed === parsed.key &&
    (e.ctrlKey || e.metaKey) === parsed.ctrl &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift
  );
}

/** The AI mode this key press runs under the given bindings, if any. */
export function modeForKeyEvent(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  hotkeys: HotkeyConfig,
): IntelligenceMode | null {
  for (const action of HOTKEY_ACTIONS) {
    if (matchesHotkey(e, hotkeys[action.id])) return action.mode;
  }
  return null;
}

/**
 * Why `spec` can't be the binding for `action`, or null when it can: another
 * action key, a built-in shortcut, an overlay single key, or one of the
 * global shortcuts from Settings > General (`globals`, accelerator -> name).
 */
export function hotkeyConflict(
  spec: string,
  action: keyof HotkeyConfig,
  hotkeys: HotkeyConfig,
  globals: Record<string, string> = {},
): string | null {
  const canon = canonicalHotkey(spec);
  if (!canon) return "That key can't be used";
  const other = HOTKEY_ACTIONS.find((a) => a.id !== action && canonicalHotkey(hotkeys[a.id]) === canon);
  if (other) return other.label;
  const reserved = reservedShortcutAction(canon);
  if (reserved) return reserved;
  if (OVERLAY_SINGLE_KEYS[canon]) return OVERLAY_SINGLE_KEYS[canon];
  const wanted = normalizeAccelerator(canon);
  for (const [accel, name] of Object.entries(globals)) {
    if (accel && normalizeAccelerator(accel) === wanted) return name;
  }
  return null;
}

/**
 * Bindings from whatever was saved (any version) to a usable, conflict-free
 * set. Anything missing, unreadable, a leftover Ctrl+1..5 default, or clashing
 * with another binding falls back to that action's default.
 */
export function sanitizeHotkeys(saved: unknown): HotkeyConfig {
  const source = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const result: HotkeyConfig = { ...DEFAULT_HOTKEYS };
  const taken = new Set<string>();
  for (const { id } of HOTKEY_ACTIONS) {
    const canon = canonicalHotkey(source[id]);
    const legacy = LEGACY_DEFAULTS[id];
    const usable =
      canon &&
      canon !== canonicalHotkey(legacy) &&
      !taken.has(canon) &&
      !reservedShortcutAction(canon) &&
      !OVERLAY_SINGLE_KEYS[canon];
    result[id] = usable ? canon : DEFAULT_HOTKEYS[id];
    taken.add(result[id]);
  }
  // A fallback default can still land on a binding the user chose: start over.
  if (taken.size !== HOTKEY_ACTIONS.length) return { ...DEFAULT_HOTKEYS };
  return result;
}

/** The key that runs `mode` under the given bindings ("" for modes without one). */
export function modeHotkey(mode: IntelligenceMode, hotkeys: HotkeyConfig = DEFAULT_HOTKEYS): string {
  const action = HOTKEY_ACTIONS.find((a) => a.mode === mode);
  return action ? hotkeys[action.id] : "";
}
