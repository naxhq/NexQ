import type { RefObject } from "react";

interface Props {
  previewRef: RefObject<HTMLDivElement>;
  caretRef: RefObject<HTMLDivElement>;
  ghostRef: RefObject<HTMLDivElement>;
}

/** Drop indicators (ours; no HTML5 drag, no OS drag image). Positioned imperatively while dragging. */
export function DockDropLayer({ previewRef, caretRef, ghostRef }: Props) {
  return (
    <div className="nq-dock-layer" aria-hidden="true" data-dock-layer="drop">
      <div ref={previewRef} className="nq-dock-drop" data-dock-drop />
      <div ref={caretRef} className="nq-dock-caret" />
      <div ref={ghostRef} className="nq-dock-ghost" />
    </div>
  );
}
