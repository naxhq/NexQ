import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Width and height of an element, kept up to date. Zero until measured (and where there is
 * no layout, as in tests): callers treat 0 as "plenty of room".
 */
export function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((p) => (p.w === w && p.h === h ? p : { w, h }));
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, size] as const;
}

/** Below this height a transcript drops its text toolbar and meters; the lines win. */
export const SHORT_TRANSCRIPT_PX = 220;
/** Below this height the assistant hides its text-size rows. */
export const SHORT_ASSISTANT_PX = 260;
/** A question card narrower than this puts its Assist button on its own line. */
export const NARROW_CARD_PX = 300;
