import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../lib/utils";
import type { ContextBar, ContextLayer } from "../lib/types";
import {
  CONTEXT_LAYERS,
  CONTEXT_LAYER_NAMES,
  formatTokens,
  layoutContextBars,
  type WaveSegment,
} from "./contextLayout";

export interface ContextSelection {
  layer: ContextLayer;
  /** The item (one bar) or the items of a group or of the whole layer. */
  bars: ContextBar[];
}

export interface ContextWaveProps {
  bars: ContextBar[];
  /** The model's real window, in tokens (shown, not drawn). */
  window: number;
  /** The token allowance the wave is drawn against. */
  budget: number;
  /** Click or Enter on a bar, a group, or a layer in the legend. */
  onSelect?: (selection: ContextSelection) => void;
  /** Height of the wave in px. */
  height?: number;
  className?: string;
}

function describe(seg: WaveSegment): string {
  const layer = CONTEXT_LAYER_NAMES[seg.layer];
  if (seg.count > 1) return `${layer}: ${seg.count} smaller items, ${seg.tokens.toLocaleString()} tokens`;
  return `${layer}: ${seg.title}, ${seg.tokens.toLocaleString()} tokens, relevance ${Math.round(seg.relevance * 100)} percent${seg.pinned ? ", pinned" : ""}`;
}

function useWidth(ref: React.RefObject<HTMLElement | null>, fallback = 640) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const next = el.getBoundingClientRect().width;
      if (next > 0) setW((cur) => (Math.abs(cur - next) < 1 ? cur : next));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/**
 * What an answer saw, as a waveform. Bar width is the item's tokens, height its
 * relevance, grouped in five labelled layers; the flat line at the end is the
 * room left. Bars move only when the data changes. Everything is also a list
 * ("View as list"), and the bars are reachable with the arrow keys.
 */
