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

/**
 * Where a floating box of `size` goes next to `anchor`: below it (above when
 * there is no room), aligned to its start or end edge, kept inside the viewport.
 */
export function placeBox(
  anchor: Anchor,
  size: { width: number; height: number },
  opts: { align?: "start" | "end" | "center"; gap?: number; prefer?: "below" | "above"; margin?: number } = {},
): { left: number; top: number; placement: "below" | "above" } {
  const { align = "start", gap = 6, prefer = "below", margin = 8 } = opts;
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  let left =
    align === "end" ? anchor.right - size.width : align === "center" ? anchor.left + anchor.width / 2 - size.width / 2 : anchor.left;
  left = Math.max(margin, Math.min(left, vw - size.width - margin));
  const roomBelow = vh - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const below = prefer === "below" ? roomBelow >= size.height || roomBelow >= roomAbove : roomAbove < size.height && roomBelow > roomAbove;
  const top = below ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - size.height);
  return { left, top, placement: below ? "below" : "above" };
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
