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

/** Pixels between two items, and between two layers. */
export const ITEM_GAP = 4;
export const LAYER_GAP = 8;
/** One stroke and the space after it. */
export const STROKE = 2;
export const STROKE_GAP = 2;

export interface WaveSegment {
  id: string;
  layer: ContextLayer;
  title: string;
  /** Position and width in px inside a wave `widthPx` wide. */
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
  /** Room left in the budget, drawn as dots on the centre line. Null when it is used up. */
  free: { x: number; w: number; tokens: number } | null;
  axis: number;
  used: number;
  /** Found but cut by the budget (not drawn on the axis). */
  cut: ContextBar[];
}

interface Group {
  layer: ContextLayer;
  members: ContextBar[];
}

/** Fold bars thinner than `minPx` into neighbours of the same layer. */
function group(included: ContextBar[], pxPerToken: number, minPx: number): Group[] {
  const out: Group[] = [];
  for (const layer of CONTEXT_LAYERS) {
    const mine = included.filter((b) => b.layer === layer);
    let pending: ContextBar[] = [];
    const sum = (l: ContextBar[]) => l.reduce((n, b) => n + b.tokens, 0);
    const flush = (atEnd: boolean) => {
      if (pending.length === 0) return;
      const prev = out[out.length - 1];
      if (atEnd && sum(pending) * pxPerToken < minPx && prev && prev.layer === layer) {
        prev.members = [...prev.members, ...pending];
      } else {
        out.push({ layer, members: pending });
      }
      pending = [];
    };
    for (const b of mine) {
      if (b.tokens * pxPerToken >= minPx) {
        flush(false);
        out.push({ layer, members: [b] });
      } else {
        pending.push(b);
        if (sum(pending) * pxPerToken >= minPx) flush(false);
      }
    }
    flush(true);
  }
  return out;
}

function gapsOf(groups: Group[]): number {
  let total = 0;
  groups.forEach((g, i) => {
    if (i > 0) total += groups[i - 1].layer === g.layer ? ITEM_GAP : LAYER_GAP;
  });
  return total;
}

/**
 * One run per item in layer order: width follows the item's tokens, with 4 px
 * between items and 8 px between layers taken out of the width first. Runs that
 * would be thinner than `minBarPx` (three strokes) fold into their neighbours,
 * so 400 items stay legible. Pure, so it can be tested without a DOM.
 */
export function layoutContextBars(
  bars: readonly ContextBar[],
  opts: { budget: number; widthPx: number; minBarPx?: number },
): WaveLayout {
  const minBarPx = opts.minBarPx ?? 6;
  const W = Math.max(opts.widthPx, 1);
  const included = bars.filter((b) => b.included && b.tokens > 0);
  const cut = bars.filter((b) => !b.included);
  const used = included.reduce((n, b) => n + b.tokens, 0);
  const axis = Math.max(opts.budget, used, 1);

  const layers: LayerSpan[] = CONTEXT_LAYERS.map((layer) => {
    const mine = included.filter((b) => b.layer === layer);
    return { layer, tokens: mine.reduce((n, b) => n + b.tokens, 0), count: mine.length };
  });

  // Gaps shrink the room for tokens, and fewer groups mean fewer gaps: settle it in a few passes.
  let ppt = W / axis;
  let groups = group(included, ppt, minBarPx);
  for (let i = 0; i < 4; i++) {
    const next = Math.max(W - gapsOf(groups), 1) / axis;
    if (Math.abs(next - ppt) < 1e-9) break;
    ppt = next;
    groups = group(included, ppt, minBarPx);
  }

  const segments: WaveSegment[] = [];
  let x = 0;
  groups.forEach((g, i) => {
    if (i > 0) x += groups[i - 1].layer === g.layer ? ITEM_GAP : LAYER_GAP;
    const tokens = g.members.reduce((n, b) => n + b.tokens, 0);
    const w = tokens * ppt;
    segments.push({
      id: g.members.length === 1 ? g.members[0].id : `group:${g.layer}:${g.members[0].id}`,
      layer: g.layer,
      title: g.members.length === 1 ? g.members[0].title : `${g.members.length} smaller items`,
      x,
      w,
      tokens,
      relevance: Math.max(...g.members.map((b) => b.relevance)),
      pinned: g.members.some((b) => b.pinned),
      count: g.members.length,
      members: g.members,
    });
    x += w;
  });

  const start = segments.length > 0 ? x + LAYER_GAP : 0;
  const free = used < axis && W - start > STROKE ? { x: start, w: W - start, tokens: axis - used } : null;
  return { segments, layers, free, axis, used, cut };
}

/** 1,240 -> "1.2k", 24,000 -> "24k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** The colour of a layer. Instructions are a quiet neutral, never pure white. */
export function layerColor(layer: ContextLayer): string {
  return layer === "instructions" ? "hsl(var(--foreground) / 0.7)" : `hsl(var(--layer-${layer}))`;
}

/**
 * Stroke heights (0..1) for a run `w` px wide: a deterministic phrase from the
 * item's id, tapering at both ends, scaled by relevance. At least one stroke.
 */
export function strokeHeights(id: string, w: number, relevance: number): number[] {
  const n = Math.max(1, Math.floor((w + STROKE_GAP) / (STROKE + STROKE_GAP)));
  let seed = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    seed ^= id.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193);
  }
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const amp = 0.2 + 0.8 * Math.max(0, Math.min(1, relevance));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const swell = n === 1 ? 1 : Math.pow(Math.sin((Math.PI * (i + 0.5)) / n), 0.6);
    const grain = 0.4 + 0.6 * random();
    out.push(Math.max(0.1, amp * swell * grain));
  }
  return out;
}
