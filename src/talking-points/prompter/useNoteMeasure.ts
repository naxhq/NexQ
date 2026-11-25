/**
 * Measures the rendered note for the scroll controller, once per frame at most,
 * whenever the note, its type size or the region's size changes.
 */
import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import type { NoteIndex, ScrollController } from "../follow";
import { measureLines } from "./measure";
import { FOCUS_RATIO } from "./prompterTypes";

export function useNoteMeasure(opts: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  ctrl: MutableRefObject<ScrollController>;
  indexRef: MutableRefObject<NoteIndex>;
  /** Anything that changes how the note lays out. */
  layoutKey: unknown[];
}): () => void {
  const { scrollRef, contentRef, ctrl, indexRef, layoutKey } = opts;
  const measureRaf = useRef(0);

  const scheduleMeasure = useCallback(() => {
    if (measureRaf.current) return;
    measureRaf.current = requestAnimationFrame(() => {
      measureRaf.current = 0;
      const el = scrollRef.current;
      const content = contentRef.current;
      if (!el || !content) return;
      content.style.paddingBottom = `${Math.round(el.clientHeight * (1 - FOCUS_RATIO))}px`;
      try {
        const lines = measureLines(content, indexRef.current);
        ctrl.current.setMetrics({ lines, contentHeight: el.scrollHeight, viewportHeight: el.clientHeight });
      } catch {
        /* a measuring failure leaves manual scrolling working */
      }
    });
  }, [scrollRef, contentRef, ctrl, indexRef]);

  useEffect(() => {
    scheduleMeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...layoutKey, scheduleMeasure]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => scheduleMeasure());
    ro.observe(el);
    if (content) ro.observe(content);
    void (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(scheduleMeasure);
    return () => {
      ro.disconnect();
      if (measureRaf.current) cancelAnimationFrame(measureRaf.current);
      measureRaf.current = 0;
    };
  }, [scrollRef, contentRef, scheduleMeasure]);

  return scheduleMeasure;
}
