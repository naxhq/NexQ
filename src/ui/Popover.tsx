import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "../lib/utils";
import { Portal, anchorOf, placeBox, useDismiss, useMeasured } from "./portal";

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
  const pos = placeBox(anchorOf(anchorRef.current), size, { align, prefer });
  return (
    <Portal>
      <div
        ref={(el) => {
          boxRef.current = el;
          setEl(el);
        }}
        role="dialog"
        aria-label={label}
        style={{
          position: "fixed",
          left: pos.left,
          top: pos.top,
          zIndex: 60,
          maxHeight: pos.maxHeight,
          maxWidth: pos.maxWidth,
          overflowY: "auto",
        }}
        className={cn("rounded-xl border border-border/40 bg-popover text-popover-foreground shadow-xl", className)}
      >
        {children}
      </div>
    </Portal>
  );
}
