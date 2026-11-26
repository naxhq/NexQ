import { useEffect, useRef } from "react";
import { MoreHorizontal, Pencil, Pin } from "lucide-react";
import { InfoTip, InlineEdit, Menu, Switch, type MenuItemSpec, IconButton } from "../ui";
import { cn } from "../lib/utils";
import type { WorkspaceItem } from "../lib/types";
import { FOLDER_OPT_IN_SENTENCE, itemStatus, itemTitle, type IndexProgress } from "./libraryStatus";
import { KIND_LOOK, libraryKindOf } from "./libraryKinds";

const TONE: Record<string, string> = {
  ok: "text-muted-foreground",
  busy: "text-muted-foreground",
  quiet: "text-muted-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

/**
 * One document, note, folder or tool in the Library: two short lines (the name the user gave it;
 * its kind and state in words), a pin and a menu. Removing it here removes it from this workspace
 * only; the library keeps it.
 */
export function LibraryRow({
  item,
  progress,
  menuItems,
  onRename,
  onTogglePin,
  onOptIn,
  onRemove,
  onEditNote,
  highlighted,
  skipped,
  onShowSkipped,
}: {
  item: WorkspaceItem;
  progress?: IndexProgress | null;
  menuItems: MenuItemSpec[];
  onRename: (label: string | null) => void;
  onTogglePin: () => void;
  onOptIn: (on: boolean) => void;
  /** Shown beside a missing item, so the next step is in view. */
  onRemove?: () => void;
  /** A note opens in its edit dialog from here. */
  onEditNote?: () => void;
  /** Asked for from elsewhere (a cited file): scrolled into view and marked for a moment. */
  highlighted?: boolean;
  /** Files of this folder the index left out; the count opens the list with a reason for each. */
  skipped?: number;
  onShowSkipped?: () => void;
}) {
  const li = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (highlighted) li.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  const status = itemStatus(item, progress);
  const title = itemTitle(item);
  const kind = libraryKindOf(item);
  const look = KIND_LOOK[kind];
  const Icon = look.Icon;
  const loud = status.tone === "warn" || status.tone === "error";
  const renamed = !!item.label && item.label !== item.name && kind !== "note";

  return (
    <li ref={li} data-rove-row data-highlighted={highlighted ? "true" : undefined} className={cn("group rounded-lg px-1.5 py-1 transition-colors hover:bg-accent/50", highlighted && "bg-accent ring-2 ring-ring/60")}>
      <div className="flex items-center gap-2">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", look.tile, look.text)} aria-hidden="true">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <InlineEdit
            value={title}
            label={title}
            maxLength={80}
            className="ui-body block font-medium leading-5 text-foreground"
            onCommit={(v) => onRename(v === item.name ? null : v)}
          />
          {/* One line: the kind, the file's own name when it was renamed, the state. A state that needs reading (missing, off) may wrap; the others are cut at the edge. */}
          <p className={cn("ui-meta flex min-w-0 items-baseline gap-x-2 px-1 leading-4", loud ? "flex-wrap" : "flex-nowrap", TONE[status.tone])}>
            <span className={cn("shrink-0 font-medium", look.text)}>{look.word}</span>
            <span className="sr-only">. </span>
            <span className={cn("min-w-0 font-medium", loud ? "" : "shrink-0")}>{status.text}</span>
            {renamed && <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.name}</span>}
            {!!skipped && onShowSkipped && (
              <button
                type="button"
                onClick={onShowSkipped}
                aria-haspopup="dialog"
                className="shrink-0 rounded px-1 font-medium underline underline-offset-2 outline-none hover:text-foreground ui-focus ui-focus-sm"
              >
                {skipped} {skipped === 1 ? "file" : "files"} skipped
              </button>
            )}
            {item.status === "missing" && onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="shrink-0 rounded px-1 font-medium underline underline-offset-2 outline-none hover:text-foreground ui-focus ui-focus-sm"
                aria-label={`Remove ${title} from this workspace`}
              >
                Remove
              </button>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          {onEditNote && (
            <IconButton onClick={onEditNote} aria-label={`Edit note ${title}`} className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100">
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          )}
          <IconButton
            onClick={onTogglePin}
            aria-pressed={item.pinned}
            aria-label={item.pinned ? `Unpin ${title}` : `Pin ${title}`}
            className={cn(item.pinned ? "text-foreground" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}
          >
            <Pin className="h-3.5 w-3.5" fill={item.pinned ? "currentColor" : "none"} aria-hidden="true" />
          </IconButton>
          <Menu
            label={`Actions for ${title}`}
            items={menuItems}
            align="end"
            renderTrigger={(props) => (
              <IconButton {...props} aria-label={`Actions for ${title}`}>
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
            )}
          />
        </div>
      </div>
      {item.kind === "folder" && item.status !== "missing" && (
        <div className="ml-8 mt-0.5 flex items-center gap-1">
          <Switch checked={!!item.index_opt_in} onChange={onOptIn} aria-label={`Search the text of ${title}`} label="Search its text" />
          <InfoTip label={`About searching the text of ${title}`}>{FOLDER_OPT_IN_SENTENCE}</InfoTip>
        </div>
      )}
    </li>
  );
}
