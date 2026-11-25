import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";
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
  const extraOf = (p: PanelId) => (renderTabExtra ? renderTabExtra(p) : null);
  return (
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
                    <Tooltip
                      key={p}
                      disabled={touch || s.virtual}
                      content={
                        locked ? (
                          <>
                            <div className="font-medium">Layout is locked</div>
                            <div className="text-muted-foreground">Click the lock to unlock</div>
                          </>
                        ) : (
                          <>
                            <div className="font-medium">Drag to move</div>
                            <div className="text-muted-foreground">Right-click or Shift+F10 for options</div>
                          </>
                        )
                      }
                    >
                    <button
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
                      {!s.virtual && (
                        <span
                          className="nq-dock-grip-slot"
                          onPointerDown={locked ? (e) => e.stopPropagation() : undefined}
                          onPointerUp={locked ? (e) => e.stopPropagation() : undefined}
                          onClick={
                            locked
                              ? (e) => {
                                  e.stopPropagation();
                                  act({ type: "lock", locked: false }, "Layout unlocked");
                                }
                              : undefined
                          }
                        >
                          <DockGrip locked={locked} />
                        </span>
                      )}
                      <span className="nq-dock-tab-icon" data-tab-icon>
                        {panels[p]?.icon}
                      </span>
                      <span className="nq-dock-tab-label" data-label={title(p)}>
                        {title(p)}
                      </span>
                    </button>
                    </Tooltip>
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
  );
}
