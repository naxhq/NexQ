import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/utils";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Accessible name when `label` is only an icon. */
  ariaLabel?: string;
}

export interface SegmentedProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Accessible name of the group. */
  label: string;
  className?: string;
}

/**
 * A few mutually exclusive choices (Lean / Balanced / Deep). A radio group:
 * one Tab stop, arrows move and choose, Home and End jump.
 */
export function Segmented<T extends string = string>({ value, onChange, options, label, className }: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const at = Math.max(
    options.findIndex((o) => o.value === value),
    0,
  );

  const go = (to: number, dir: 1 | -1) => {
    const n = options.length;
    for (let k = 0; k < n; k++) {
      const i = ((to + k * dir) % n + n) % n;
      if (!options[i].disabled) {
        onChange(options[i].value);
        refs.current[i]?.focus();
        return;
      }
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      go(at + 1, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      go(at - 1, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0, 1);
    } else if (e.key === "End") {
      e.preventDefault();
      go(options.length - 1, -1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className={cn("inline-flex gap-0.5 rounded-lg border border-border bg-[hsl(var(--ui-field))] p-0.5", className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            disabled={o.disabled}
            tabIndex={i === at ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "ui-body ui-r-md inline-flex h-7 items-center justify-center rounded-md px-3 outline-none ui-focus transition-colors duration-150 disabled:opacity-45",
              on ? "ui-raised font-medium text-foreground" : "text-muted-foreground hover:bg-[hsl(var(--ui-field-hover))] hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
