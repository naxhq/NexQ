/** True on macOS (shortcuts show ⌘ ⇧ ⌥ ⌃ there). */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
}

const MAC_SYMBOLS: Record<string, string> = {
  CmdOrCtrl: "⌘",
  CommandOrControl: "⌘",
  Cmd: "⌘",
  Command: "⌘",
  Super: "⌘",
  Meta: "⌘",
  Ctrl: "⌃",
  Control: "⌃",
  Shift: "⇧",
  Alt: "⌥",
  Option: "⌥",
};

/**
 * A Tauri accelerator ("CmdOrCtrl+Shift+H") as the user reads it:
 * "Ctrl+Shift+H" on Windows, "⌘⇧H" on macOS.
 */
export function formatShortcut(accelerator: string, mac = isMacPlatform()): string {
  const parts = accelerator.split("+").filter(Boolean);
  if (mac) return parts.map((p) => MAC_SYMBOLS[p] ?? p).join("");
  return parts
    .map((p) => (p === "CmdOrCtrl" || p === "CommandOrControl" ? "Ctrl" : p === "Super" || p === "Meta" ? "Win" : p))
    .join("+");
}

/**
 * The accelerator for a pressed key combination, or null for a lone modifier
 * or a combination without a modifier (global shortcuts need one). The
 * platform's primary modifier (Cmd on macOS, Ctrl elsewhere) becomes
 * "CmdOrCtrl"; the other one is kept as itself (Ctrl on macOS, Super on
 * Windows), so Control+H and Command+H stay different shortcuts on a Mac.
 */
export function acceleratorFromEvent(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  mac = isMacPlatform(),
): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const primary = mac ? e.metaKey : e.ctrlKey;
  const secondary = mac ? e.ctrlKey : e.metaKey;
  if (!primary && !secondary && !e.altKey) return null;
  const parts: string[] = [];
  if (primary) parts.push("CmdOrCtrl");
  if (secondary) parts.push(mac ? "Ctrl" : "Super");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  // Use the physical key so Shift/Alt don't turn "H" into a symbol.
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else if (e.code === "Space") key = "Space";
  else return null;
  parts.push(key);
  return parts.join("+");
}

const MODIFIER_ORDER = ["CmdOrCtrl", "Ctrl", "Super", "Alt", "Shift"];
const MODIFIER_ALIASES: Record<string, string> = {
  cmdorctrl: "CmdOrCtrl",
  commandorcontrol: "CmdOrCtrl",
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Super",
  command: "Super",
  super: "Super",
  meta: "Super",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/**
 * One spelling per accelerator on this platform, so "Ctrl+Shift+h" and
 * "CmdOrCtrl+Shift+H" compare equal on Windows (Ctrl is the primary
 * modifier there; Cmd is on macOS).
 */
export function normalizeAccelerator(accelerator: string, mac = isMacPlatform()): string {
  const mods = new Set<string>();
  let key = "";
  for (const raw of accelerator.split("+").filter(Boolean)) {
    let mod = MODIFIER_ALIASES[raw.toLowerCase()];
    if (mod === (mac ? "Super" : "Ctrl")) mod = "CmdOrCtrl";
    if (mod) mods.add(mod);
    else key = raw.length === 1 ? raw.toUpperCase() : raw;
  }
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/**
 * Shortcuts NexQ already uses (global: Ctrl+M, Ctrl+B, Ctrl+,; in-window:
 * Ctrl+Shift+L dev log, Ctrl+Shift+D demo). A user binding must not take one.
 */
export const RESERVED_SHORTCUTS: Record<string, string> = {
  "CmdOrCtrl+M": "Start / end meeting",
  "CmdOrCtrl+B": "Show / hide overlay",
  "CmdOrCtrl+,": "Open settings",
  "CmdOrCtrl+Shift+L": "Dev log",
  "CmdOrCtrl+Shift+D": "Demo mode",
};

/** The action that already owns `accelerator`, if any. */
export function reservedShortcutAction(accelerator: string, mac = isMacPlatform()): string | null {
  const wanted = normalizeAccelerator(accelerator, mac);
  for (const [accel, action] of Object.entries(RESERVED_SHORTCUTS)) {
    if (normalizeAccelerator(accel, mac) === wanted) return action;
  }
  return null;
}
