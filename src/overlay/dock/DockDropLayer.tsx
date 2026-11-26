import type { RefObject } from "react";
import type { Geometry } from "./layoutGeometry";
import { rectStyle } from "./dockShared";

export interface DropRefs {
  preview: RefObject<HTMLDivElement>;
  caret: RefObject<HTMLDivElement>;
  ghost: RefObject<HTMLDivElement>;
  ghostIcon: RefObject<HTMLSpanElement>;
  ghostName: RefObject<HTMLSpanElement>;
  ghostDo: RefObject<HTMLDivElement>;
}

/**
 * Everything drawn while a panel is dragged (ours; no HTML5 drag, no OS drag image):
 * dashed hints of the areas it can land on, the highlight box, the caret, the chip that
 * follows the pointer (name, and what dropping here does) and the one-line note. All of it is positioned
 * and worded imperatively, only when the target changes.
 */
export function DockDropLayer({ refs, geo }: { refs: DropRefs; geo: Geometry }) {
  return (
    <div className="nq-dock-layer" aria-hidden="true" data-dock-layer="drop">
      {geo.stacks
        .filter((s) => !s.strip && !s.virtual)
        .map((s) => (
          <div key={s.id} className="nq-dock-hint" style={rectStyle(s.rect)} />
        ))}
      <div ref={refs.preview} className="nq-dock-drop" data-dock-drop />
      <div ref={refs.caret} className="nq-dock-caret" />
      <div ref={refs.ghost} className="nq-dock-ghost">
        <div className="nq-dock-ghost-head">
          <svg viewBox="0 0 10 14" width="8" height="12" className="nq-dock-ghost-grip" focusable="false">
            <circle cx="3" cy="2.5" r="1.15" />
            <circle cx="3" cy="7" r="1.15" />
            <circle cx="3" cy="11.5" r="1.15" />
            <circle cx="7" cy="2.5" r="1.15" />
            <circle cx="7" cy="7" r="1.15" />
            <circle cx="7" cy="11.5" r="1.15" />
          </svg>
          <span ref={refs.ghostIcon} className="nq-dock-ghost-icon" />
          <span ref={refs.ghostName} dir="auto" className="nq-dock-ghost-name" />
        </div>
        <div ref={refs.ghostDo} dir="auto" className="nq-dock-ghost-do" />
      </div>
      <div className="nq-dock-note">
        <span>Drop on a highlighted area to rearrange.</span>
        <kbd>Esc</kbd>
        <span>cancels.</span>
      </div>
    </div>
  );
}
