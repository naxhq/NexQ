// In-meeting action keys: the keys that run Assist and the other AI actions
// while a NexQ window has focus. The global shortcuts (Ctrl+M, Ctrl+B,
// Ctrl+, and the three in Settings > General) are separate and not stored here.

import type { HotkeyConfig, IntelligenceMode } from "./types";
import { RESERVED_SHORTCUTS, isMacPlatform, normalizeAccelerator } from "./shortcutLabel";

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
 * so those saved values are not choices the user made. A config is only
 * treated as that old one when it is recognisably old (see isLegacyHotkeyConfig):
 * a Ctrl+1 someone picked on purpose today must survive.
 */
const LEGACY_DEFAULTS: Partial<Record<keyof HotkeyConfig, string>> = {
  mode_say: "Ctrl+1",
  mode_shorten: "Ctrl+2",
  mode_followup: "Ctrl+3",
  mode_recap: "Ctrl+4",
  mode_ask: "Ctrl+5",
};

/** Fields the old Settings > Hotkeys page saved next to the mode keys. */
const LEGACY_FIELDS = ["toggle_assist", "start_end_meeting", "show_hide", "open_settings", "escape"];

export type OverlayKeyId = "bookmark" | "stats" | "bookmarks" | "mute" | "notes" | "closePanels";

/** DOM event the N key raises on window: "update the live notes now". */
export const NOTES_UPDATE_EVENT = "nexq:notes-update";

export interface OverlaySingleKey {
  /** As shown to the user and as KeyboardEvent.key spells it (letters upper case); matching ignores case. */
  key: string;
  id: OverlayKeyId;
  label: string;
  /** Where it works, for the shortcut list. */
  where: string;
}

/**
 * The single keys the overlay uses in a meeting. The one table behind the
 * meeting handler (useMeetingShortcuts), the conflict check and the list in
 * Settings > Hotkeys, so they can't drift apart.
 */
export const OVERLAY_SINGLE_KEYS: readonly OverlaySingleKey[] = [
  { key: "B", id: "bookmark", label: "Add bookmark", where: "overlay, in a meeting" },
  { key: "S", id: "stats", label: "Speaker stats", where: "overlay, in a meeting" },
  { key: "K", id: "bookmarks", label: "Bookmarks panel", where: "overlay, in a meeting" },
  { key: "M", id: "mute", label: "Mute", where: "overlay, in a meeting" },
  { key: "N", id: "notes", label: "Update notes now", where: "meeting window" },
  { key: "Escape", id: "closePanels", label: "Close open panels", where: "overlay" },
];

/** Editing keys every text box answers to: never an action key. */
const EDITING_SHORTCUTS: Record<string, string> = {
  "Ctrl+C": "Copy",
  "Ctrl+V": "Paste",
  "Ctrl+X": "Cut",
  "Ctrl+A": "Select all",
  "Ctrl+Z": "Undo",
  "Ctrl+Y": "Redo",
};

/** The overlay single key that `canon` (a canonical hotkey) is, if any. */
export function overlaySingleKey(canon: string): OverlaySingleKey | undefined {
  const upper = canon.toUpperCase();
  return OVERLAY_SINGLE_KEYS.find((k) => k.key.toUpperCase() === upper);
}

interface ParsedHotkey {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

// No Enter or Tab: Enter submits the Ask box and Tab moves focus.
const NAMED_KEYS = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** The key a physical key press stands for, or null when it can't be a hotkey. */
function keyFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (m) return m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NAMED_KEYS.has(code)) return code;
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
 * A hotkey's "Ctrl" is Ctrl or Cmd (a key press with either matches it), so
 * for conflicts it equals CmdOrCtrl on every platform, and on a Mac also the
 * literal Control. Both sides are reduced to one spelling for that.
 */
function comparableAccelerator(accelerator: string, mac: boolean): string {
  const parts = normalizeAccelerator(accelerator, mac).split("+");
  // Cmd+Control together is not a plain Ctrl key.
  if (parts.includes("CmdOrCtrl") && parts.includes("Ctrl")) return parts.join("+");
  return parts.map((p) => (p === "CmdOrCtrl" ? "Ctrl" : p)).join("+");
}

