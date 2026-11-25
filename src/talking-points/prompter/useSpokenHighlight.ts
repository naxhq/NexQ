import { useEffect, type RefObject } from "react";
import type { FollowState, NoteIndex } from "../follow";
import type { DocBlock } from "../doc/model";
import { rangeUpTo } from "./measure";

/** The part of the current block already spoken, dimmed through the CSS highlight API where it exists. */
export function useSpokenHighlight(o: {
  blocks: DocBlock[];
  index: NoteIndex;
  curBlock: number;
  followPosition: number;
  followState: FollowState | "off";
  wantVoice: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
}): void {
  const { blocks, index, curBlock, followPosition, followState, wantVoice, contentRef } = o;
  useEffect(() => {
    const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!css?.highlights || !HighlightCtor) return;
    const content = contentRef.current;
    const block = blocks[curBlock];
    if (!content || !block || !wantVoice || followState !== "following") {
      css.highlights.delete("tp-spoken");
      return;
    }
    const span = index.blocks[curBlock];
    const el = content.querySelector(`[data-block-id="${block.id}"]`);
    const tok = Math.floor(followPosition);
    if (!el || !span || tok <= span.first || tok > span.end) {
      css.highlights.delete("tp-spoken");
      return;
    }
    const endChar = index.tokens[Math.min(tok, span.end) - 1]?.end ?? 0;
    const r = rangeUpTo(el, endChar);
    if (r) css.highlights.set("tp-spoken", new HighlightCtor(r));
    else css.highlights.delete("tp-spoken");
    return () => {
      css.highlights?.delete("tp-spoken");
    };
  }, [blocks, curBlock, followPosition, followState, wantVoice, index, contentRef]);
}
