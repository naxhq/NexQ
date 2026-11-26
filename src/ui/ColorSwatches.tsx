import { useRef, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { WORKSPACE_HUES } from "./hues";

export interface ColorSwatchesProps {
  /** A hue id from WORKSPACE_HUES, or null for none. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Offer "No colour" as the first choice. */
  allowNone?: boolean;
  label?: string;
  className?: string;
}

/**
 * The eight workspace hues (never blue, green, amber or red) as a radio group.
 * The chosen one carries a check mark and the name is spoken, so colour is
 * not the only cue. Not a native colour input.
 */
export function ColorSwatches({ value, onChange, allowNone = true, label = "Workspace colour", className }: ColorSwatchesProps) {
  const choices: Array<{ id: string | null; name: string }> = [
    ...(allowNone ? [{ id: null, name: "No colour" }] : []),
    ...WORKSPACE_HUES.map((h) => ({ id: h.id, name: h.name })),
  ];
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const at = Math.max(
    choices.findIndex((c) => c.id === value),
    0,
  );

  const go = (i: number) => {
    const n = choices.length;
    const j = ((i % n) + n) % n;
    onChange(choices[j].id);
    refs.current[j]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(choices.length - 1);
    }
  };

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKey} className={cn("flex flex-wrap gap-2", className)}>
      {choices.map((c, i) => {
        const on = c.id === value;
        return (
          <button
            key={c.id ?? "none"}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c.name}
            tabIndex={i === at ? 0 : -1}
            onClick={() => onChange(c.id)}
            style={c.id ? { backgroundColor: `hsl(var(--hue-${c.id}))` } : undefined}
            className={cn(
              "ui-focus-pill flex h-6 w-6 items-center justify-center rounded-full outline-none ui-focus transition-shadow duration-150",
              !c.id && "border border-[hsl(var(--control-edge))]",
              on && "shadow-[0_0_0_2px_hsl(var(--background)),0_0_0_4px_hsl(var(--foreground)/0.75)]",
            )}
          >
            {on && c.id && <Check className="h-3.5 w-3.5 text-background" aria-hidden strokeWidth={3} />}
            {!c.id && <span className="h-px w-3.5 rotate-[-45deg] bg-[hsl(var(--control-edge))]" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
