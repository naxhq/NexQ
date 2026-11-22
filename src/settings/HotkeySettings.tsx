import { useState, useCallback, useEffect } from "react";
import { useConfigStore } from "../stores/configStore";
import { showToast } from "../stores/toastStore";
import type { HotkeyConfig } from "../lib/types";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  OVERLAY_SINGLE_KEYS,
  hotkeyConflict,
  hotkeyFromEvent,
} from "../lib/hotkeys";
import { RESERVED_SHORTCUTS, formatShortcut } from "../lib/shortcutLabel";
import { RotateCcw, Keyboard } from "lucide-react";

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** Fixed keys NexQ uses that can't be rebound here. */
const FIXED_SHORTCUTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: "Ctrl+M", action: "Start / end meeting (any app)" },
  { keys: "Ctrl+B", action: `${RESERVED_SHORTCUTS["CmdOrCtrl+B"]} (any app)` },
  { keys: "Ctrl+,", action: "Open / close Settings" },
  ...OVERLAY_SINGLE_KEYS.map((k) => ({ keys: k.key, action: `${k.label} (${k.where})` })),
];

export function HotkeySettings() {
  const hotkeys = useConfigStore((s) => s.hotkeys);
  const setHotkeys = useConfigStore((s) => s.setHotkeys);
  const assistShortcut = useConfigStore((s) => s.assistShortcut);
  const captureShortcut = useConfigStore((s) => s.captureShortcut);
  const stealthShortcut = useConfigStore((s) => s.stealthShortcut);

  const [editingKey, setEditingKey] = useState<keyof HotkeyConfig | null>(null);

  // When a row is clicked for rebinding, listen for the next key combo
  useEffect(() => {
    if (!editingKey) return;
    const label = HOTKEY_ACTIONS.find((a) => a.id === editingKey)!.label;

    const handler = (e: KeyboardEvent) => {
      // Tab can't be a hotkey and must keep moving focus: stop recording, leave the key alone.
      if (e.code === "Tab") {
        setEditingKey(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return; // a held key (e.g. the Enter that opened this) is not a choice
      if (e.code === "Escape") {
        setEditingKey(null);
        return;
      }
      if (MODIFIER_CODES.test(e.code)) return; // keep waiting for the real key

      const combo = hotkeyFromEvent(e);
      if (!combo) {
        showToast("That key can't be used. Try a letter, number, Space, F-key or arrow.", "error");
        return;
      }
      const taken = hotkeyConflict(combo, editingKey, hotkeys, {
        [assistShortcut]: "Assist from any app",
        [captureShortcut]: "Capture screen into Ask",
        [stealthShortcut]: "Hide from screen share",
      });
      if (taken) {
        // Keep listening: the current binding stays as it is.
        showToast(`${combo} is already used by "${taken}"`, "error");
        return;
      }
      setHotkeys({ ...hotkeys, [editingKey]: combo });
      setEditingKey(null);
      showToast(`${label} is now ${combo}`, "success");
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [editingKey, hotkeys, setHotkeys, assistShortcut, captureShortcut, stealthShortcut]);

  const handleRowClick = useCallback((action: keyof HotkeyConfig) => {
    setEditingKey(action);
  }, []);

  const handleResetDefaults = useCallback(() => {
    setHotkeys(DEFAULT_HOTKEYS);
    setEditingKey(null);
    showToast("Hotkeys reset to defaults", "info");
  }, [setHotkeys]);

  const handleCancelEdit = useCallback(() => {
    setEditingKey(null);
  }, []);

  const others = [
    { keys: formatShortcut(assistShortcut), action: "Assist from any app (change in General)" },
    { keys: formatShortcut(captureShortcut), action: "Capture screen into Ask (change in General)" },
    { keys: formatShortcut(stealthShortcut), action: "Hide from screen share (change in General)" },
    ...FIXED_SHORTCUTS,
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-border/30 bg-card/50 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-primary/80">
              Keyboard Shortcuts
            </h3>
          </div>
          <button
            onClick={handleResetDefaults}
            className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs font-medium text-muted-foreground transition-all duration-150 hover:bg-secondary hover:text-foreground hover:-translate-y-px active:translate-y-px active:scale-[0.97] cursor-pointer"
            aria-label="Reset all hotkeys to defaults"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to Defaults
          </button>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          These keys run the AI actions during a meeting while a NexQ window is focused. Click a
          binding, then press the new key. Escape cancels.
        </p>
      </div>

      {/* Announces the recording state to screen readers (the region exists before its text changes). */}
      <p role="status" aria-live="polite" className="sr-only">
        {editingKey
          ? `Press a key for ${HOTKEY_ACTIONS.find((a) => a.id === editingKey)!.label}. Escape cancels.`
          : ""}
      </p>

      {/* Action keys (rebindable) */}
      <div className="overflow-hidden rounded-xl border border-border/30 bg-card/50">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/20 bg-secondary/20">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Action
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Binding
              </th>
            </tr>
          </thead>
          <tbody>
            {HOTKEY_ACTIONS.map(({ id: action, label }, idx, arr) => {
              const isEditing = editingKey === action;
              const binding = hotkeys[action] || DEFAULT_HOTKEYS[action];
              return (
                <tr
                  key={action}
                  className={`transition-colors duration-100 ${
                    isEditing ? "bg-primary/10" : "hover:bg-accent/50"
                  } ${idx < arr.length - 1 ? "border-b border-border/20" : ""}`}
                >
                  <td className="px-4 py-2.5 text-foreground/80">{label}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleRowClick(action)}
                        aria-label={`Change hotkey for ${label}, currently ${binding}`}
                        className="cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      >
                        {isEditing ? (
                          <span className="block animate-pulse rounded-lg bg-primary/20 px-2.5 py-1 font-mono text-primary">
                            Press a key...
                          </span>
                        ) : (
                          <kbd className="block rounded-lg bg-secondary/60 px-2 py-1 font-mono text-xs text-foreground">
                            {binding}
                          </kbd>
                        )}
                      </button>
                      {isEditing && (
                        <button
                          type="button"
                          onClick={handleCancelEdit}
                          className="rounded-lg px-2 py-1 text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          Cancel
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Keys that are not rebound here */}
      <div className="overflow-hidden rounded-xl border border-border/30 bg-card/50">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/20 bg-secondary/20">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Other shortcuts
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                Key
              </th>
            </tr>
          </thead>
          <tbody>
            {others.map(({ keys, action }, idx, arr) => (
              <tr key={action} className={idx < arr.length - 1 ? "border-b border-border/20" : ""}>
                <td className="px-4 py-2.5 text-foreground/80">{action}</td>
                <td className="px-4 py-2.5">
                  <kbd className="rounded-lg bg-secondary/60 px-2 py-1 font-mono text-xs text-foreground">
                    {keys}
                  </kbd>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Info */}
      <p className="text-xs text-muted-foreground/70">
        Changes are saved automatically. Action keys don't fire while you type in a text box.
      </p>
    </div>
  );
}