/** The built-in shortcut that `canon` (a canonical hotkey) would shadow, if any. */
function reservedHotkeyAction(canon: string, mac: boolean): string | null {
  const wanted = comparableAccelerator(canon, mac);
  for (const [accel, action] of Object.entries(RESERVED_SHORTCUTS)) {
    if (comparableAccelerator(accel, mac) === wanted) return action;
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
  mac = isMacPlatform(),
): string | null {
  const canon = canonicalHotkey(spec);
  if (!canon) return "That key can't be used";
  const other = HOTKEY_ACTIONS.find((a) => a.id !== action && canonicalHotkey(hotkeys[a.id]) === canon);
  if (other) return other.label;
  const reserved = reservedHotkeyAction(canon, mac);
  if (reserved) return reserved;
  if (EDITING_SHORTCUTS[canon]) return EDITING_SHORTCUTS[canon];
  const single = overlaySingleKey(canon);
  if (single) return single.label;
  const wanted = comparableAccelerator(canon, mac);
  for (const [accel, name] of Object.entries(globals)) {
    if (accel && comparableAccelerator(accel, mac) === wanted) return name;
  }
  return null;
}

/**
 * Is `saved` the config the old Settings > Hotkeys page wrote? It carried
 * fields nothing used (toggle_assist ...), and "Reset" saved all five mode
 * keys as exactly Ctrl+1..Ctrl+5.
 */
export function isLegacyHotkeyConfig(saved: unknown): boolean {
  if (!saved || typeof saved !== "object") return false;
  const source = saved as Record<string, unknown>;
  if (LEGACY_FIELDS.some((f) => f in source)) return true;
  return HOTKEY_ACTIONS.every(({ id }) => {
    const legacy = LEGACY_DEFAULTS[id];
    return legacy === undefined || canonicalHotkey(source[id]) === canonicalHotkey(legacy);
  });
}

/**
 * Bindings from whatever was saved to a usable, conflict-free set. Anything
 * missing, unreadable, reserved or clashing with another binding falls back
 * to that action's default. Ctrl+1..5 is a normal choice here: only
 * migrateSavedHotkeys, for an old config, discards it.
 */
export function sanitizeHotkeys(saved: unknown, mac = isMacPlatform()): HotkeyConfig {
  const source = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const result: HotkeyConfig = { ...DEFAULT_HOTKEYS };
  const taken = new Set<string>();
  for (const { id } of HOTKEY_ACTIONS) {
    const canon = canonicalHotkey(source[id]);
    const usable =
      canon &&
      !taken.has(canon) &&
      !reservedHotkeyAction(canon, mac) &&
      !EDITING_SHORTCUTS[canon] &&
      !overlaySingleKey(canon);
    result[id] = usable ? canon : DEFAULT_HOTKEYS[id];
    taken.add(result[id]);
  }
  // A fallback default can still land on a binding the user chose: start over.
  if (taken.size !== HOTKEY_ACTIONS.length) return { ...DEFAULT_HOTKEYS };
  return result;
}

/**
 * For the config read from disk at startup: like sanitizeHotkeys, but an old
 * config (isLegacyHotkeyConfig) first loses its never-used Ctrl+1..5 values.
 * Runs on load only, so a Ctrl+1 chosen later is kept by setHotkeys, window
 * sync and the next load.
 */
export function migrateSavedHotkeys(saved: unknown, mac = isMacPlatform()): HotkeyConfig {
  if (!isLegacyHotkeyConfig(saved)) return sanitizeHotkeys(saved, mac);
  const source = { ...(saved as Record<string, unknown>) };
  for (const { id } of HOTKEY_ACTIONS) {
    const legacy = LEGACY_DEFAULTS[id];
    if (legacy && canonicalHotkey(source[id]) === canonicalHotkey(legacy)) delete source[id];
  }
  return sanitizeHotkeys(source, mac);
}

/** The in-meeting action keys as "taken" entries (key -> name) for the global shortcut pickers. */
export function hotkeysAsTaken(hotkeys: HotkeyConfig, mac = isMacPlatform()): Record<string, string> {
  const taken: Record<string, string> = {};
  for (const { id, label } of HOTKEY_ACTIONS) {
    if (!hotkeys[id]) continue;
    taken[hotkeys[id]] = `${label} key`;
    // A hotkey's Ctrl is also Cmd: on a Mac the pickers record Cmd as CmdOrCtrl.
    const canon = canonicalHotkey(hotkeys[id]);
    if (mac && canon?.startsWith("Ctrl+")) taken[`CmdOrCtrl+${canon.slice(5)}`] = `${label} key`;
  }
  return taken;
}

/** The key that runs `mode` under the given bindings ("" for modes without one). */
export function modeHotkey(mode: IntelligenceMode, hotkeys: HotkeyConfig = DEFAULT_HOTKEYS): string {
  const action = HOTKEY_ACTIONS.find((a) => a.mode === mode);
  return action ? hotkeys[action.id] : "";
}

// ---------------------------------------------------------------------------
// Key guard: keys that belong to the control that has focus
// ---------------------------------------------------------------------------

const TYPING_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable=\"false\"])",
  "[role=\"textbox\"]",
  "[role=\"searchbox\"]",
  "[role=\"combobox\"]",
  "[role=\"spinbutton\"]",
].join(",");

