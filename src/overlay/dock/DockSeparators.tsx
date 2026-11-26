import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { resizeBounds, type Geometry, type SepGeo } from "./layoutGeometry";
import type { DockAction } from "./layoutModel";
import { rectStyle } from "./dockShared";

interface Props {
  geo: Geometry;
  locked: boolean;
  sepName: (sep: SepGeo) => string;
  act: (a: DockAction, message?: string) => void;
  sepPointerDown: (e: ReactPointerEvent<HTMLElement>, sep: SepGeo) => void;
  sepPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  sepPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  sepPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  sepKeyDown: (e: ReactKeyboardEvent<HTMLElement>, sep: SepGeo) => void;
}

/** The separators between stacks: pointer and arrow-key resize, double-click to reset. */
export function DockSeparators({
  geo,
  locked,
  sepName,
  act,
  sepPointerDown,
  sepPointerMove,
  sepPointerUp,
  sepPointerCancel,
  sepKeyDown,
}: Props) {
  return (
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
              tabIndex={locked ? -1 : 0}
              aria-orientation={sep.axis === "x" ? "vertical" : "horizontal"}
              aria-label={sepName(sep)}
              aria-valuemin={lo}
              aria-valuemax={hi}
              aria-valuenow={Math.round(sep.fraction * 100)}
              aria-disabled={locked || undefined}
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
  );
}
