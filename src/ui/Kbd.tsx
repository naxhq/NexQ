import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** A key cap. Same font as the text around it (no monospace labels). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "ui-kbd inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-[5px] border border-border bg-muted px-1 text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
