// Pointer and keyboard interaction of the dock: live drag geometry, drop preview, tab and
// separator handling. Moved out of Dock.tsx unchanged; Dock owns the state it works on.
import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  type DockAction,
  type Layout,
  type PanelId,
  describeDock,
  visibleDropLabel,
  findNode,
  panelsOf,
} from "./layoutModel";
import {
  type DropHit,
  type Geometry,
  type PanelMeta,
  type SepGeo,
  type StackGeo,
  computeGeometry,
  hitTest,
  resizeFromDelta,
  resizeBounds,
  sameHit,
  snapCandidates,
} from "./layoutGeometry";

import type { DockPanelDef } from "./Dock";
import { DRAG_THRESHOLD, KEY_STEP, KEY_STEP_BIG, setRect, withSizes, type SepDrag, type TabDrag } from "./dockShared";

export interface InteractionCtx {
  layout: Layout;
  panels: Record<PanelId, DockPanelDef>;
  dispatch: (a: DockAction) => void;
  rootRef: React.RefObject<HTMLDivElement>;
  geoRef: React.MutableRefObject<Geometry>;
  metas: Record<PanelId, PanelMeta>;
  focusPanel: PanelId | undefined;
  setFocusPanel: (p: PanelId | undefined) => void;
  menu: { panel: PanelId } | null;
  setMenu: (m: { panel: PanelId } | null) => void;
  act: (a: DockAction, message?: string) => void;
  say: (msg: string) => void;
  focusTabAfter: (panel: PanelId) => void;
  title: (id: PanelId) => string;
  dragRef: React.MutableRefObject<TabDrag | SepDrag | null>;
  previewRef: React.RefObject<HTMLDivElement>;
  caretRef: React.RefObject<HTMLDivElement>;
  ghostRef: React.RefObject<HTMLDivElement>;
  previewShown: React.MutableRefObject<boolean>;
  cleanup: React.MutableRefObject<(() => void) | null>;
  ghostIconRef: React.RefObject<HTMLSpanElement>;
  ghostNameRef: React.RefObject<HTMLSpanElement>;
  ghostDoRef: React.RefObject<HTMLDivElement>;
  /** The first few successful drags show the one-line note. */
  showNote: boolean;
}

