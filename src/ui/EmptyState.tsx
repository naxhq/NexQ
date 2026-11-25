import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface EmptyStateProps {
  title: string;
  body?: ReactNode;
  /** The one thing to do next (a button). */
  action?: ReactNode;
  /** A mark above the title (a voiceprint), not a stock illustration. */
  mark?: ReactNode;
  className?: string;
}

/** An empty place that says what goes here and offers the first step. */
export function EmptyState({ title, body, action, mark, className }: EmptyStateProps) {
  return (
    <div className={cn("mx-auto flex max-w-[24rem] flex-col items-center px-6 py-10 text-center", className)}>
      {mark && <div className="mb-4 text-muted-foreground">{mark}</div>}
      <h3 className="ui-dialog-title">{title}</h3>
      {body && <p className="ui-body mt-1.5 text-muted-foreground">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