export function ContextWave({ bars, window: modelWindow, budget, onSelect, height = 64, className }: ContextWaveProps) {
  const box = useRef<HTMLElement | null>(null);
  const width = useWidth(box);
  const [asList, setAsList] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  const layout = useMemo(() => layoutContextBars(bars, { budget, widthPx: width }), [bars, budget, width]);
  const { segments, free } = layout;
  const at = Math.min(focusIdx, Math.max(segments.length - 1, 0));
  const readoutSeg = segments.find((s) => s.id === hovered) ?? null;

  const select = (layer: ContextLayer, members: ContextBar[]) => onSelect?.({ layer, bars: members });

  const focusAt = (i: number) => {
    const j = Math.max(0, Math.min(i, segments.length - 1));
    setFocusIdx(j);
    items.current[j]?.focus();
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
      focusAt(segments.length - 1);
    }
  };

  const summary = `Using ${formatTokens(layout.used)} of ${formatTokens(budget)} tokens`;
  const sub = `Model window ${formatTokens(modelWindow)}${layout.cut.length ? `, ${layout.cut.length} found but cut` : ""}`;

  return (
    <section ref={box} aria-label="What the answer saw" className={cn("w-full", className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <p className="ui-meta text-muted-foreground">
          <span className="font-medium text-foreground">{summary}</span>
          <span className="ml-2">{sub}</span>
        </p>
        <button
          type="button"
          aria-pressed={asList}
          onClick={() => setAsList((v) => !v)}
          className="ui-meta rounded-md px-1.5 py-0.5 text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {asList ? "View as graph" : "View as list"}
        </button>
      </div>

      {asList ? (
        <ContextList bars={bars} onSelect={select} />
      ) : (
        <>
          <div
            role="group"
            aria-label="Context graph, one bar per item. Use the left and right arrow keys."
            onKeyDown={onKey}
            className="relative w-full"
            style={{ height }}
          >
            {/* Room left: a flat line, silence between phrases. */}
            <div
              aria-hidden
              className="absolute bottom-1/2 h-px bg-muted-foreground/40"
              style={{ left: `${(free ? free.x : 1) * 100}%`, width: `${(free ? free.w : 0) * 100}%` }}
            />
            {segments.length === 0 && (
              <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-muted-foreground/40" />
            )}
            {segments.map((seg, i) => (
              <button
                key={seg.id}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                tabIndex={i === at ? 0 : -1}
                aria-label={describe(seg)}
                onClick={() => select(seg.layer, seg.members)}
                onFocus={() => {
                  setFocusIdx(i);
                  setHovered(seg.id);
                }}
                onBlur={() => setHovered((h) => (h === seg.id ? null : h))}
                onMouseEnter={() => setHovered(seg.id)}
                onMouseLeave={() => setHovered((h) => (h === seg.id ? null : h))}
                className="group absolute top-0 h-full cursor-pointer rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/80"
                style={{
                  left: `${seg.x * 100}%`,
                  width: `max(calc(${seg.w * 100}% - 1px), 2px)`,
                }}
              >
                <span
                  aria-hidden
                  className="ui-wave-bar absolute inset-0 rounded-[3px] opacity-85 group-hover:opacity-100 group-focus-visible:opacity-100"
                  style={{
                    background: `hsl(var(--layer-${seg.layer}))`,
                    transform: `scaleY(${0.12 + 0.88 * Math.max(0, Math.min(1, seg.relevance))})`,
                  }}
                />
                {seg.pinned && (
                  <span
                    aria-hidden
                    className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 rounded-full bg-foreground"
                  />
                )}
              </button>
            ))}
          </div>

          <p role="status" aria-live="polite" className="ui-meta mt-1.5 min-h-[1.1rem] text-muted-foreground">
            {readoutSeg ? describe(readoutSeg) : segments.length === 0 ? "Nothing in the context yet" : " "}
          </p>

          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {layout.layers.map((l) => (
              <li key={l.layer}>
                <button
                  type="button"
                  disabled={l.count === 0}
                  onClick={() => select(l.layer, bars.filter((b) => b.layer === l.layer && b.included))}
                  className="ui-meta inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-[2px]"
                    style={{ background: `hsl(var(--layer-${l.layer}))` }}
                  />
                  <span>{CONTEXT_LAYER_NAMES[l.layer]}</span>
                  <span className="text-muted-foreground">{l.count === 0 ? "none" : formatTokens(l.tokens)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ContextList({ bars, onSelect }: { bars: ContextBar[]; onSelect: (layer: ContextLayer, bars: ContextBar[]) => void }) {
  const rows = useMemo(
    () =>
      CONTEXT_LAYERS.flatMap((layer) => bars.filter((b) => b.layer === layer)),
    [bars],
  );
  if (rows.length === 0) return <p className="ui-body py-2 text-muted-foreground">Nothing in the context yet.</p>;
  return (
    <div className="max-h-72 overflow-y-auto">
      <table className="ui-body w-full border-collapse text-left">
        <caption className="sr-only">Every item the answer saw or left out</caption>
        <thead className="ui-meta text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">Item</th>
            <th scope="col" className="py-1 pr-3 font-medium">Layer</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Tokens</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Relevance</th>
            <th scope="col" className="py-1 font-medium">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id} className={cn("border-t border-border", !b.included && "text-muted-foreground")}>
              <td className="max-w-[16rem] py-1 pr-3">
                <button
                  type="button"
                  onClick={() => onSelect(b.layer, [b])}
                  className="max-w-full truncate rounded-md text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {b.title}
                </button>
              </td>
              <td className="py-1 pr-3">{CONTEXT_LAYER_NAMES[b.layer]}</td>
              <td className="py-1 pr-3 text-right">{b.tokens.toLocaleString()}</td>
              <td className="py-1 pr-3 text-right">{Math.round(b.relevance * 100)}%</td>
              <td className="py-1">{[b.included ? "Included" : "Cut", b.pinned ? "pinned" : null].filter(Boolean).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
