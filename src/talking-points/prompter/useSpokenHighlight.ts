import { useEffect, type RefObject } from "react";
import type { SpokenEnd } from "./spoken";
import { rangeUpTo } from "./measure";

/** The part of the current block already spoken, dimmed through the CSS highlight API where it exists. */
export function useSpokenHighlight(spoken: SpokenEnd | null, contentRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!css?.highlights || !HighlightCtor) return;
    const content = contentRef.current;
    const el = spoken && content ? content.querySelector(`[data-block-id="${spoken.blockId}"]`) : null;
    const r = el && spoken ? rangeUpTo(el, spoken.endChar) : null;
    if (r) css.highlights.set("tp-spoken", new HighlightCtor(r));
    else css.highlights.delete("tp-spoken");
    return () => {
      css.highlights?.delete("tp-spoken");
    };
  }, [spoken, contentRef]);
}
