import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Portal, anchorOf, placeBox, useMeasured, type Anchor } from "./portal";

/**
 * The floating bubble itself, for components that keep one hover state for many
 * anchors (a wave of 300 bars). Not a `title` attribute: those are drawn by the
 * OS and can escape hide-from-screen-share.
 */
export function TooltipBubble({ anchor, id, children }: { anchor: Anchor | null; id?: string; children: ReactNode }) {
  const { setEl, size } = useMeasured<HTMLDivElement>(children);
  if (!anchor) return null;
  const pos = placeBox(anchor, size, { align: "center", gap: 8, prefer: "above" });
  return (
    <Portal>
      <div
        ref={setEl}
        id={id}
        role="tooltip"
        style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 70, pointerEvents: "none" }}
        className="ui-fade-in ui-meta max-w-[18rem] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-[0_8px_24px_-10px_rgba(0,0,0,0.5)]"
      >
        {children}
      </div>
    </Portal>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** The one element it describes; it keeps its own handlers. */
  children: ReactElement<Record<string, unknown>>;
  /** Wait before showing on hover (focus shows at once). */
  delay?: number;
}

/** Hover and keyboard-focus tooltip. Escape hides it. */
export function Tooltip({ content, children, delay = 350 }: TooltipProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();

  const show = useCallback((el: Element, wait: number) => {
    window.clearTimeout(timer.current);
    const open = () => setAnchor(anchorOf(el));
    if (wait <= 0) open();
    else timer.current = window.setTimeout(open, wait);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anchor, hide]);

  const own = children.props as {
    onMouseEnter?: (e: MouseEvent) => void;
    onMouseLeave?: (e: MouseEvent) => void;
    onFocus?: (e: FocusEvent) => void;
    onBlur?: (e: FocusEvent) => void;
    onPointerDown?: (e: MouseEvent) => void;
  };

  return (
    <>
      {cloneElement(children, {
        "aria-describedby": anchor ? id : undefined,
        onMouseEnter: (e: MouseEvent) => {
          own.onMouseEnter?.(e);
          show(e.currentTarget, delay);
        },
        onMouseLeave: (e: MouseEvent) => {
          own.onMouseLeave?.(e);
          hide();
        },
        onFocus: (e: FocusEvent) => {
          own.onFocus?.(e);
          show(e.currentTarget, 0);
        },
        onBlur: (e: FocusEvent) => {
          own.onBlur?.(e);
          hide();
        },
        onPointerDown: (e: MouseEvent) => {
          own.onPointerDown?.(e);
          hide();
        },
      })}
      {anchor && (
        <TooltipBubble anchor={anchor} id={id}>
          {content}
        </TooltipBubble>
      )}
    </>
  );
}