const ACTIVATABLE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  "[role=\"button\"]",
  "[role=\"menuitem\"]",
  "[role=\"menuitemcheckbox\"]",
  "[role=\"menuitemradio\"]",
  "[role=\"option\"]",
  "[role=\"tab\"]",
  "[role=\"switch\"]",
  "[role=\"checkbox\"]",
  "[role=\"radio\"]",
  "[role=\"treeitem\"]",
].join(",");

/** The element a key press went to (falls back to the focused element for window-level events). */
function keyTarget(e: { target?: EventTarget | null }): Element | null {
  const t = e.target;
  if (t && typeof (t as Element).closest === "function") return t as Element;
  return typeof document !== "undefined" ? document.activeElement : null;
}

/** A text box of any kind: input, textarea, select, contenteditable (also inside one) or role=textbox. */
export function isTypingTarget(el: Element | null | undefined): boolean {
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(TYPING_SELECTOR) !== null;
}

/** A control Space activates: button, link, menu item, tab, switch ... */
export function isActivatableTarget(el: Element | null | undefined): boolean {
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(ACTIVATABLE_SELECTOR) !== null;
}

/**
 * Should the in-meeting single key (Space, 1-5, B, S, K, M, N, ...) be left to
 * the control that has focus? Text boxes keep every key; Space also stays with
 * a focused button or menu item (it presses it).
 */
export function keyBelongsToFocusedControl(e: { target?: EventTarget | null; key?: string; code?: string }): boolean {
  const el = keyTarget(e);
  if (isTypingTarget(el)) return true;
  const isSpace = e.code === "Space" || e.key === " " || e.key === "Space";
  return isSpace && isActivatableTarget(el);
}

/** The focused rich-text editor (contenteditable or role=textbox), if the window has focus. */
export function focusedRichEditor(doc: Document = document): Element | null {
  if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return null;
  const el = doc.activeElement;
  if (!el || typeof el.closest !== "function") return null;
  return el.closest("[contenteditable]:not([contenteditable=\"false\"]),[role=\"textbox\"]");
}

/**
 * The global Ctrl+B swallows the key before the page sees it. When an editor in
 * NexQ has focus, hand the chord to it (bold) instead of switching windows.
 * Returns true when it was handed over.
 */
export function forwardChordToEditor(key: string, doc: Document = document): boolean {
  const editor = focusedRichEditor(doc);
  if (!editor) return false;
  const target = doc.activeElement ?? editor;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: key.toLowerCase(),
      code: `Key${key.toUpperCase()}`,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
