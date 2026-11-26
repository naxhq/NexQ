import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { clamp } from "./layout";
import { cn } from "../lib/utils";

/**
 * A draggable divider between two panels. Pointer events only (no HTML5 drag
 * and drop); arrow keys move it 16 px, Home and double click reset it.
 * `grow` is +1 when dragging right makes the panel bigger (a left panel) and
 * -1 for a panel on the right.
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  fallback,
  grow,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  fallback: number;
  grow: 1 | -1;
  onChange: (n: number) => void;
}) {
  const start = useRef<{ x: number; value: number } | null>(null);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, value };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (s) onChange(clamp(s.value + (e.clientX - s.x) * grow, min, max));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    start.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") onChange(clamp(value - step * grow, min, max));
    else if (e.key === "ArrowRight") onChange(clamp(value + step * grow, min, max));
    else if (e.key === "Home") onChange(fallback);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={() => onChange(fallback)}
      className={cn(
        "group relative z-10 -mx-px w-2 shrink-0 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors",
        "hover:after:w-0.5 hover:after:bg-foreground/30 focus-visible:after:w-0.5 focus-visible:after:bg-ring",
      )}
    />
  );
}
