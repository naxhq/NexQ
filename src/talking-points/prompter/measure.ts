/**
 * Measures the rendered note for the scroll controller: one entry per visual line,
 * with the first and last token on it. DOM only here; the grouping is pure.
 */
import type { LineMetric, NoteIndex } from "../follow";

export interface TokenBox {
  block: number;
  top: number;
  bottom: number;
}

/** Groups token boxes (in reading order) into lines. A token starts a new line when it begins below the line so far. */
export function groupLines(boxes: readonly (TokenBox | null)[]): LineMetric[] {
  const lines: LineMetric[] = [];
  let cur: LineMetric | null = null;
  let curBottom = 0;
  let curBlock = -1;
  boxes.forEach((b, i) => {
    if (!b) {
      if (cur) cur.endToken = i + 1;
      return;
    }
    const height = Math.max(1, b.bottom - b.top);
    const newLine = !cur || b.block !== curBlock || b.top >= curBottom - Math.min(4, height * 0.25);
    if (newLine) {
      cur = { startToken: i, endToken: i + 1, top: b.top, height };
      curBottom = b.bottom;
      curBlock = b.block;
      lines.push(cur);
    } else if (cur) {
      cur.endToken = i + 1;
      cur.top = Math.min(cur.top, b.top);
      curBottom = Math.max(curBottom, b.bottom);
      cur.height = curBottom - cur.top;
    }
  });
  return lines;
}

interface Piece {
  node: Text;
  from: number;
  to: number;
}

/** Text nodes of a block with their offsets in the block's text (a line break counts as one character). */
export function piecesOf(el: Element): Piece[] {
  const out: Piece[] = [];
  let off = 0;
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      const len = (n as Text).data.length;
      out.push({ node: n as Text, from: off, to: off + len });
      off += len;
    } else if (n.nodeType === 1) {
      const e = n as Element;
      if (e.hasAttribute("data-tp-skip")) return;
      if (e.tagName === "BR") off += 1;
      else for (const c of Array.from(e.childNodes)) walk(c);
    }
  };
  for (const c of Array.from(el.childNodes)) walk(c);
  return out;
}

/**
 * Lines of the rendered note. `root` is the scrolling content; tops are relative to
 * its top edge (content pixels).
 */
export function measureLines(root: HTMLElement, index: NoteIndex): LineMetric[] {
  const rootTop = root.getBoundingClientRect().top - root.scrollTop;
  const range = document.createRange();
  const boxes: (TokenBox | null)[] = new Array(index.tokens.length).fill(null);
  const els = new Map<string, Element>();
  root.querySelectorAll("[data-block-id]").forEach((e) => els.set(e.getAttribute("data-block-id")!, e));

  index.blocks.forEach((span, bi) => {
    const el = els.get(span.id);
    if (!el || span.end <= span.first) return;
    const pieces = piecesOf(el);
    let p = 0;
    for (let t = span.first; t < span.end; t++) {
      const off = index.tokens[t].start;
      while (p < pieces.length - 1 && off >= pieces[p].to) p++;
      const piece = pieces[p];
      if (!piece) break;
      const at = Math.max(0, Math.min(piece.node.data.length - 1, off - piece.from));
      try {
        range.setStart(piece.node, at);
        range.setEnd(piece.node, Math.min(piece.node.data.length, at + 1));
      } catch {
        continue;
      }
      const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) continue;
      boxes[t] = { block: bi, top: r.top - rootTop, bottom: r.bottom - rootTop };
    }
  });
  return groupLines(boxes);
}

/** A range from the start of a block's text to character `endChar` (the part already spoken). */
export function rangeUpTo(blockEl: Element, endChar: number): Range | null {
  const pieces = piecesOf(blockEl);
  if (pieces.length === 0 || endChar <= 0) return null;
  const range = document.createRange();
  range.setStart(pieces[0].node, 0);
  let last = pieces[0];
  for (const p of pieces) if (p.from < endChar) last = p;
  range.setEnd(last.node, Math.max(0, Math.min(last.node.data.length, endChar - last.from)));
  return range;
}
