import { useEffect, useState } from "react";
import { OPACITY_LEVELS, levelIndex } from "./backing";

const SHOWN_MS = 1600;

/**
 * A small level meter that appears for a moment when the eye button moves to the next level:
 * one bar per level, the current one filled, and the percentage beside it. It is its own solid
 * little chip (never see-through) so it reads over whatever is behind the window.
 */
export function OpacityLevelIndicator({ level, shownAt }: { level: number; shownAt: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!shownAt) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), SHOWN_MS);
    return () => clearTimeout(t);
  }, [shownAt]);
  if (!visible) return null;
  const at = levelIndex(level);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="opacity-level"
      className="pointer-events-none fixed right-3 top-12 z-50 flex items-center gap-2 rounded-lg border border-border/60 bg-popover px-2.5 py-1.5 text-[11px] font-medium text-popover-foreground shadow-lg"
      style={{ textShadow: "none" }}
    >
      <span className="flex items-end gap-[3px]" aria-hidden="true">
        {OPACITY_LEVELS.map((l, i) => (
          <span
            key={l}
            className={`w-[5px] rounded-sm ${i <= at ? "bg-primary" : "bg-muted-foreground/30"}`}
            style={{ height: 6 + (OPACITY_LEVELS.length - 1 - i) * 2.5 }}
          />
        ))}
      </span>
      <span className="tabular-nums">{Math.round(level * 100)}% opaque</span>
    </div>
  );
}
