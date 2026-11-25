import { useEffect, useRef } from "react";
import { Minus, Plus } from "lucide-react";
import { READING_LIMITS, type ReadingSettings } from "../../stores/talkingPointsStore";
import { Switch } from "../../ui";

interface Props {
  reading: ReadingSettings;
  onChange: (patch: Partial<ReadingSettings>) => void;
  onClose: () => void;
  /** Said it needs your own voice; when it cannot work the switch says why. */
  saidItNote?: string | null;
}

function Stepper({
  label,
  value,
  shown,
  onMinus,
  onPlus,
  minusDisabled,
  plusDisabled,
}: {
  label: string;
  value: number;
  shown: string;
  onMinus: () => void;
  onPlus: () => void;
  minusDisabled: boolean;
  plusDisabled: boolean;
}) {
  const b =
    "inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40";
  return (
    <div className="flex items-center justify-between gap-3" role="group" aria-label={label}>
      <span className="ui-body">{label}</span>
      <span className="flex items-center gap-2">
        <button type="button" className={b} aria-label={`Decrease ${label.toLowerCase()}`} disabled={minusDisabled} onClick={onMinus}>
          <Minus className="h-3.5 w-3.5" aria-hidden />
        </button>
        <output aria-live="polite" aria-label={`${label} value`} data-value={value} className="ui-body w-12 text-center tabular-nums">
          {shown}
        </output>
        <button type="button" className={b} aria-label={`Increase ${label.toLowerCase()}`} disabled={plusDisabled} onClick={onPlus}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    </div>
  );
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** How the note reads: size, spacing, speed, and whether lines are ticked as you say them. */
export function ReadingSettingsPopover({ reading, onChange, onClose, saidItNote }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const L = READING_LIMITS;

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !(t as Element).closest?.("[data-reading-trigger]")) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Reading settings"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else e.stopPropagation();
      }}
      className="absolute right-1.5 top-full z-30 mt-1 w-[min(17rem,calc(100%-0.75rem))] space-y-3 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <Stepper
        label="Text size"
        value={reading.fontSize}
        shown={`${reading.fontSize}`}
        minusDisabled={reading.fontSize <= L.fontSize.min}
        plusDisabled={reading.fontSize >= L.fontSize.max}
        onMinus={() => onChange({ fontSize: Math.max(L.fontSize.min, reading.fontSize - L.fontSize.step) })}
        onPlus={() => onChange({ fontSize: Math.min(L.fontSize.max, reading.fontSize + L.fontSize.step) })}
      />
      <Stepper
        label="Line spacing"
        value={reading.lineSpacing}
        shown={reading.lineSpacing.toFixed(1)}
        minusDisabled={reading.lineSpacing <= L.lineSpacing.min + 0.001}
        plusDisabled={reading.lineSpacing >= L.lineSpacing.max - 0.001}
        onMinus={() => onChange({ lineSpacing: r1(Math.max(L.lineSpacing.min, reading.lineSpacing - L.lineSpacing.step)) })}
        onPlus={() => onChange({ lineSpacing: r1(Math.min(L.lineSpacing.max, reading.lineSpacing + L.lineSpacing.step)) })}
      />
      <Stepper
        label="Speed"
        value={reading.wpm}
        shown={`${reading.wpm}`}
        minusDisabled={reading.wpm <= L.wpm.min}
        plusDisabled={reading.wpm >= L.wpm.max}
        onMinus={() => onChange({ wpm: Math.max(L.wpm.min, reading.wpm - L.wpm.step) })}
        onPlus={() => onChange({ wpm: Math.min(L.wpm.max, reading.wpm + L.wpm.step) })}
      />
      <p className="ui-meta -mt-1.5 text-muted-foreground">Speed is words a minute, used by auto-scroll.</p>
      <Switch
        checked={reading.saidIt}
        onChange={(saidIt) => onChange({ saidIt })}
        label="Tick what I have said"
        description={saidItNote ?? "Lines settle back as you say them. Click a tick to change it."}
      />
      <Switch
        checked={reading.suggest}
        onChange={(suggest) => onChange({ suggest })}
        label="Suggest where I am"
        description="When you wander to another point, offer a jump instead of moving on its own."
      />
    </div>
  );
}
