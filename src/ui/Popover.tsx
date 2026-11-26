import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "../lib/utils";
import { Portal, anchorOf, placeBox, popOrigin, useDismiss, useMeasured } from "./portal";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The opener: the popover is placed against it and a press on it does not dismiss. */
  anchorRef: RefObject<Element | null>;
  label: string;
  align?: "start" | "end" | "center";
  prefer?: "below" | "above";
  className?: string;
  children: ReactNode;
}

/**
 * A popover that always stays inside the window: placed with `placeBox` (flip, shift,
 * max-height with scroll), rendered into the window's own root (never a new native window).
 * Escape and an outside press close it and give focus back to the opener.
 */
export function Popover({ open, onClose, anchorRef, label, align = "start", prefer = "below", className, children }: PopoverProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { setEl, size } = useMeasured<HTMLDivElement>(open);
  useDismiss(open, [boxRef, anchorRef], onClose);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      (anchorRef.current as HTMLElement | null)?.focus?.();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open, onClose, anchorRef]);
  // Placed again when the window changes size.
  const [, replace] = useState(0);
  useEffect(() => {
    if (!open) return;
    const again = () => replace((n) => n + 1);
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, [open]);
  if (!open || !anchorRef.current) return null;
  const anchorBox = anchorOf(anchorRef.current);
  const pos = placeBox(anchorBox, size, { align, prefer });
  return (
    <Portal>
      <div
        ref={(el) => {
          boxRef.current = el;
          setEl(el);
        }}
        role="dialog"
        aria-label={label}
        data-side={pos.placement === "above" ? "top" : "bottom"}
        style={{
          position: "fixed",
          left: pos.left,
          top: pos.top,
          zIndex: 60,
          maxHeight: pos.maxHeight,
          maxWidth: pos.maxWidth,
          overflowY: "auto",
          transition: "none",
          transformOrigin: popOrigin(anchorBox, pos, size.width),
        }}
        className={cn("nq-pop rounded-xl border border-border/40 bg-popover text-popover-foreground shadow-xl", className)}
      >
        {children}
      </div>
    </Portal>
  );
}

/**
 * A floating box that belongs to its parent element (the opener's wrapper) but is drawn in the
 * window's root, so no `overflow` ancestor can clip it. Placed with the shared `placeBox`
 * (above by default, flipped/shifted/capped to stay inside the window). Put it where the old
 * `absolute` box was; pass the same `id`/`role`/`data-*`.
 */
export function AnchoredBox({
  className,
  prefer = "above",
  align = "start",
  boxRef,
  children,
  ...rest
}: {
  className?: string;
  prefer?: "below" | "above";
  align?: "start" | "end" | "center";
  boxRef?: { current: HTMLDivElement | null };
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "style" | "className">) {
  const ph = useRef<HTMLSpanElement | null>(null);
  // The box is measured and watched (its content loads and changes), so the placement follows its real size.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (boxRef) boxRef.current = node;
      setEl(node);
    },
    [boxRef],
  );
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((p) => (p.width === r.width && p.height === r.height ? p : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const [, again] = useState(0);
  useLayoutEffect(() => {
    again((n) => n + 1);
    const on = () => again((n) => n + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const anchor = ph.current?.parentElement ?? null;
  const anchorBox = anchor ? anchorOf(anchor) : null;
  const pos = anchor && anchorBox ? placeBox(anchorBox, size, { prefer, align, gap: 8 }) : null;
  return (
    <>
      <span ref={ph} hidden />
      <Portal>
        <div
          {...rest}
          ref={setRef}
          data-side={pos ? (pos.placement === "above" ? "top" : "bottom") : undefined}
          style={{
            position: "fixed",
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            zIndex: 60,
            maxHeight: pos?.maxHeight,
            maxWidth: pos?.maxWidth,
            overflowY: "auto",
            visibility: pos ? "visible" : "hidden",
            // Position is never animated: a `duration-*` class on a caller used to slide the box in from (0,0).
            transition: "none",
            transformOrigin: pos && anchorBox ? popOrigin(anchorBox, pos, size.width) : undefined,
          }}
          className={cn("nq-pop", className)}
        >
          {children}
        </div>
      </Portal>
    </>
  );
}
