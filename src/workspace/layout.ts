import { useEffect, useState, type RefObject } from "react";

/** Spec section 10: three panels from 1100, Library as a sheet from 820, a rail of marks below. */
export type ShellMode = "wide" | "medium" | "narrow";

export const WIDE_MIN = 1100;
export const MEDIUM_MIN = 820;

export function shellModeFor(width: number): ShellMode {
  if (width >= WIDE_MIN) return "wide";
  if (width >= MEDIUM_MIN) return "medium";
  return "narrow";
}

export const RAIL_MIN = 200;
export const RAIL_MAX = 360;
export const RAIL_DEFAULT = 264;
export const LIBRARY_MIN = 280;
export const LIBRARY_MAX = 460;
export const LIBRARY_DEFAULT = 340;
export const NARROW_RAIL = 56;

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** The element's own width (a container measurement), falling back to the window where nothing is laid out. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1200 : window.innerWidth));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      setWidth(w > 0 ? Math.round(w) : window.innerWidth);
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Below this pane height the header is one line even on the start screen: the chat needs the room. */
export const SHORT_PANE = 640;

/** The element's own width and height (container measurements), falling back to the window where nothing is laid out. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: typeof window === "undefined" ? 1200 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const next = { width: r.width > 0 ? Math.round(r.width) : window.innerWidth, height: r.height > 0 ? Math.round(r.height) : window.innerHeight };
      setSize((cur) => (cur.width === next.width && cur.height === next.height ? cur : next));
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
