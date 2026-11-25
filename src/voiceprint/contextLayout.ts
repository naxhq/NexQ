import type { ContextBar, ContextLayer } from "../lib/types";

/** Drawing order of the five layers (also the legend order). */
export const CONTEXT_LAYERS: readonly ContextLayer[] = ["instructions", "meetings", "documents", "folders", "conversation"];

export const CONTEXT_LAYER_NAMES: Record<ContextLayer, string> = {
  instructions: "Instructions and memory",
  meetings: "Meetings",
  documents: "Documents",
  folders: "Folders",
  conversation: "Conversation",
};

export interface WaveSegment {
  id: string;
  layer: ContextLayer;
  title: string;
  /** Fractions of the axis, 0..1. */
  x: number;
  w: number;
  tokens: number;
  /** 0..1 (the largest of a group). */
  relevance: number;
  pinned: boolean;
  /** More than one item grouped together. */
  count: number;
  members: ContextBar[];
}

export interface LayerSpan {
  layer: ContextLayer;
  tokens: number;
  count: number;
}

export interface WaveLayout {
  segments: WaveSegment[];
  layers: LayerSpan[];
  /** The flat line: room left in the budget. Null when the budget is used up. */
  free: { x: number; w: number; tokens: number } | null;
  axis: number;
  used: number;
  /** Found but cut by the budget (not drawn on the axis). */
  cut: ContextBar[];
}

/**
 * One bar per included item, width = tokens, in layer order. Bars that would be
 * thinner than `minBarPx` are folded with their neighbours of the same layer, so
 * 400 items never become 400 slivers. Pure, so it can be tested without a DOM.
 */
export function layoutContextBars(
  bars: readonly ContextBar[],
  opts: { budget: number; widthPx: number; minBarPx?: number },
): WaveLayout {
  const minBarPx = opts.minBarPx ?? 3;
  const included = bars.filter((b) => b.included && b.tokens > 0);
  const cut = bars.filter((b) => !b.included);
  const used = included.reduce((n, b) => n + b.tokens, 0);
  const axis = Math.max(opts.budget, used, 1);
  const pxPerToken = Math.max(opts.widthPx, 1) / axis;

  const layers: LayerSpan[] = CONTEXT_LAYERS.map((layer) => {
    const mine = included.filter((b) => b.layer === layer);
    return { layer, tokens: mine.reduce((n, b) => n + b.tokens, 0), count: mine.length };
  });

  const segments: WaveSegment[] = [];
  let cursor = 0;
  for (const layer of CONTEXT_LAYERS) {
    const mine = included.filter((b) => b.layer === layer);
    let pending: ContextBar[] = [];
    let pendingStart = cursor;
    const push = (members: ContextBar[], x: number) => {
      const tokens = members.reduce((n, b) => n + b.tokens, 0);
      segments.push({
        id: members.length === 1 ? members[0].id : `group:${layer}:${members[0].id}`,
        layer,
        title: members.length === 1 ? members[0].title : `${members.length} smaller items`,
        x: x / axis,
        w: tokens / axis,
        tokens,
        relevance: Math.max(...members.map((b) => b.relevance)),
        pinned: members.some((b) => b.pinned),
        count: members.length,
        members,
      });
    };
    const flush = (atEnd: boolean) => {
      if (pending.length === 0) return;
      const tokens = pending.reduce((n, b) => n + b.tokens, 0);
      const prev = segments[segments.length - 1];
      if (atEnd && tokens * pxPerToken < minBarPx && prev && prev.layer === layer) {
        // A leftover sliver at the end of a layer joins the bar before it.
        segments.pop();
        push([...prev.members, ...pending], prev.x * axis);
      } else {
        push(pending, pendingStart);
      }
      pending = [];
    };
    for (const b of mine) {
      if (b.tokens * pxPerToken >= minBarPx) {
        flush(false);
        push([b], cursor);
      } else {
        if (pending.length === 0) pendingStart = cursor;
        pending.push(b);
      }
      cursor += b.tokens;
      if (pending.length > 0 && pending.reduce((n, p) => n + p.tokens, 0) * pxPerToken >= minBarPx) flush(false);
    }
    flush(true);
  }

  const free = used < axis ? { x: used / axis, w: (axis - used) / axis, tokens: axis - used } : null;
  return { segments, layers, free, axis, used, cut };
}

/** 1,240 -> "1.2k", 24,000 -> "24k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
