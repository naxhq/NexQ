import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../lib/utils";
import type { ContextBar, ContextLayer, ContextLayerInfo } from "../lib/types";
import {
  CONTEXT_LAYERS,
  CONTEXT_LAYER_NAMES,
  STROKE,
  STROKE_GAP,
  formatTokens,
  layerColor,
  layoutContextBars,
  legendText,
  strokeHeights,
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
  /**
   * What the answer used, as the report counts it (the whole prompt). Said in the summary so the
   * number reads the same as in the composer and the panel; the bars still draw their own tokens.
   */
  used?: number;
  /**
   * What each layer holds in scope (`ContextReport.layers`). A layer that is searched for each question
   * says so in the legend and shows a faint outline in the room left; the outline is never counted as used.
   */
  layers?: ContextLayerInfo[];
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
export function ContextWave({ bars, window: modelWindow, budget, used, layers, onSelect, height = 64, className }: ContextWaveProps) {
  const box = useRef<HTMLElement | null>(null);
  const width = useWidth(box);
  const [asList, setAsList] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  const layout = useMemo(() => layoutContextBars(bars, { budget, widthPx: width, layers, total: used }), [bars, budget, width, layers, used]);
  const { segments, free, hints } = layout;
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

  const summary = `Using ${formatTokens(used ?? layout.used)} of ${formatTokens(budget)} tokens`;
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
          className="ui-meta rounded-md px-1.5 py-0.5 text-muted-foreground underline-offset-2 outline-none ui-focus hover:text-foreground hover:underline"
        >
          {asList ? "View as graph" : "View as list"}
        </button>
      </div>

      {asList ? (
        <ContextList bars={bars} layers={layers} onSelect={select} />
      ) : (
        <>
          <div
            role="group"
            aria-label="Context graph, one bar per item. Use the left and right arrow keys."
            onKeyDown={onKey}
            className="relative w-full"
            style={{ height }}
          >
            {/* Room left: the same rhythm at minimum height, on the centre line. */}
            {free ? (
              <div
                aria-hidden
                className="ui-dots absolute h-[2px]"
                style={{ left: free.x, width: free.w, top: height / 2 - 1 }}
              />
            ) : null}
            {/* What a question may still find, outlined and not counted: layers that are searched, not sent. */}
            {hints.map((h) => (
              <div
                key={h.layer}
                aria-hidden
                data-wave-hint={h.layer}
                title={`${CONTEXT_LAYER_NAMES[h.layer]}: searched when you ask, ${formatTokens(h.available)} tokens in scope`}
                className="absolute rounded-[3px] border border-dashed"
                style={{ left: h.x, width: h.w, top: Math.round(height * 0.28), height: Math.round(height * 0.44), borderColor: layerColor(h.layer), opacity: 0.5 }}
              />
            ))}
            {segments.length === 0 && (
              <div aria-hidden className="ui-dots absolute inset-x-0 h-[2px]" style={{ top: height / 2 - 1 }} />
            )}
            {segments.map((seg, i) => {
              const heights = strokeHeights(seg.id, seg.w, seg.relevance);
              const dim = hovered !== null && hovered !== seg.id;
              return (
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
                  className="ui-focus-sm absolute top-0 h-full cursor-pointer outline-none ui-focus"
                  style={{ left: seg.x, width: Math.max(seg.w, STROKE) }}
                >
                  <svg
                    aria-hidden
                    width={Math.max(seg.w, STROKE)}
                    height={height}
                    className="block overflow-visible"
                    style={{ opacity: dim ? 0.3 : hovered === seg.id ? 1 : 0.88, transition: "opacity 160ms var(--ui-ease)" }}
                  >
                    {heights.map((h, k) => {
                      const hh = Math.max(3, Math.round(h * (height - 8)));
                      return (
                        <rect
                          key={k}
                          x={k * (STROKE + STROKE_GAP)}
                          width={STROKE}
                          rx={1}
                          fill={layerColor(seg.layer)}
                          className="ui-wave-rect"
                          style={{ y: (height - hh) / 2, height: hh }}
                        />
                      );
                    })}
                  </svg>
                  {seg.pinned && seg.count === 1 && (
                    <span aria-hidden className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 rounded-full bg-foreground" />
                  )}
                </button>
              );
            })}
          </div>

          <p role="status" aria-live="polite" className="ui-meta mt-1.5 min-h-[1.1rem] text-muted-foreground">
            {readoutSeg ? describe(readoutSeg) : segments.length === 0 ? "Nothing in the context yet" : " "}
          </p>

          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {layout.layers.map((l) => {
              const info = layers?.find((i) => i.layer === l.layer);
              const searched = !!info?.searched && info.available > 0;
              return (
                <li key={l.layer}>
                  <button
                    type="button"
                    disabled={l.count === 0}
                    onClick={() => select(l.layer, bars.filter((b) => b.layer === l.layer && b.included))}
                    className={cn(
                      "ui-meta inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 outline-none ui-focus hover:bg-accent disabled:hover:bg-transparent",
                      l.count === 0 && !searched && "disabled:opacity-50",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn("h-2 w-2 rounded-[2px]", searched && l.count === 0 && "border border-dashed bg-transparent")}
                      style={searched && l.count === 0 ? { borderColor: layerColor(l.layer) } : { background: layerColor(l.layer) }}
                    />
                    <span>{CONTEXT_LAYER_NAMES[l.layer]}</span>
                    <span className="text-muted-foreground">{legendText(l.layer, l.tokens, info)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function ContextList({ bars, layers, onSelect }: { bars: ContextBar[]; layers?: ContextLayerInfo[]; onSelect: (layer: ContextLayer, bars: ContextBar[]) => void }) {
  const rows = useMemo(
    () =>
      CONTEXT_LAYERS.flatMap((layer) => bars.filter((b) => b.layer === layer)),
    [bars],
  );
  const searched = (layers ?? []).filter((l) => l.searched && l.available > 0);
  if (rows.length === 0 && searched.length === 0) return <p className="ui-body py-2 text-muted-foreground">Nothing in the context yet.</p>;
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
                  className="max-w-full truncate rounded-md text-left outline-none ui-focus hover:underline"
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
      {searched.length > 0 && (
        <ul aria-label="Searched when you ask" className="ui-meta mt-1.5 space-y-0.5 text-muted-foreground">
          {searched.map((l) => (
            <li key={l.layer}>
              {CONTEXT_LAYER_NAMES[l.layer]}: searched when you ask, {formatTokens(l.available)} tokens {l.layer === "documents" ? "in all" : "indexed"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
