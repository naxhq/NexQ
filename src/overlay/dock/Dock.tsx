import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";
import "./dock.css";
import {
  type DockAction,
  type DockState,
  type Layout,
  type PanelId,
  allPanels,
  describeDock,
  findNode,
  leaves,
  moveOptions,
  panelsOf,
} from "./layoutModel";
import {
  type DropHit,
  type Geometry,
  type PanelMeta,
  type Rect,
  type SepGeo,
  type StackGeo,
  computeGeometry,
  hitTest,
  readingBackingAlpha,
  resizeFromDelta,
  resizeBounds,
  sameHit,
  snapCandidates,
} from "./layoutGeometry";
import { DockMenu, type DockMenuItem } from "./DockMenu";

export interface DockPanelDef {
  title: string;
  icon?: ReactNode;
  /** Mounted once, only ever moved and resized by style. */
  node: ReactNode;
  minW?: number;
  minH?: number;
  prefW?: number;
  /** Default true. */
  canHide?: boolean;
  /** Reading panel: keeps an 85% backing when the window is translucent. */
  reading?: boolean;
}

export interface DockProps {
  panels: Record<PanelId, DockPanelDef>;
  state: DockState;
  dispatch: (a: DockAction) => void;
  /** 0..1 overlay window opacity; drives --dock-reading-alpha. Default 1. */
  windowOpacity?: number;
  /** Fixed container size (tests); otherwise measured. */
  size?: { w: number; h: number };
  className?: string;
  /** Small per-panel actions drawn at the end of the tab bar when that panel is active. */
  renderTabExtra?: (panel: PanelId) => ReactNode;
}

const DRAG_THRESHOLD = 6;
const KEY_STEP = 16;
const KEY_STEP_BIG = 64;

const rectStyle = (r: Rect): CSSProperties => ({
  transform: `translate3d(${r.x}px, ${r.y}px, 0)`,
  width: r.w,
  height: r.h,
});
function setRect(el: HTMLElement | null, r: Rect) {
  if (!el) return;
  el.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
}

function withSizes(layout: Layout, splitId: string, sizes: number[]): Layout {
  const l = JSON.parse(JSON.stringify(layout)) as Layout;
  const n = findNode(l.root, splitId);
  if (n && n.kind === "split") n.sizes = sizes;
  return l;
}

function useContainerSize(ref: React.RefObject<HTMLElement | null>, override?: { w: number; h: number }) {
  const [s, setS] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (override) return;
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setS((p) => (p.w === w && p.h === h ? p : { w, h }));
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, override]);
  return override ?? s;
}

type TabDrag = {
  kind: "tab";
  panel: PanelId;
  pointerId: number;
  sx: number;
  sy: number;
  started: boolean;
  hit: DropHit | null;
  index?: number;
};
type SepDrag = {
  kind: "sep";
  sep: SepGeo;
  pointerId: number;
  start: number;
  snaps: number[];
  sizes: number[] | null;
};

