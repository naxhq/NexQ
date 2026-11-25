import type { Geometry, Rect } from "./layoutGeometry";
import type { PanelId } from "./layoutModel";
import type { DockPanelDef } from "./Dock";
import { rectStyle } from "./dockShared";

interface Props {
  geo: Geometry;
  panels: Record<PanelId, DockPanelDef>;
  panelIds: PanelId[];
  /** Last rect of each panel, so a hidden one keeps its place. Written here. */
  lastRects: Record<PanelId, Rect>;
  hiddenOrInactive: (p: PanelId) => boolean;
}

/** Surfaces and panels: one flat layer, each panel mounted once, only moved and resized by style. */
export function DockLayer({ geo, panels, panelIds, lastRects, hiddenOrInactive }: Props) {
  return (
    <>
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
          if (g) lastRects[p] = g.rect;
          const rect = g?.rect ?? lastRects[p] ?? geo.inner;
          const visible = !!g && g.visible;
          return (
            <div
              key={p}
              id={`nq-panel-${p}`}
              role="tabpanel"
              // A hidden panel has no tab to name it: it carries its own name instead.
              {...(visible ? { "aria-labelledby": `nq-tab-${p}` } : { "aria-label": panels[p].title })}
              data-dock-panel={p}
              data-visible={visible}
              className="nq-dock-panel"
              aria-hidden={visible ? undefined : true}
              style={rectStyle(rect)}
              ref={(el) => {
                if (!el) return;
                // Only touch the DOM when it changes (a no-op write still queues a mutation and style work).
                const off = hiddenOrInactive(p);
                if (off !== el.hasAttribute("inert")) {
                  if (off) el.setAttribute("inert", "");
                  else el.removeAttribute("inert");
                }
              }}
            >
              {panels[p].node}
            </div>
          );
        })}
      </div>
    </>
  );
}
