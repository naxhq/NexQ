import { Lock } from "lucide-react";

/**
 * The six-dot handle at the left of a tab: two columns of three. It only says "this can be
 * dragged"; the whole tab is the drag target. Hover and focus colour it and spread the columns
 * by a pixel (colour only under reduced motion). A locked layout shows a lock instead.
 */
export function DockGrip({ locked = false }: { locked?: boolean }) {
  return (
    <span className="nq-dock-grip" data-locked={locked || undefined} aria-hidden="true">
      {locked ? (
        <Lock className="nq-dock-lock" strokeWidth={2.2} />
      ) : (
        <svg viewBox="0 0 10 14" width="10" height="14" focusable="false">
          <g className="nq-grip-l">
            <circle cx="3" cy="2.5" r="1.15" />
            <circle cx="3" cy="7" r="1.15" />
            <circle cx="3" cy="11.5" r="1.15" />
          </g>
          <g className="nq-grip-r">
            <circle cx="7" cy="2.5" r="1.15" />
            <circle cx="7" cy="7" r="1.15" />
            <circle cx="7" cy="11.5" r="1.15" />
          </g>
        </svg>
      )}
    </span>
  );
}
