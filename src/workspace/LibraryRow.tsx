import { useEffect, useRef } from "react";
import { File as FileIcon, Folder, MoreHorizontal, Pin, Plug2 } from "lucide-react";
import { InlineEdit, Menu, Switch, Tooltip, type MenuItemSpec, IconButton } from "../ui";
import { cn } from "../lib/utils";
import type { WorkspaceItem } from "../lib/types";
import { FOLDER_OPT_IN_SENTENCE, itemStatus, itemTitle, type IndexProgress } from "./libraryStatus";

const KIND_WORD = { document: "Document", folder: "Folder", server: "Tool" } as const;
const TONE: Record<string, string> = {
  ok: "text-muted-foreground",
  busy: "text-muted-foreground",
  quiet: "text-muted-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

/**
 * One document, folder or tool in the Library: the name the user gave it,
 * what state it is in (in words), a pin, and a menu. Removing it here removes
 * it from this workspace only; the library keeps it.
 */
export function LibraryRow({
  item,
  progress,
  menuItems,
  onRename,
  onTogglePin,
  onOptIn,
  onRemove,
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
  const Icon = item.kind === "folder" ? Folder : item.kind === "server" ? Plug2 : FileIcon;
  const renamed = !!item.label && item.label !== item.name;

  return (
    <li ref={li} data-rove-row data-highlighted={highlighted ? "true" : undefined} className={cn("group rounded-lg px-2 py-2 transition-colors hover:bg-accent/50", highlighted && "bg-accent ring-2 ring-ring/60")}>
      <div className="flex items-start gap-2">
        <Icon className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <InlineEdit
            value={title}
            label={title}
            maxLength={80}
            className="ui-body font-medium text-foreground"
            onCommit={(v) => onRename(v === item.name ? null : v)}
          />
          <p className={cn("ui-meta mt-0.5", TONE[status.tone])}>
            <span className="text-muted-foreground">{KIND_WORD[item.kind]}</span>
            {renamed && <span className="text-muted-foreground">{`, ${item.name}`}</span>}
            <span className="sr-only">. </span>
            <span className="ml-2 font-medium">{status.text}</span>
            {!!skipped && onShowSkipped && (
              <button
                type="button"
                onClick={onShowSkipped}
                aria-haspopup="dialog"
                className="ml-2 rounded px-1 font-medium underline underline-offset-2 outline-none hover:text-foreground ui-focus ui-focus-sm"
              >
                {skipped} {skipped === 1 ? "file" : "files"} skipped
              </button>
            )}
            {item.status === "missing" && onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="ml-2 rounded px-1 font-medium underline underline-offset-2 outline-none hover:text-foreground ui-focus ui-focus-sm"
                aria-label={`Remove ${title} from this workspace`}
              >
                Remove
              </button>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton
            onClick={onTogglePin}
            aria-pressed={item.pinned}
            aria-label={item.pinned ? `Unpin ${title}` : `Pin ${title}`} className={cn(item.pinned ? "text-foreground" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100")}>
            <Pin className="h-3.5 w-3.5" fill={item.pinned ? "currentColor" : "none"} aria-hidden="true" />
          </IconButton>
          <Menu
            label={`Actions for ${title}`}
            items={menuItems}
            align="end"
            renderTrigger={(props) => (
              <IconButton {...props}  aria-label={`Actions for ${title}`}>
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              </IconButton>
            )}
          />
        </div>
      </div>
      {item.kind === "folder" && item.status !== "missing" && (
        <div className="ml-6 mt-2">
          {item.index_opt_in ? (
            // Already on: the explanation lives in the tooltip, not under every folder.
            <Tooltip content={FOLDER_OPT_IN_SENTENCE}>
              <span className="inline-flex">
                <Switch checked onChange={onOptIn} aria-label={`Search the text of ${title}`} label="Search its text" />
              </span>
            </Tooltip>
          ) : (
            <Switch checked={false} onChange={onOptIn} aria-label={`Search the text of ${title}`} label="Search its text" description={FOLDER_OPT_IN_SENTENCE} />
          )}
        </div>
      )}
    </li>
  );
}
