import { Pin } from "lucide-react";
import { InlineEdit, type MenuItemSpec } from "../ui";
import { cn } from "../lib/utils";
import type { FolderIndexInfo, WorkspaceItem } from "../lib/types";
import { itemStatus, itemTitle, type IndexProgress } from "./libraryStatus";
import { KIND_LOOK, libraryKindOf } from "./libraryKinds";
import { PanelRow } from "./PanelRow";

const TONE: Record<string, string> = {
  ok: "text-muted-foreground",
  busy: "text-muted-foreground",
  quiet: "text-muted-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

/**
 * One document, note, folder or tool in the Library, on the panel's shared row: the name the user gave
 * it, its kind and state in words, and a "..." menu (edit, pin, remove). Removing it here removes it from
 * this workspace only; the library keeps it.
 */
export function LibraryRow({
  item,
  progress,
  folder,
  menuItems,
  onRename,
  onTogglePin,
  onRemove,
  highlighted,
  skipped,
  onShowSkipped,
}: {
  item: WorkspaceItem;
  progress?: IndexProgress | null;
  /** The index's view of this folder: its files and when it was last updated. */
  folder?: FolderIndexInfo | null;
  menuItems: MenuItemSpec[];
  onRename: (label: string | null) => void;
  onTogglePin: () => void;
  /** Shown beside a missing item, so the next step is in view. */
  onRemove?: () => void;
  /** Asked for from elsewhere (a cited file): scrolled into view and marked for a moment. */
  highlighted?: boolean;
  /** Files of this folder the index left out; the count opens the list with a reason for each. */
  skipped?: number;
  onShowSkipped?: () => void;
}) {
  const status = itemStatus(item, progress, folder);
  const title = itemTitle(item);
  const kind = libraryKindOf(item);
  const look = KIND_LOOK[kind];
  const loud = status.tone === "warn" || status.tone === "error";
  const renamed = !!item.label && item.label !== item.name && kind !== "note";
  const linkClass = "shrink-0 rounded px-1 font-medium underline underline-offset-2 outline-none hover:text-foreground ui-focus ui-focus-sm";

  // The pin is the first menu item, so every action of a row is in one place.
  const menu: MenuItemSpec[] = [{ id: "pin", label: item.pinned ? "Unpin" : "Pin to the top", onSelect: onTogglePin }, ...menuItems];

  return (
    <PanelRow
      look={look}
      highlighted={highlighted}
      wrapMeta={loud}
      menuLabel={`Actions for ${title}`}
      menuItems={menu}
      title={
        <InlineEdit
          value={title}
          label={title}
          maxLength={80}
          className="ui-body block font-medium leading-5 text-foreground"
          onCommit={(v) => onRename(v === item.name ? null : v)}
        />
      }
      trailing={item.pinned ? <Pin className="h-3 w-3 shrink-0 text-muted-foreground" fill="currentColor" aria-label="Pinned" role="img" /> : null}
      meta={
        <>
          <span className={cn("shrink-0 font-medium", look.text)}>{look.word}</span>
          <span className="sr-only">. </span>
          <span className={cn("min-w-0 font-medium", TONE[status.tone], loud ? "" : "shrink-0")}>{status.text}</span>
          {renamed && <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.name}</span>}
          {!!skipped && onShowSkipped && (
            <button type="button" onClick={onShowSkipped} aria-haspopup="dialog" className={linkClass}>
              {skipped} {skipped === 1 ? "file" : "files"} skipped
            </button>
          )}
          {item.status === "missing" && onRemove && (
            <button type="button" onClick={onRemove} className={linkClass} aria-label={`Remove ${title} from this workspace`}>
              Remove
            </button>
          )}
        </>
      }
    />
  );
}
