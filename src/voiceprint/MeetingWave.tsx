import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../lib/utils";
import { hueColor } from "../ui/hues";
import { TooltipBubble } from "../ui/Tooltip";
import { anchorOf, type Anchor } from "../ui/portal";

export interface WaveMeeting {
  id: string;
  title: string;
  /** ISO date or any string Date understands. */
  date: string;
  /** Length in seconds; null = unknown (drawn at the minimum). */
  duration_seconds: number | null;
}

export interface MeetingWaveProps {
  meetings: WaveMeeting[];
  onOpen: (id: string) => void;
  /** Workspace hue id for the bars. */
  hue?: string | null;
  /** Height in px. */
  height?: number;
  className?: string;
}

function formatDuration(s: number | null): string {
  if (!s || s <= 0) return "length unknown";
  const m = Math.round(s / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
}

function formatDate(d: string): string {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The workspace header: one bar per meeting, oldest to newest, height = how long
 * it ran. Click or Enter opens it; the label shows on hover and focus.
 */
export function MeetingWave({ meetings, onOpen, hue = null, height = 28, className }: MeetingWaveProps) {
  const ordered = useMemo(
    () => [...meetings].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
    [meetings],
  );
  const longest = useMemo(() => Math.max(1, ...ordered.map((m) => m.duration_seconds ?? 0)), [ordered]);
  const [focusIdx, setFocusIdx] = useState(Math.max(ordered.length - 1, 0));
  const [tip, setTip] = useState<{ id: string; anchor: Anchor } | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const at = Math.min(focusIdx, Math.max(ordered.length - 1, 0));

  const focusAt = (i: number) => {
    const j = Math.max(0, Math.min(i, ordered.length - 1));
    setFocusIdx(j);
    refs.current[j]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusAt(at + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusAt(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(ordered.length - 1);
    } else if (e.key === "Escape") {
      setTip(null);
    }
  };

  const tipMeeting = tip ? ordered.find((m) => m.id === tip.id) : undefined;

  if (ordered.length === 0) {
    return <div aria-hidden className={cn("h-px w-full bg-muted-foreground/40", className)} />;
  }

  return (
    <div
      role="group"
      aria-label={`${ordered.length} meetings, oldest to newest. Use the left and right arrow keys.`}
      onKeyDown={onKey}
      className={cn("flex w-full items-center gap-[2px] overflow-x-auto", className)}
      style={{ height }}
    >
      {ordered.map((m, i) => {
        const h = 0.14 + 0.86 * ((m.duration_seconds ?? 0) / longest);
        return (
          <button
            key={m.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            tabIndex={i === at ? 0 : -1}
            aria-label={`${m.title}, ${formatDate(m.date)}, ${formatDuration(m.duration_seconds)}`}
            onClick={() => onOpen(m.id)}
            onFocus={(e) => {
              setFocusIdx(i);
              setTip({ id: m.id, anchor: anchorOf(e.currentTarget) });
            }}
            onBlur={() => setTip((t) => (t?.id === m.id ? null : t))}
            onMouseEnter={(e) => setTip({ id: m.id, anchor: anchorOf(e.currentTarget) })}
            onMouseLeave={() => setTip((t) => (t?.id === m.id ? null : t))}
            className="group flex h-full min-w-[4px] max-w-[10px] flex-1 cursor-pointer items-center rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring/80"
          >
            <span
              aria-hidden
              className="ui-wave-bar block w-full rounded-[2px] opacity-80 group-hover:opacity-100 group-focus-visible:opacity-100"
              style={{ height: "100%", background: hueColor(hue), transform: `scaleY(${h})` }}
            />
          </button>
        );
      })}
      {tip && tipMeeting && (
        <TooltipBubble anchor={tip.anchor}>
          <span className="block font-medium">{tipMeeting.title}</span>
          <span className="block text-muted-foreground">
            {formatDate(tipMeeting.date)}, {formatDuration(tipMeeting.duration_seconds)}
          </span>
        </TooltipBubble>
      )}
    </div>
  );
}
