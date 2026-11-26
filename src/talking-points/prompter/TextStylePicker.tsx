import { useEffect, useRef, useState } from "react";
import type { TextStyleId } from "../../stores/talkingPointsStore";
import { cn } from "../../lib/utils";
import { FRAME_MS, PREVIEW_FRAMES, PREVIEW_LINES, STILL_FRAME, TEXT_STYLES, type TextStylePreset } from "./textStyles";
import "../talkingPoints.css";

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A small box that draws four lines in the preset and, while `playing`, walks them through the states. */
function Preview({ id, playing }: { id: TextStyleId; playing: boolean }) {
  const [frame, setFrame] = useState(STILL_FRAME);
  useEffect(() => {
    if (!playing || prefersReducedMotion()) {
      setFrame(STILL_FRAME);
      return;
    }
    setFrame(0);
    const t = window.setInterval(() => setFrame((f) => (f + 1) % PREVIEW_FRAMES.length), FRAME_MS);
    return () => window.clearInterval(t);
  }, [playing]);
  const states = PREVIEW_FRAMES[frame];
  return (
    <div
      aria-hidden
      data-preview={id}
      data-playing={playing ? "" : undefined}
      className="tp-doc tp-read tp-preview"
      data-dim="on"
      data-style={id}
    >
      {PREVIEW_LINES.map((text, i) => (
        <p key={i} data-block-id={`p${i}`} data-state={states[i]}>
          {text}
        </p>
      ))}
    </div>
  );
}

function Card({ preset, selected, focusable, onPick, onKeyDown, setRef }: {
  preset: TextStylePreset;
  selected: boolean;
  focusable: boolean;
  onPick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  setRef: (el: HTMLButtonElement | null) => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <button
      ref={setRef}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${preset.name}. ${preset.blurb}`}
      tabIndex={focusable ? 0 : -1}
      onClick={onPick}
      onKeyDown={onKeyDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      className={cn(
        "tp-style-card group flex min-w-0 flex-col gap-1.5 rounded-xl p-2 text-left outline-none ui-focus ui-r-xl",
        "bg-card ring-1 ring-inset transition-[box-shadow,background-color] duration-150",
        selected ? "ring-2 ring-primary" : "ring-border hover:bg-accent/40",
      )}
    >
      <Preview id={preset.id} playing={hover || focus} />
      <span className="flex items-center gap-1.5">
        <span className="ui-body font-medium text-foreground">{preset.name}</span>
        {selected && <span className="ui-meta text-primary-text">Selected</span>}
      </span>
      <span className="ui-meta text-muted-foreground">{preset.blurb}</span>
    </button>
  );
}

/** Five cards, one choice. Arrow keys move between them; hovering or focusing a card plays its preview. */
export function TextStylePicker({ value, onChange }: { value: TextStyleId; onChange: (id: TextStyleId) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, TEXT_STYLES.findIndex((s) => s.id === value));
  const move = (to: number) => {
    const n = (to + TEXT_STYLES.length) % TEXT_STYLES.length;
    onChange(TEXT_STYLES[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Text style" className="grid grid-cols-2 gap-2">
      {TEXT_STYLES.map((p, i) => (
        <Card
          key={p.id}
          preset={p}
          selected={p.id === value}
          focusable={i === index}
          setRef={(el) => (refs.current[i] = el)}
          onPick={() => onChange(p.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(i + 1);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(i - 1);
            }
          }}
        />
      ))}
    </div>
  );
}
