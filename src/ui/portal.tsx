import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Floating UI renders inside the window's own React root (never a new native
 * window or a node outside it), so hide-from-screen-share and the window's
 * theme apply to it like to everything else.
 */
export function getPortalRoot(): HTMLElement {
  return document.getElementById("root") ?? document.body;
}

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, getPortalRoot());
}

export interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function anchorOf(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

export interface Placement {
  left: number;
  top: number;
  placement: "below" | "above";
  /** Apply as max-height (with overflow auto): the box never leaves the window. */
  maxHeight: number;
  /** Apply as max-width when the box is wider than the window. */
  maxWidth: number;
}

/**
 * Where a floating box of `size` goes next to `anchor`: below it (above when
 * there is no room), aligned to its start or end edge, and always kept inside the
 * viewport in both axes. A box too tall for the room on its side gets a max-height
 * (scrolls); with too little room on either side it covers the anchor rather than leaving
 * the window. `viewport` defaults to the window (tests pass their own).
 */
export function placeBox(
  anchor: Anchor,
  size: { width: number; height: number },
  opts: {
    align?: "start" | "end" | "center";
    gap?: number;
    prefer?: "below" | "above";
    margin?: number;
    viewport?: { width: number; height: number };
  } = {},
): Placement {
  const { align = "start", gap = 6, prefer = "below", margin = 8 } = opts;
  const vw = opts.viewport?.width ?? (typeof window === "undefined" ? 1024 : window.innerWidth);
  const vh = opts.viewport?.height ?? (typeof window === "undefined" ? 768 : window.innerHeight);
  const maxWidth = Math.max(0, vw - 2 * margin);
  const width = Math.min(size.width, maxWidth);
  let left =
    align === "end" ? anchor.right - width : align === "center" ? anchor.left + anchor.width / 2 - width / 2 : anchor.left;
  left = Math.max(margin, Math.min(left, vw - width - margin));

  const roomBelow = vh - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const below = prefer === "below" ? roomBelow >= size.height || roomBelow >= roomAbove : roomAbove < size.height && roomBelow > roomAbove;
  const room = below ? roomBelow : roomAbove;
  // Enough room on the chosen side for a usable box (or the whole thing): stay beside the anchor.
  const usable = Math.min(size.height, 160);
  const maxHeight = room >= usable ? room : Math.max(0, vh - 2 * margin);
  const height = Math.min(size.height, maxHeight);
  let top = below ? anchor.bottom + gap : anchor.top - gap - height;
  top = Math.max(margin, Math.min(top, vh - margin - height));
  return { left, top, placement: below ? "below" : "above", maxHeight, maxWidth };
}

/** Measure a floating element after it mounts, so it can be placed with its real size. */
export function useMeasured<T extends HTMLElement>(dep: unknown) {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
  }, [el, dep]);
  return { setEl, size };
}

/** Close on a press outside of `refs` (Escape is handled by each component). */
export function useDismiss(active: boolean, refs: Array<React.RefObject<Element | null>>, onDismiss: () => void) {
  useEffect(() => {
    if (!active) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && refs.some((r) => r.current?.contains(t))) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onDismiss]);
}

/**
 * For a popover that is positioned by CSS beside its opener (absolute, in a relative wrapper):
 * after every render, shift it sideways and cap its height so it stays inside the window.
 * Uses `translate` (not `transform`) so enter animations are left alone.
 */
export function keepInWindow(el: HTMLElement | null, margin = 8): void {
  if (!el) return;
  el.style.translate = "";
  el.style.maxHeight = "";
  let r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (r.height > vh - 2 * margin) {
    el.style.maxHeight = `${vh - 2 * margin}px`;
    el.style.overflowY = "auto";
    r = el.getBoundingClientRect();
  }
  let dx = 0;
  if (r.right > vw - margin) dx = vw - margin - r.right;
  if (r.left + dx < margin) dx = margin - r.left;
  let dy = 0;
  if (r.top < margin) dy = margin - r.top;
  else if (r.bottom > vh - margin) dy = vh - margin - r.bottom;
  if (dx || dy) el.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
}

export function useKeepInWindow<T extends HTMLElement>(ref: { current: T | null }) {
  useLayoutEffect(() => {
    keepInWindow(ref.current);
    const again = () => keepInWindow(ref.current);
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  });
}
