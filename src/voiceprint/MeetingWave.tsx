import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
  /** Height of the bars in px. */
  height?: number;
  className?: string;
}

/** A 4 px bar and 3 px of air; the button is the whole 7 px so there is no dead space. */
const PITCH = 7;
const BAR = 4;
const MIN_SHARE = 0.22;

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

/** Bar height share: square root of length so a long call does not flatten the rest, with a clear floor. */
export function meetingBarShare(seconds: number | null, longest: number): number {
  if (!seconds || seconds <= 0 || longest <= 0) return MIN_SHARE;
  return MIN_SHARE + (1 - MIN_SHARE) * Math.sqrt(Math.min(1, seconds / longest));
}

/** Month labels: at the first meeting of each month, skipping any that would touch the one before. */
export function monthTicks(dates: string[], minGapBars = 8): Array<{ index: number; label: string }> {
  const out: Array<{ index: number; label: string }> = [];
  let lastKey = "";
  let lastIndex = -Infinity;
  dates.forEach((d, i) => {
    const t = new Date(d);
    if (Number.isNaN(t.getTime())) return;
    const key = `${t.getFullYear()}-${t.getMonth()}`;
    if (key === lastKey) return;
    lastKey = key;
    if (i - lastIndex < minGapBars) return;
    const month = t.toLocaleDateString(undefined, { month: "short" });
    out.push({ index: i, label: t.getMonth() === 0 || out.length === 0 ? `${month} ${t.getFullYear()}` : month });
    lastIndex = i;
  });
  return out;
}

/**
 * The workspace header: one 4 px bar per meeting, oldest to newest, left to
 * right, height = how long it ran. The line of dots after the last bar is the
 * recording still to come. Click or Enter opens a meeting; the label shows on
 * hover and focus. Long histories scroll, starting at the newest.
 */
export function MeetingWave({ meetings, onOpen, hue = null, height = 32, className }: MeetingWaveProps) {
  const ordered = useMemo(
    () => [...meetings].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
    [meetings],
  );
  const longest = useMemo(() => Math.max(0, ...ordered.map((m) => m.duration_seconds ?? 0)), [ordered]);
  const ticks = useMemo(() => monthTicks(ordered.map((m) => m.date)), [ordered]);
  const [focusIdx, setFocusIdx] = useState(Math.max(ordered.length - 1, 0));
  const [tip, setTip] = useState<{ id: string; anchor: Anchor } | null>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const at = Math.min(focusIdx, Math.max(ordered.length - 1, 0));

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setFade({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
    measure();
  }, [ordered.length]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  const color = hueColor(hue);

  if (ordered.length === 0) {
    return <div aria-hidden className={cn("ui-dots", className)} style={{ height }} />;
  }

  const mask =
    fade.left || fade.right
      ? `linear-gradient(90deg, ${fade.left ? "transparent, #000 24px" : "#000, #000 0"}, ${fade.right ? "#000 calc(100% - 24px), transparent" : "#000 100%, #000 100%"})`
      : undefined;

  return (
    <div
      ref={scroller}
      onScroll={measure}
      className={cn("w-full overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
      style={{ WebkitMaskImage: mask, maskImage: mask }}
    >
      <div className="flex min-w-full items-start">
        <div className="shrink-0">
          <div
            role="group"
            aria-label={`${ordered.length} meetings, oldest to newest. Use the left and right arrow keys.`}
            onKeyDown={onKey}
            className="flex"
            style={{ height }}
          >
            {ordered.map((m, i) => (
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
                className="group ui-focus-sm flex h-full cursor-pointer items-center justify-center outline-none ui-focus"
                style={{ width: PITCH }}
              >
                <span
                  aria-hidden
                  className="ui-wave-bar block rounded-full opacity-75 group-hover:opacity-100 group-focus-visible:opacity-100"
                  style={{
                    width: BAR,
                    height: "100%",
                    background: color,
                    transform: `scaleY(${meetingBarShare(m.duration_seconds, longest)})`,
                  }}
                />
              </button>
            ))}
          </div>
          <div aria-hidden className="relative h-5" style={{ width: ordered.length * PITCH }}>
            {ticks.map((t) => (
              <span
                key={t.index}
                className="ui-meta absolute top-0.5 whitespace-nowrap text-muted-foreground/80"
                style={{ left: t.index * PITCH + (PITCH - BAR) / 2 }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>
        <div aria-hidden className="ui-dots ml-2 min-w-0 flex-1" style={{ height }} />
      </div>
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