export function Dock({
  panels,
  state,
  dispatch,
  windowOpacity = 1,
  size: sizeOverride,
  className,
  renderTabExtra,
}: DockProps) {
  const layout = state.layout;
  const rootRef = useRef<HTMLDivElement>(null);
  const size = useContainerSize(rootRef, sizeOverride);
  const [live, setLive] = useState("");
  const [menu, setMenu] = useState<{ panel: PanelId } | null>(null);
  const [focusPanel, setFocusPanel] = useState<PanelId | undefined>();
  const lastRects = useRef<Record<PanelId, Rect>>({});
  const dragRef = useRef<TabDrag | SepDrag | null>(null);
  const focusedPanel = useRef<PanelId | null>(null);
  const fixup = useRef<PanelId | null>(null);
  const pendingTabFocus = useRef<PanelId | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const previewShown = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);

  const metaKey = Object.entries(panels)
    .map(([id, p]) => `${id}:${p.minW ?? ""}:${p.minH ?? ""}:${p.prefW ?? ""}`)
    .join("|");
  const metas = useMemo(() => {
    const m: Record<PanelId, PanelMeta> = {};
    for (const [id, p] of Object.entries(panels)) {
      m[id] = { minW: p.minW ?? 180, minH: p.minH ?? 120, prefW: p.prefW };
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaKey]);

  const geo = useMemo(
    () => computeGeometry(layout, size, metas, undefined, focusPanel),
    [layout, size.w, size.h, metas, focusPanel],
  );
  const geoRef = useRef(geo);
  geoRef.current = geo;

  // A panel brought forward from outside (a key, a header button, the Ask box) must also
  // be the one a compact, single-stack view shows.
  const seen = useRef<{ active: Record<string, string>; strips: Record<string, boolean>; docked: Set<PanelId> } | null>(null);
  useEffect(() => {
    const stacks = leaves(layout.root);
    const now = {
      active: Object.fromEntries(stacks.map((s) => [s.id, s.active])),
      strips: Object.fromEntries(stacks.map((s) => [s.id, s.collapsed])),
      docked: new Set(panelsOf(layout.root)),
    };
    const prev = seen.current;
    seen.current = now;
    if (!prev) return;
    let forward: PanelId | undefined;
    for (const s of stacks) {
      if (prev.active[s.id] !== undefined && (prev.active[s.id] !== s.active || (prev.strips[s.id] && !s.collapsed))) {
        forward = s.active;
      }
    }
    for (const p of now.docked) if (!prev.docked.has(p)) forward = p;
    if (forward) setFocusPanel(forward);
  }, [layout]);

  const title = useCallback((id: PanelId) => panels[id]?.title ?? id, [panels]);
  const known = allPanels(layout);

  const say = useCallback((msg: string) => {
    setLive((p) => (p === msg ? `${msg}​` : msg));
  }, []);

  const focusTabAfter = useCallback((panel: PanelId) => {
    pendingTabFocus.current = panel;
    setTimeout(() => {
      if (pendingTabFocus.current === panel) pendingTabFocus.current = null;
    }, 0);
  }, []);

  const act = useCallback(
    (a: DockAction, message?: string) => {
      fixup.current = focusedPanel.current;
      dispatch(a);
      if (message) say(message);
    },
    [dispatch, say],
  );

  /* ---- focus bookkeeping ---- */
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const active = document.activeElement as HTMLElement | null;
    if (pendingTabFocus.current) {
      const t = document.getElementById(`nq-tab-${pendingTabFocus.current}`);
      pendingTabFocus.current = null;
      t?.focus();
    } else if (fixup.current && (!active || active === document.body)) {
      // The focused panel went inert (hidden or behind another tab): keep focus in the dock.
      const st = leaves(layout.root).find((s) => s.panels.includes(fixup.current as string));
      const target = st
        ? document.getElementById(`nq-tab-${st.active}`)
        : el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      target?.focus();
    }
    fixup.current = null;
  }, [layout]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onIn = (e: FocusEvent) => {
      const p = (e.target as HTMLElement).closest?.("[data-dock-panel]");
      focusedPanel.current = p ? p.getAttribute("data-dock-panel") : null;
    };
    el.addEventListener("focusin", onIn);
    return () => el.removeEventListener("focusin", onIn);
  }, []);

  /* keep the active tab in view */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]').forEach((t) => {
      t.scrollIntoView?.({ inline: "nearest", block: "nearest" });
    });
  }, [layout]);

  useEffect(() => () => cleanup.current?.(), []);

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
    if (ghostRef.current) {
      ghostRef.current.style.transform = `translate3d(${x + 12}px, ${y + 14}px, 0)`;
    }
    const docked = panelsOf(layout.root).length;
    const hit = hitTest(g, x, y, d.panel, docked > 1);
    const index = hit?.onTabBar && hit.stackId ? insertionIndex(hit.stackId, e.clientX, d.panel) : undefined;
    if (!sameHit(hit, d.hit) || index !== d.index) {
      if (!sameHit(hit, d.hit)) {
        say(
          hit
            ? describeDock(layout, { type: "dock", panel: d.panel, target: hit.target, zone: hit.zone }, title)
            : "No drop target",
        );
      }
      d.hit = hit;
      d.index = index;
      showPreview(hit, hit?.onTabBar ? tabInsertionPosition(hit.stackId!, e.clientX) : undefined);
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
      if (ghostRef.current) {
        ghostRef.current.textContent = title(d.panel);
        ghostRef.current.style.display = "block";
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
      act(a, describeDock(layout, a, title));
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
    if (layout.locked) {
      say("Layout is locked. Unlock it from the Layout menu to move panels.");
      return;
    }
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

  /* ---- move menu ---- */
  const menuItems = (panel: PanelId): DockMenuItem[] => {
    const opts = moveOptions(layout, panel, title);
    const items: DockMenuItem[] = opts.map((o, i) => ({
      id: o.id,
      label: o.label,
      divider: i > 0 && o.id.startsWith("edge:") && !opts[i - 1].id.startsWith("edge:"),
      onSelect: () => {
        setMenu(null);
        focusTabAfter(panel);
        act(o.action, o.action.type === "dock" ? describeDock(layout, o.action, title) : undefined);
      },
    }));
    const st = leaves(layout.root).find((s) => s.panels.includes(panel));
    if (st && layout.root !== st) {
      items.push({
        id: "collapse",
        label: "Collapse to a strip",
        divider: true,
        onSelect: () => {
          setMenu(null);
          act({ type: "collapse", stackId: st.id, collapsed: true }, `${title(panel)} collapsed`);
        },
      });
    }
    if (panels[panel]?.canHide !== false) {
      items.push({
        id: "hide",
        label: `Hide ${title(panel)}`,
        divider: !(st && layout.root !== st),
        onSelect: () => {
          setMenu(null);
          act({ type: "hide", panel }, `${title(panel)} hidden`);
        },
      });
    }
    return items;
  };

  /* ---- render ---- */
  const hiddenOrInactive = (p: PanelId) => {
    const v = geo.panels[p];
    return !v || !v.visible;
  };
  const rootStyle = {
    "--dock-reading-alpha": String(readingBackingAlpha(windowOpacity)),
  } as CSSProperties;

  const panelIds = Object.keys(panels).filter((p) => known.includes(p));

  let menuStyle: CSSProperties | undefined;
  if (menu) {
    const st = geo.stacks.find((s) => s.panels.includes(menu.panel));
    const x = st ? Math.min(Math.max(0, st.rect.x + 8), Math.max(0, geo.size.w - 200)) : 8;
    const y = st ? st.rect.y + Math.min(st.rect.h, 30) : 30;
    menuStyle = {
      position: "absolute",
      left: x,
      top: y,
      maxHeight: Math.max(120, geo.size.h - y - 8),
      zIndex: 5,
    };
  }

  return (
    <div
      ref={rootRef}
      className={`nq-dock${className ? ` ${className}` : ""}`}
      style={rootStyle}
      role="group"
      aria-label="Meeting panels"
    >
      {/* 1. surfaces */}
      <div className="nq-dock-layer" aria-hidden="true" data-dock-layer="surfaces">
        {geo.stacks.map((s) => (
          <div
            key={s.id}
            data-dock-surface={s.id}
            data-reading={!!panels[s.active]?.reading}
            className="nq-dock-surface"
            style={s.strip ? { display: "none" } : rectStyle(s.rect)}
          />
        ))}
      </div>

      {/* 2. panels: one flat layer, mounted once, only moved and resized by style */}
      <div className="nq-dock-layer" data-dock-layer="panels">
        {panelIds.map((p) => {
          const g = geo.panels[p];
          if (g) lastRects.current[p] = g.rect;
          const rect = g?.rect ?? lastRects.current[p] ?? geo.inner;
          const visible = !!g && g.visible;
          return (
            <div
              key={p}
              id={`nq-panel-${p}`}
              role="tabpanel"
              aria-labelledby={`nq-tab-${p}`}
              data-dock-panel={p}
              data-visible={visible}
              className="nq-dock-panel"
              aria-hidden={visible ? undefined : true}
              style={rectStyle(rect)}
              ref={(el) => {
                if (!el) return;
                if (hiddenOrInactive(p)) el.setAttribute("inert", "");
                else el.removeAttribute("inert");
              }}
            >
              {panels[p].node}
            </div>
          );
        })}
      </div>

      {/* 3. tab bars and collapsed strips */}
      <div className="nq-dock-layer" data-dock-layer="tabs">
        {geo.stacks.map((s) =>
          s.strip ? (
            <button
              key={s.id}
              type="button"
              data-dock-strip={s.id}
              data-thin={s.stripThin ?? "x"}
              className="nq-dock-strip"
              aria-label={`Expand ${s.panels.map(title).join(", ")} panel`}
              style={rectStyle(s.rect)}
              onClick={() => act({ type: "activate", panel: s.active }, `${title(s.active)} expanded`)}
            >
              <span>{s.panels.map(title).join(" / ")}</span>
            </button>
          ) : (
            <div key={s.id} data-dock-tabbar={s.id} className="nq-dock-tabbar" style={rectStyle(s.tabBar)}>
              <div
                role="tablist"
                aria-label={`${title(s.active)} panels`}
                aria-orientation="horizontal"
                className="nq-dock-tabscroll"
                onWheel={(e) => {
                  if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY;
                }}
              >
                {s.panels.map((p) => {
                  const sel = p === s.active;
                  return (
                    <button
                      key={p}
                      id={`nq-tab-${p}`}
                      type="button"
                      role="tab"
                      aria-selected={sel}
                      aria-controls={`nq-panel-${p}`}
                      tabIndex={sel ? 0 : -1}
                      className="nq-dock-tab"
                      onPointerDown={(e) => tabPointerDown(e, p, s)}
                      onPointerMove={tabPointerMove}
                      onPointerUp={(e) => tabPointerUp(e, p)}
                      onPointerCancel={tabPointerCancel}
                      onKeyDown={(e) => tabKeyDown(e, p, s)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openMenu(p);
                      }}
                      onClick={(e) => {
                        // pointer clicks activate on pointerup; this serves Enter/Space and tests
                        if (e.detail === 0) {
                          setFocusPanel(p);
                          act({ type: "activate", panel: p });
                        }
                      }}
                    >
                      {panels[p]?.icon}
                      <span className="nq-dock-tab-label" data-label={title(p)}>
                        {title(p)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {renderTabExtra && <div className="nq-dock-extra">{renderTabExtra(s.active)}</div>}
              {!s.virtual && (
                <button
                  type="button"
                  className="nq-dock-more"
                  aria-label={`Move ${title(s.active)}`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.panel === s.active}
                  onClick={() => (menu ? setMenu(null) : openMenu(s.active))}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          ),
        )}
      </div>

      {/* 4. separators */}
      <div className="nq-dock-layer" data-dock-layer="separators">
        {geo.separators.map((sep) => {
          const lo = Math.round(((sep.pos + resizeBounds(sep).min - sep.span[0]) / Math.max(1, sep.span[1] - sep.span[0])) * 100);
          const hi = Math.round(((sep.pos + resizeBounds(sep).max - sep.span[0]) / Math.max(1, sep.span[1] - sep.span[0])) * 100);
          return (
            <div
              key={sep.id}
              data-dock-sep={sep.id}
              data-axis={sep.axis}
              data-active="false"
              className="nq-dock-sep"
              role="separator"
              tabIndex={layout.locked ? -1 : 0}
              aria-orientation={sep.axis === "x" ? "vertical" : "horizontal"}
              aria-label={sepName(sep)}
              aria-valuemin={lo}
              aria-valuemax={hi}
              aria-valuenow={Math.round(sep.fraction * 100)}
              aria-disabled={layout.locked || undefined}
              style={rectStyle(sep.rect)}
              onPointerDown={(e) => sepPointerDown(e, sep)}
              onPointerMove={sepPointerMove}
              onPointerUp={sepPointerUp}
              onPointerCancel={sepPointerCancel}
              onKeyDown={(e) => sepKeyDown(e, sep)}
              onDoubleClick={() => act({ type: "equalize", splitId: sep.splitId, index: sep.index })}
            />
          );
        })}
      </div>

      {/* 5. drop indicators (ours; no HTML5 drag, no OS drag image) */}
      <div className="nq-dock-layer" aria-hidden="true" data-dock-layer="drop">
        <div ref={previewRef} className="nq-dock-drop" data-dock-drop />
        <div ref={caretRef} className="nq-dock-caret" />
        <div ref={ghostRef} className="nq-dock-ghost" />
      </div>

      {menu && (
        <DockMenu
          label={`Move ${title(menu.panel)}`}
          items={menuItems(menu.panel)}
          style={menuStyle}
          onClose={() => {
            setMenu(null);
            document.getElementById(`nq-tab-${menu.panel}`)?.focus();
          }}
        />
      )}

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {live}
      </div>
    </div>
  );
}
