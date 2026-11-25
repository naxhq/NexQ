import { useEffect, useRef } from "react";
import { Minus, Plus } from "lucide-react";
import { READING_LIMITS, type ReadingSettings } from "../../stores/talkingPointsStore";
import { Switch } from "../../ui";

interface Props {
  reading: ReadingSettings;
  onChange: (patch: Partial<ReadingSettings>) => void;
  /** Said it needs your own voice; when it cannot work the switch says why. */
  saidItNote?: string | null;
  /** Honest word about the language being spoken (nothing for English and French). */
  languageNote?: string | null;
}

function Stepper({
  label,
  value,
  min,
  max,
  shown,
  valueText,
  onMinus,
  onPlus,
  minusDisabled,
  plusDisabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  shown: string;
  /** Said by a screen reader when focus lands on the value or it changes with the arrow keys. */
  valueText: string;
  onMinus: () => void;
  onPlus: () => void;
  minusDisabled: boolean;
  plusDisabled: boolean;
}) {
  const b =
    "inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted text-foreground outline-none transition-colors hover:bg-accent ui-focus ui-r-md disabled:opacity-40";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="ui-body">{label}</span>
      <span className="flex items-center gap-2">
        <button type="button" className={b} aria-label={`Decrease ${label.toLowerCase()}`} disabled={minusDisabled} onClick={onMinus}>
          <Minus className="h-3.5 w-3.5" aria-hidden />
        </button>
        <span
          role="spinbutton"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={valueText}
          onKeyDown={(e) => {
            if ((e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "PageUp") && !plusDisabled) {
              e.preventDefault();
              onPlus();
            } else if ((e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "PageDown") && !minusDisabled) {
              e.preventDefault();
              onMinus();
            }
          }}
          className="ui-body w-12 rounded-md text-center tabular-nums outline-none ui-focus ui-r-md"
        >
          {shown}
        </span>
        <button type="button" className={b} aria-label={`Increase ${label.toLowerCase()}`} disabled={plusDisabled} onClick={onPlus}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    </div>
  );
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** How the note reads: size, spacing, speed, and whether lines are ticked as you say them. */
export function ReadingSettingsPopover({ reading, onChange, saidItNote, languageNote }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const L = READING_LIMITS;

  // placed, dismissed and refocused by the shared Popover around it
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  return (
    <div
      ref={ref}
      onKeyDown={(e) => e.stopPropagation()}
      className="w-72 max-w-full space-y-3 p-3"
    >
      <Stepper
        label="Text size"
        value={reading.fontSize}
        min={L.fontSize.min}
        max={L.fontSize.max}
        shown={`${reading.fontSize}`}
        valueText={`${reading.fontSize} pixels`}
        minusDisabled={reading.fontSize <= L.fontSize.min}
        plusDisabled={reading.fontSize >= L.fontSize.max}
        onMinus={() => onChange({ fontSize: Math.max(L.fontSize.min, reading.fontSize - L.fontSize.step) })}
        onPlus={() => onChange({ fontSize: Math.min(L.fontSize.max, reading.fontSize + L.fontSize.step) })}
      />
      <Stepper
        label="Line spacing"
        value={reading.lineSpacing}
        min={L.lineSpacing.min}
        max={L.lineSpacing.max}
        shown={reading.lineSpacing.toFixed(1)}
        valueText={`${reading.lineSpacing.toFixed(1)} times the text size`}
        minusDisabled={reading.lineSpacing <= L.lineSpacing.min + 0.001}
        plusDisabled={reading.lineSpacing >= L.lineSpacing.max - 0.001}
        onMinus={() => onChange({ lineSpacing: r1(Math.max(L.lineSpacing.min, reading.lineSpacing - L.lineSpacing.step)) })}
        onPlus={() => onChange({ lineSpacing: r1(Math.min(L.lineSpacing.max, reading.lineSpacing + L.lineSpacing.step)) })}
      />
      <Stepper
        label="Speed"
        value={reading.wpm}
        min={L.wpm.min}
        max={L.wpm.max}
        shown={`${reading.wpm}`}
        valueText={`${reading.wpm} words a minute`}
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
        description={
          <>
            {saidItNote ?? "Lines settle back as you say them. Click a tick to change it."}
            {languageNote && <span className="mt-1 block">{languageNote}</span>}
          </>
        }
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
