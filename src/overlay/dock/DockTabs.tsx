import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Tooltip, TooltipBubble } from "../../ui/Tooltip";
import { anchorOf } from "../../ui/portal";
import { DockGrip } from "./DockGrip";
import type { Geometry, StackGeo } from "./layoutGeometry";
import type { DockAction, PanelId } from "./layoutModel";
import type { DockPanelDef } from "./Dock";
import { rectStyle } from "./dockShared";

interface Props {
  geo: Geometry;
  panels: Record<PanelId, DockPanelDef>;
  title: (id: PanelId) => string;
  menuPanel: PanelId | undefined;
  act: (a: DockAction, message?: string) => void;
  setFocusPanel: (p: PanelId) => void;
  openMenu: (p: PanelId) => void;
  /** Closes the open move menu. */
  toggleMenu: () => void;
  tabPointerDown: (e: ReactPointerEvent<HTMLElement>, panel: PanelId, st: StackGeo) => void;
  tabPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  tabPointerUp: (e: ReactPointerEvent<HTMLElement>, panel: PanelId) => void;
  tabPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  tabKeyDown: (e: ReactKeyboardEvent<HTMLElement>, panel: PanelId, st: StackGeo) => void;
  renderTabExtra?: (panel: PanelId) => ReactNode;
  locked?: boolean;
  /** Hover tips mean nothing on touch. */
  touch?: boolean;
}

/** Tab bars and collapsed strips. */
export function DockTabs({
  geo,
  panels,
  title,
  menuPanel,
  act,
  setFocusPanel,
  openMenu,
  toggleMenu,
  tabPointerDown,
  tabPointerMove,
  tabPointerUp,
  tabPointerCancel,
  tabKeyDown,
  renderTabExtra,
  locked = false,
  touch = false,
}: Props) {
  const pointerFocus = useRef(false);
  const [kbTip, setKbTip] = useState<PanelId | null>(null);
  const tip = locked ? (
    <>
      <div className="font-medium">Layout is locked</div>
      <div className="text-muted-foreground">Click the lock for the unlock option</div>
    </>
  ) : (
    <>
      <div className="font-medium">Drag to move</div>
      <div className="text-muted-foreground">Right-click or Shift+F10 for options</div>
    </>
  );
  const kbAnchor =
    kbTip && typeof document !== "undefined"
      ? document.getElementById(`nq-tab-${kbTip}`)?.querySelector(".nq-dock-grip-slot")
      : null;
  const extraOf = (p: PanelId) => (renderTabExtra ? renderTabExtra(p) : null);
  return (
    <>
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
                      onPointerDown={(e) => {
                        pointerFocus.current = true;
                        setKbTip(null);
                        tabPointerDown(e, p, s);
                      }}
                      onFocus={() => {
                        // Keyboard focus always explains itself; focus that came from a press does not.
                        if (!pointerFocus.current && !touch && !s.virtual) setKbTip(p);
                      }}
                      onBlur={() => {
                        pointerFocus.current = false;
                        setKbTip(null);
                      }}
                      onPointerMove={tabPointerMove}
                      onPointerUp={(e) => tabPointerUp(e, p)}
                      onPointerCancel={tabPointerCancel}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setKbTip(null);
                        tabKeyDown(e, p, s);
                      }}
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
                      {!s.virtual && (
                        <Tooltip disabled={touch} content={tip} delay={350}>
                          <span
                            className="nq-dock-grip-slot"
                            onPointerDown={locked ? (e) => e.stopPropagation() : undefined}
                            onPointerUp={locked ? (e) => e.stopPropagation() : undefined}
                            onClick={
                              locked
                                ? (e) => {
                                    // The lock opens the Move menu, which says why and holds Unlock.
                                    e.stopPropagation();
                                    openMenu(p);
                                  }
                                : undefined
                            }
                          >
                            <DockGrip locked={locked} />
                          </span>
                        </Tooltip>
                      )}
                      <span className="nq-dock-tab-icon" data-tab-icon>
                        {panels[p]?.icon}
                      </span>
                      <span className="nq-dock-tab-label" data-label={title(p)}>
                        {title(p)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {extraOf(s.active) && <div className="nq-dock-extra">{extraOf(s.active)}</div>}
              {!s.virtual && (
                <button
                  type="button"
                  className="nq-dock-more"
                  aria-label={`Move ${title(s.active)}`}
                  aria-haspopup="menu"
                  aria-expanded={menuPanel === s.active}
                  onClick={() => (menuPanel ? toggleMenu() : openMenu(s.active))}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          ),
        )}
      </div>
      {kbAnchor && <TooltipBubble anchor={anchorOf(kbAnchor)}>{tip}</TooltipBubble>}
    </>
  );
}
