import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Tooltip } from "./Tooltip";

export interface InfoTipProps {
  /** What the help says. Shown in a bubble on hover and on keyboard focus (never a `title`). */
  children: ReactNode;
  /** The button's name: what it explains ("About searching a folder's text"). */
  label: string;
  className?: string;
}

/**
 * A small "i" that holds a longer explanation, so a screen shows one line and the detail is
 * one hover or Tab away. It is a real button (reachable by keyboard, Escape closes the bubble),
 * the bubble is drawn inside the window, and the text is also the button's accessible description.
 */
export function InfoTip({ children, label, className }: InfoTipProps) {
  return (
    <Tooltip content={children} delay={150}>
      <button
        type="button"
        aria-label={label}
        className={cn(
          "ui-focus ui-r-md inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground",
          className,
        )}
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
