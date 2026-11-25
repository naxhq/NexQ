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
import { rectStyle } from "./dockShared";
import type { SepDrag, TabDrag } from "./dockShared";
import { useDockInteractions } from "./useDockInteractions";
import { DockLayer } from "./DockLayer";
import { DockTabs } from "./DockTabs";
import { DockSeparators } from "./DockSeparators";
import { DockDropLayer } from "./DockDropLayer";

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

  const {
    tabPointerDown, tabPointerMove, tabPointerUp, tabPointerCancel, tabKeyDown, openMenu,
    sepName, sepPointerDown, sepPointerMove, sepPointerUp, sepPointerCancel, sepKeyDown,
  } = useDockInteractions({
    layout, panels, dispatch, rootRef, geoRef, metas, focusPanel, setFocusPanel, menu, setMenu,
    act, say, focusTabAfter, title, dragRef, previewRef, caretRef, ghostRef, previewShown, cleanup,
  });

  /* ---- move menu ---- */
  const menuItems = (panel: PanelId): DockMenuItem[] => {
    // A locked layout says so on screen (not only to screen readers) and offers the way out.
    if (layout.locked) {
      return [
        { id: "locked", label: "Layout is locked: panels can't move", disabled: true, onSelect: () => {} },
        {
          id: "unlock",
          label: "Unlock layout",
          onSelect: () => {
            setMenu(null);
            act({ type: "lock", locked: false }, "Layout unlocked");
          },
        },
      ];
    }
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
    // Collapse and Hide come first, so they are reachable without scrolling a long list of moves.
    const head: DockMenuItem[] = [];
    const st = leaves(layout.root).find((s) => s.panels.includes(panel));
    if (st && layout.root !== st) {
      head.push({
        id: "collapse",
        label: "Collapse to a strip",
        onSelect: () => {
          setMenu(null);
          act({ type: "collapse", stackId: st.id, collapsed: true }, `${title(panel)} collapsed`);
        },
      });
    }
    if (panels[panel]?.canHide !== false) {
      head.push({
        id: "hide",
        label: `Hide ${title(panel)}`,
        onSelect: () => {
          setMenu(null);
          act({ type: "hide", panel }, `${title(panel)} hidden`);
        },
      });
    }
    if (head.length && items.length) items[0] = { ...items[0], divider: true };
    items.unshift(...head);
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
      <DockLayer
        geo={geo}
        panels={panels}
        panelIds={panelIds}
        lastRects={lastRects.current}
        hiddenOrInactive={hiddenOrInactive}
      />

      <DockTabs
        geo={geo}
        panels={panels}
        title={title}
        menuPanel={menu?.panel}
        act={act}
        setFocusPanel={setFocusPanel}
        openMenu={openMenu}
        toggleMenu={() => (menu ? setMenu(null) : undefined)}
        tabPointerDown={tabPointerDown}
        tabPointerMove={tabPointerMove}
        tabPointerUp={tabPointerUp}
        tabPointerCancel={tabPointerCancel}
        tabKeyDown={tabKeyDown}
        renderTabExtra={renderTabExtra}
      />

      <DockSeparators
        geo={geo}
        locked={layout.locked}
        sepName={sepName}
        act={act}
        sepPointerDown={sepPointerDown}
        sepPointerMove={sepPointerMove}
        sepPointerUp={sepPointerUp}
        sepPointerCancel={sepPointerCancel}
        sepKeyDown={sepKeyDown}
      />

      <DockDropLayer previewRef={previewRef} caretRef={caretRef} ghostRef={ghostRef} />

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
