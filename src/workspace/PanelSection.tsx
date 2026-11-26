import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { InfoTip } from "../ui";

const KEY = "nexq.rightPanel.closed";

function readClosed(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeClosed(id: string, closed: boolean) {
  try {
    const rest = readClosed().filter((x) => x !== id);
    window.localStorage.setItem(KEY, JSON.stringify(closed ? [...rest, id] : rest));
  } catch {
    /* the choice just isn't remembered */
  }
}

/**
 * One block of the right panel: a quiet heading (the name, a count, a chevron that folds it), the
 * block's own action at the far end, a hairline above. The name is the fold button, so the whole
 * word is the target. Whether it is folded is remembered per block, not per workspace.
 */
export function PanelSection({
  id,
  title,
  count,
  info,
  infoLabel,
  action,
  label,
  className,
  bodyClassName,
  children,
}: {
  id: string;
  title: string;
  /** Shown beside the name when there is something to count. */
  count?: number | null;
  /** Longer help, behind an "i" next to the name. */
  info?: ReactNode;
  infoLabel?: string;
  /** The block's own button (add, edit): stays visible when it is folded. */
  action?: ReactNode;
  /** The region's accessible name when it is not the title. */
  label?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !readClosed().includes(id));
  const bodyId = useId();
  const toggle = () => {
    setOpen((o) => {
      writeClosed(id, o);
      return !o;
    });
  };
  return (
    <section aria-label={label ?? title} className={cn("border-t border-border/70 px-4 py-2.5 first:border-t-0", className)}>
      <div className="flex min-h-7 items-center gap-1">
        <h3 className="ui-section shrink-0 text-foreground">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={bodyId}
            className="ui-focus ui-r-md -ml-1 inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-accent/60"
          >
            <span>{title}</span>
            {count ? <span className="ui-meta font-normal tabular-nums text-muted-foreground">{count}</span> : null}
            <ChevronDown
              className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 [transition-timing-function:var(--ui-ease)]", !open && "-rotate-90")}
              aria-hidden="true"
            />
          </button>
        </h3>
        {info && <InfoTip label={infoLabel ?? `About ${title.toLowerCase()}`}>{info}</InfoTip>}
        <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>
      </div>
      <div id={bodyId} hidden={!open} className={cn("pt-1.5", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}
