import type { ReactNode } from "react";

/**
 * Shared card of the AI provider settings. Three separate things, shown three
 * different ways so they are never mistaken for one another:
 *  - in use: the provider NexQ answers with (filled "In use" pill, primary border);
 *  - viewing: the card whose details are open (quiet outline ring only);
 *  - status: whether the provider is ready (one dot and one word).
 */

/** Color carries the state: green ok, amber needs the user, neutral absent. */
export type StatusTone = "ok" | "warn" | "neutral" | "checking";

export const STATUS_DOT_CLASS: Record<StatusTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  neutral: "bg-muted-foreground/40",
  checking: "bg-muted-foreground/40 animate-pulse",
};

interface ProviderCardProps {
  name: string;
  icon: ReactNode;
  /** Secondary text under the name (not a status). */
  detail?: string;
  /** The one status word of the card and its tone. */
  status: { label: string; tone: StatusTone };
  inUse: boolean;
  viewing: boolean;
  onClick: () => void;
  /** Accessible name; defaults to "<name>, <status>, in use | not in use". */
  ariaLabel?: string;
  dotTestId?: string;
  dotState?: string;
}

export function providerAriaLabel(name: string, status: string, inUse: boolean): string {
  return `${name}, ${status.toLowerCase()}, ${inUse ? "in use" : "not in use"}`;
}

export function InUsePill() {
  return (
    <span className="ml-auto shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-meta font-semibold text-primary-foreground">
      In use
    </span>
  );
}

export function ProviderCard({
  name,
  icon,
  detail,
  status,
  inUse,
  viewing,
  onClick,
  ariaLabel,
  dotTestId,
  dotState,
}: ProviderCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={viewing}
      aria-label={ariaLabel ?? providerAriaLabel(name, status.label, inUse)}
      className={`relative flex flex-col items-start rounded-xl border p-3 text-left transition-all duration-150 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
        inUse
          ? "border-primary bg-primary/10"
          : "border-border/50 hover:border-border hover:bg-accent/50"
      } ${viewing ? "ring-2 ring-foreground/25 ring-offset-1 ring-offset-card" : ""}`}
    >
      <div className="flex w-full items-center gap-1.5">
        {icon}
        <span className="text-xs font-medium truncate">{name}</span>
        {inUse && <InUsePill />}
      </div>
      {detail && (
        <span className="mt-0.5 text-meta text-muted-foreground line-clamp-1">{detail}</span>
      )}
      <span className="mt-1.5 flex w-full items-center gap-1.5 text-meta text-muted-foreground">
        <span
          data-testid={dotTestId}
          data-state={dotState}
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[status.tone]}`}
        />
        <span className="truncate">{status.label}</span>
      </span>
    </button>
  );
}