export function useDockInteractions(ctx: InteractionCtx) {
  const {
    layout, dispatch, rootRef, geoRef, metas, focusPanel, setFocusPanel, setMenu,
    act, say, focusTabAfter, title, dragRef, previewRef, caretRef, ghostRef, previewShown, cleanup,
    ghostIconRef, ghostNameRef, ghostDoRef, showNote,
  } = ctx;
  const ghostW = useRef(0);
  const ghostH = useRef(0);
  const lastSaid = useRef("");
  /* ---- imperative live geometry (60 fps, commit on release) ---- */
  const applyGeo = useCallback((g: Geometry) => {
    const root = rootRef.current;
    if (!root) return;
    const q = (attr: string, id: string) => root.querySelector<HTMLElement>(`[${attr}="${id}"]`);
    for (const s of g.stacks) {
      setRect(q("data-dock-surface", s.id), s.rect);
      setRect(q("data-dock-tabbar", s.id), s.tabBar.h ? s.tabBar : s.rect);
      setRect(q("data-dock-strip", s.id), s.rect);
    }
    for (const [p, v] of Object.entries(g.panels)) if (v.visible) setRect(q("data-dock-panel", p), v.rect);
    for (const sp of g.separators) setRect(q("data-dock-sep", sp.id), sp.rect);
  }, []);

  /* ---- drop preview ---- */
  const showPreview = useCallback((hit: DropHit | null, index?: number) => {
    const el = previewRef.current;
    const caret = caretRef.current;
    if (el) {
      if (!hit) {
        el.style.opacity = "0";
        previewShown.current = false;
      } else {
        const r = hit.preview;
        if (!previewShown.current) {
          el.style.transition = "none";
          setRect(el, r);
          void el.offsetWidth;
          el.style.transition = "";
          previewShown.current = true;
        } else {
          setRect(el, r);
        }
        el.style.opacity = "1";
      }
    }
    if (caret) {
      const root = rootRef.current;
      if (hit?.onTabBar && hit.stackId && root && index !== undefined) {
        const bar = root.querySelector<HTMLElement>(`[data-dock-tabbar="${hit.stackId}"]`);
        const tabs = Array.from(bar?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
        const rr = root.getBoundingClientRect();
        const t = tabs[index] ?? tabs[tabs.length - 1];
        if (t && bar) {
          const tr = t.getBoundingClientRect();
          const x = (tabs[index] ? tr.left : tr.right) - rr.left;
          const b = bar.getBoundingClientRect();
          caret.style.transform = `translate3d(${x - 1}px, ${b.top - rr.top + 6}px, 0)`;
          caret.style.opacity = "1";
          return;
        }
      }
      caret.style.opacity = "0";
    }
  }, []);

  const endDrag = useCallback(
    (restore: boolean) => {
      cleanup.current?.();
      cleanup.current = null;
      const d = dragRef.current;
      dragRef.current = null;
      const root = rootRef.current;
      root?.removeAttribute("data-dragging");
      root?.removeAttribute("data-hit");
      root?.removeAttribute("data-note");
      root?.removeAttribute("data-notepos");
      if (ghostRef.current) ghostRef.current.style.display = "none";
      showPreview(null);
      root?.querySelectorAll("[data-dragging]").forEach((n) => n.removeAttribute("data-dragging"));
      root?.querySelectorAll('[data-active="true"]').forEach((n) => n.setAttribute("data-active", "false"));
      if (restore && d) applyGeo(geoRef.current);
    },
    [applyGeo, showPreview],
  );

  const watchCancel = useCallback(
    (onCancel: () => void) => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      };
      const onBlur = () => onCancel();
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onBlur);
      cleanup.current = () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onBlur);
      };
    },
    [],
  );

  /* ---- tab dragging ---- */
  const insertionIndex = (stackId: string, clientX: number, dragged: PanelId): number | undefined => {
    const bar = rootRef.current?.querySelector<HTMLElement>(`[data-dock-tabbar="${stackId}"]`);
    const tabs = Array.from(bar?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    let p = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) {
        p = i;
        break;
      }
    }
    const from = tabs.findIndex((t) => t.id === `nq-tab-${dragged}`);
    return from >= 0 ? (p > from ? p - 1 : p) : p;
  };

  const tabPointerDown = (e: ReactPointerEvent<HTMLElement>, panel: PanelId, st: StackGeo) => {
    if (e.button !== 0 || dragRef.current) return;
    setFocusPanel(panel);
    if (layout.locked || st.virtual) return;
    dragRef.current = { kind: "tab", panel, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, started: false, hit: null };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable */
    }
  };

  const updateTabDrag = (e: ReactPointerEvent<HTMLElement>, d: TabDrag) => {
    const root = rootRef.current;
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const x = e.clientX - rr.left;
    const y = e.clientY - rr.top;
    const g = geoRef.current;
    // The note never covers what is under the pointer: it moves to the top when the pointer is low.
    const notePos = y > g.size.h * 0.8 ? "top" : "bottom";
    if (root.getAttribute("data-notepos") !== notePos) root.setAttribute("data-notepos", notePos);
    const docked = panelsOf(layout.root).length;
    const hit = hitTest(g, x, y, d.panel, docked > 1);
    const index = hit?.onTabBar && hit.stackId ? insertionIndex(hit.stackId, e.clientX, d.panel) : undefined;
    if (!sameHit(hit, d.hit) || index !== d.index || !d.said) {
      if (!sameHit(hit, d.hit) || !d.said) {
        // One object makes the highlight, the chip's second line and the spoken text, and the words
        // describe what this window will show (a small one may stack what a big one puts side by side).
        d.said = true;
        const over = x >= 0 && y >= 0 && x < g.size.w && y < g.size.h;
        const label = over
          ? visibleDropLabel(layout, hit ? { target: hit.target, zone: hit.zone } : null, d.panel, title, g.size, metas)
          : "Move over an outlined area";
        lastSaid.current = `${title(d.panel)}: ${label}`;
        say(lastSaid.current);
        if (ghostDoRef.current) ghostDoRef.current.textContent = label;
        if (ghostRef.current) {
          ghostW.current = ghostRef.current.offsetWidth;
          ghostH.current = ghostRef.current.offsetHeight;
        }
        root.setAttribute("data-hit", hit ? "true" : "false");
      }
      d.hit = hit;
      d.index = index;
      showPreview(hit, hit?.onTabBar ? tabInsertionPosition(hit.stackId!, e.clientX) : undefined);
    }
    // The chip is placed last, with the width of the words it now carries.
    if (ghostRef.current) {
      // Off the pointer's hot area (down and to the right), flipped at the window's edges, never outside.
      let gx = x + 20;
      if (gx + ghostW.current > g.size.w - 4) gx = x - ghostW.current - 14;
      let gy = y + 24;
      if (gy + ghostH.current > g.size.h - 4) gy = y - ghostH.current - 16;
      gx = Math.min(Math.max(4, gx), Math.max(4, g.size.w - ghostW.current - 4));
      gy = Math.min(Math.max(4, gy), Math.max(4, g.size.h - ghostH.current - 4));
      ghostRef.current.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
    }
    // auto-scroll an overflowing tab bar under the pointer
    autoScroll(e.clientX, hit);
  };

  const tabInsertionPosition = (stackId: string, clientX: number): number => {
    const bar = rootRef.current?.querySelector<HTMLElement>(`[data-dock-tabbar="${stackId}"]`);
    const tabs = Array.from(bar?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return tabs.length;
  };

  const scrollRaf = useRef(0);
  const autoScroll = (clientX: number, hit: DropHit | null) => {
    cancelAnimationFrame(scrollRaf.current);
    if (!hit?.onTabBar || !hit.stackId) return;
    const sc = rootRef.current?.querySelector<HTMLElement>(`[data-dock-tabbar="${hit.stackId}"] .nq-dock-tabscroll`);
    if (!sc || sc.scrollWidth <= sc.clientWidth) return;
    const r = sc.getBoundingClientRect();
    const edge = 28;
    const dir = clientX < r.left + edge ? -1 : clientX > r.right - edge ? 1 : 0;
    if (!dir) return;
    const tick = () => {
      sc.scrollLeft += dir * 10;
      scrollRaf.current = requestAnimationFrame(tick);
    };
    scrollRaf.current = requestAnimationFrame(tick);
  };

  const tabPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "tab" || d.pointerId !== e.pointerId) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.started = true;
      rootRef.current?.setAttribute("data-dragging", "true");
      e.currentTarget.setAttribute("data-dragging", "true");
      const root = rootRef.current;
      root?.setAttribute("data-hit", "false");
      root?.setAttribute("data-note", showNote ? "true" : "false");
      if (ghostNameRef.current) ghostNameRef.current.textContent = title(d.panel);
      if (ghostDoRef.current) ghostDoRef.current.textContent = "Move over an outlined area";
      if (ghostIconRef.current) {
        const icon = (e.currentTarget as HTMLElement).querySelector("[data-tab-icon]");
        ghostIconRef.current.innerHTML = icon?.innerHTML ?? "";
      }
      if (ghostRef.current) {
        ghostRef.current.style.display = "block";
        ghostW.current = ghostRef.current.offsetWidth;
        ghostH.current = ghostRef.current.offsetHeight;
      }
      watchCancel(() => {
        cancelAnimationFrame(scrollRaf.current);
        endDrag(false);
        say("Move cancelled");
      });
    }
    updateTabDrag(e, d);
  };

  const tabPointerUp = (e: ReactPointerEvent<HTMLElement>, panel: PanelId) => {
    const d = dragRef.current;
    if (!d || d.kind !== "tab" || d.pointerId !== e.pointerId) return;
    cancelAnimationFrame(scrollRaf.current);
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    const { started, hit, index } = d;
    endDrag(false);
    if (!started) {
      act({ type: "activate", panel });
      return;
    }
    if (hit) {
      const a: DockAction = { type: "dock", panel, target: hit.target, zone: hit.zone, index };
      focusTabAfter(panel);
      // The drop was already announced as the pointer settled on it: not again.
      const said = describeDock(layout, a, title);
      act(a, said === lastSaid.current ? undefined : said);
      // Only a finished drag counts (Escape and pointer-cancel never get here).
      dispatch({ type: "countDrag" });
    }
  };

  const tabPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "tab" || d.pointerId !== e.pointerId) return;
    cancelAnimationFrame(scrollRaf.current);
    endDrag(false);
  };

  /* ---- tab keyboard ---- */
  const openMenu = (panel: PanelId) => {
    // Locked: the menu opens anyway and says so, with an Unlock item.
    setMenu({ panel });
  };

  const tabKeyDown = (e: ReactKeyboardEvent<HTMLElement>, panel: PanelId, st: StackGeo) => {
    const i = st.panels.indexOf(panel);
    const go = (j: number) => {
      const p = st.panels[(j + st.panels.length) % st.panels.length];
      setFocusPanel(p);
      act({ type: "activate", panel: p });
      focusTabAfter(p);
    };
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && e.shiftKey && !st.virtual) {
      const to = e.key === "ArrowLeft" ? i - 1 : i + 1;
      if (to >= 0 && to < st.panels.length) {
        focusTabAfter(panel);
        act({ type: "reorder", panel, index: to }, `${title(panel)}: tab ${to + 1} of ${st.panels.length}`);
      }
    } else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(st.panels.length - 1);
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey) || (e.key === "ArrowDown" && e.altKey)) {
      openMenu(panel);
    } else return;
    e.preventDefault();
  };

  /* ---- separators ---- */
  const sepName = (sep: SepGeo) => {
    const n = findNode(layout.root, sep.splitId);
    if (!n || n.kind !== "split") return "Resize panels";
    const a = panelsOf(n.children[sep.index])[0];
    const b = panelsOf(n.children[sep.index + 1])[0];
    return `Resize ${title(a)} and ${title(b)}`;
  };

  const sepPointerDown = (e: ReactPointerEvent<HTMLElement>, sep: SepGeo) => {
    if (e.button !== 0 || dragRef.current || layout.locked) return;
    const g = geoRef.current;
    dragRef.current = {
      kind: "sep",
      sep,
      pointerId: e.pointerId,
      start: sep.axis === "x" ? e.clientX : e.clientY,
      snaps: snapCandidates(g, sep),
      sizes: null,
    };
    e.currentTarget.setAttribute("data-active", "true");
    rootRef.current?.setAttribute("data-dragging", "true");
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable */
    }
    watchCancel(() => endDrag(true));
  };

  const sepPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "sep" || d.pointerId !== e.pointerId) return;
    const cur = d.sep.axis === "x" ? e.clientX : e.clientY;
    const res = resizeFromDelta(d.sep, cur - d.start, e.altKey ? [] : d.snaps);
    d.sizes = res.sizes;
    applyGeo(computeGeometry(withSizes(layout, d.sep.splitId, res.sizes), geoRef.current.size, metas, undefined, focusPanel));
  };

  const sepPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "sep" || d.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    const sizes = d.sizes;
    const splitId = d.sep.splitId;
    endDrag(false);
    if (sizes) act({ type: "resize", splitId, sizes });
  };

  const sepPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "sep" || d.pointerId !== e.pointerId) return;
    endDrag(true);
  };

  const sepKeyDown = (e: ReactKeyboardEvent<HTMLElement>, sep: SepGeo) => {
    if (layout.locked) return;
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const less = sep.axis === "x" ? "ArrowLeft" : "ArrowUp";
    const more = sep.axis === "x" ? "ArrowRight" : "ArrowDown";
    let delta: number | null = null;
    const b = resizeBounds(sep);
    if (e.key === less) delta = -step;
    else if (e.key === more) delta = step;
    else if (e.key === "Home") delta = b.min;
    else if (e.key === "End") delta = b.max;
    else if (e.key === "Enter") {
      act({ type: "equalize", splitId: sep.splitId, index: sep.index }, "Panels evened out");
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    const res = resizeFromDelta(sep, delta);
    const n = findNode(layout.root, sep.splitId);
    const a = n && n.kind === "split" ? panelsOf(n.children[sep.index])[0] : "";
    act(
      { type: "resize", splitId: sep.splitId, sizes: res.sizes },
      `${title(a)} ${Math.round(((res.pos - sep.span[0]) / Math.max(1, sep.span[1] - sep.span[0])) * 100)} percent`,
    );
  };

  return {
    tabPointerDown, tabPointerMove, tabPointerUp, tabPointerCancel, tabKeyDown, openMenu,
    sepName, sepPointerDown, sepPointerMove, sepPointerUp, sepPointerCancel, sepKeyDown,
  };
}
