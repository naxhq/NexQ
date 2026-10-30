import { useEffect, useState } from "react";
import { showToast } from "../stores/toastStore";
import { acceleratorFromEvent, formatShortcut, normalizeAccelerator, reservedShortcutAction } from "../lib/shortcutLabel";

interface ShortcutButtonProps {
  value: string;
  defaultValue: string;
  onChange: (accelerator: string) => void;
  /** Other user shortcuts this one must not take, with the action each belongs to. */
  others?: Record<string, string>;
}

/**
 * A rebindable global shortcut: click, then the next Ctrl/Cmd/Alt combination
 * becomes the shortcut; Esc cancels.
 */
export function ShortcutButton({ value, defaultValue, onChange, others = {} }: ShortcutButtonProps) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const accel = acceleratorFromEvent(e);
      if (!accel) return;
      const taken =
        reservedShortcutAction(accel) ??
        Object.entries(others).find(([other]) => normalizeAccelerator(other) === normalizeAccelerator(accel))?.[1];
      if (taken) {
        // Keep listening: the current binding (and the other action) stay as they are.
        showToast(`${formatShortcut(accel)} is already used by "${taken}"`, "error");
        return;
      }
      onChange(accel);
      setRecording(false);
      showToast(`Shortcut set to ${formatShortcut(accel)}`, "success");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording, onChange, others]);

  return (
    <div className="flex items-center gap-2">
      {value !== defaultValue && !recording && (
        <button
          onClick={() => onChange(defaultValue)}
          className="rounded-md px-2 py-1 text-meta text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
        >
          Reset
        </button>
      )}
      <button
        onClick={() => setRecording((r) => !r)}
        aria-label={recording ? "Press the new shortcut, or Escape to cancel" : `Change shortcut, currently ${formatShortcut(value)}`}
        className={`rounded-lg px-2.5 py-1 font-mono text-xs transition-colors duration-150 cursor-pointer ${
          recording ? "bg-primary/15 text-primary ring-1 ring-primary/30" : "bg-secondary/60 text-foreground hover:bg-secondary"
        }`}
      >
        {recording ? "Press keys…" : formatShortcut(value)}
      </button>
    </div>
  );
}
