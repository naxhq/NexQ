import type { CSSProperties } from "react";
import { useConfigStore } from "../stores/configStore";
import { isMacPlatform } from "../lib/shortcutLabel";
import { useWindowResizeDrag } from "../hooks/useWindowResizeDrag";
import type { ResizeEdge, Size } from "../lib/resizeRect";

/** The overlay's minimum size, as set in src-tauri/tauri.conf.json. */
const OVERLAY_MIN: Size = { width: 400, height: 480 };
const EDGE = 6;
const CORNER = 12;

const HANDLES: Array<{ edge: ResizeEdge; style: CSSProperties }> = [
  { edge: "n", style: { top: 0, left: CORNER, right: CORNER, height: EDGE } },
  { edge: "s", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE } },
  { edge: "e", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { edge: "w", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { edge: "nw", style: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { edge: "ne", style: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { edge: "sw", style: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
  { edge: "se", style: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
];

/**
 * macOS, stealth on: invisible handles along the overlay's edges that resize
 * it with the plain arrow cursor. Native resizing is off then, because macOS
 * draws its own resize cursors at a resizable window's edges and the page
 * can't change them (`sync_macos` in stealth_commands.rs). Windows keeps
 * native resizing and swaps the cursor in its window subclass instead.
 */
export function OverlayResizeHandles() {
  const stealthMode = useConfigStore((s) => s.stealthMode);
  if (!stealthMode || !isMacPlatform()) return null;
  return (
    <>
      {HANDLES.map((h) => (
        <ResizeHandle key={h.edge} edge={h.edge} style={h.style} />
      ))}
    </>
  );
}

function ResizeHandle({ edge, style }: { edge: ResizeEdge; style: CSSProperties }) {
  const handlers = useWindowResizeDrag(edge, OVERLAY_MIN);
  return (
    <div
      aria-hidden="true"
      data-resize-edge={edge}
      className="fixed z-[9998]"
      style={{ ...style, touchAction: "none" }}
      {...handlers}
    />
  );
}
