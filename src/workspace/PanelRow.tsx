import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Dialog, IconButton, Menu, type MenuItemSpec } from "../ui";
import { cn } from "../lib/utils";
import { LIBRARY_LIST_MAX_REM, SHOW_ALL_FROM } from "./layout";
import { useRovingRows } from "./roving";
import { fieldClass } from "./styles";
import type { KindLook } from "./libraryKinds";

/** The small tile with a kind's icon in its colour. Never the only cue: the kind's word sits in the row's meta line. */
export function KindTile({ look }: { look: KindLook }) {
  const Icon = look.Icon;
  return (
    <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", look.tile, look.text)} aria-hidden="true">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

/** An empty list in the panel: one short muted line. Longer help lives in the section's "i". */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="ui-meta py-0.5 text-muted-foreground">{children}</p>;
}

/**
 * One row of a panel list (Library, Memory, Talking points): a kind tile, a one-line title, one small meta line,
 * and a "..." menu that appears on hover or focus and holds every action (edit, pin, remove, forget).
 * With `onOpen` the title and meta are one button that opens the row's details. Rows are tab stops of their
 * list through `useRovingRows` (Up and Down between rows, Right into the menu).
 */
export function PanelRow({
  look,
  title,
  meta,
  wrapMeta = false,
  onOpen,
  openLabel,
  menuLabel,
  menuItems,
  trailing,
  highlighted,
  children,
}: {
  look: KindLook;
  /** The name (cut at the edge). Pass an `InlineEdit` where the name can be changed in place. */
  title: ReactNode;
  /** The small line under it, as spans: the kind's word, then the state or a one-line summary. */
  meta: ReactNode;
  /** A state that needs reading (missing, off) may wrap; the rest is cut at the edge. */
  wrapMeta?: boolean;
  onOpen?: () => void;
  /** The open button's name; defaults to its text. */
  openLabel?: string;
  menuLabel: string;
  menuItems: MenuItemSpec[];
  /** Quiet marks before the menu, such as a pin. */
  trailing?: ReactNode;
  /** Asked for from elsewhere (a cited file): scrolled into view and marked for a moment. */
  highlighted?: boolean;
  /** Below the line, inside the row (a folder's switch). */
  children?: ReactNode;
}) {
  const li = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (highlighted) li.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);

  const metaLine = cn("ui-meta flex min-w-0 items-baseline gap-x-2 px-1 leading-4 text-muted-foreground", wrapMeta ? "flex-wrap" : "flex-nowrap");
  return (
    <li
      ref={li}
      data-rove-row
      data-highlighted={highlighted ? "true" : undefined}
      className={cn(
        "group rounded-lg px-1.5 py-1 transition-colors hover:bg-accent/50 focus-within:bg-accent/50",
        highlighted && "bg-accent ring-2 ring-ring/60",
      )}
    >
      <div className="flex items-center gap-2">
        <KindTile look={look} />
        <div className="min-w-0 flex-1">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              aria-label={openLabel}
              aria-haspopup="dialog"
              className="ui-focus ui-r-md block w-full min-w-0 rounded-md text-left outline-none"
            >
              <span className="ui-body block truncate px-1 font-medium leading-5 text-foreground">{title}</span>
              <span className={metaLine}>{meta}</span>
            </button>
          ) : (
            <>
              <div className="min-w-0 truncate">{title}</div>
              <p className={metaLine}>{meta}</p>
            </>
          )}
        </div>
        {trailing}
        <Menu
          label={menuLabel}
          items={menuItems}
          align="end"
          renderTrigger={(props) => (
            <IconButton
              {...props}
              aria-label={menuLabel}
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          )}
        />
      </div>
      {children}
    </li>
  );
}

/**
 * The rows of one section: a list of at most `maxRem` that scrolls inside itself (so a long list never
 * pushes the other sections out of sight) and, from `SHOW_ALL_FROM` rows, a "Show all" that opens the whole list.
 */
export function PanelList({
  label,
  noun,
  count,
  onShowAll,
  maxRem = LIBRARY_LIST_MAX_REM,
  children,
}: {
  /** The list's accessible name. */
  label: string;
  /** What the rows are, for "Show all 15 notes". */
  noun?: string;
  count: number;
  onShowAll?: () => void;
  /** null: no cap (inside a dialog that scrolls itself). */
  maxRem?: number | null;
  children: ReactNode;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useRovingRows(el);
  return (
    <>
      <div ref={setEl} className="-mx-1.5 overflow-y-auto overscroll-contain" style={maxRem == null ? undefined : { maxHeight: `${maxRem}rem` }}>
        <ul aria-label={label} className="space-y-px">
          {children}
        </ul>
      </div>
      {onShowAll && count >= SHOW_ALL_FROM && (
        <button
          type="button"
          onClick={onShowAll}
          aria-haspopup="dialog"
          aria-label={`Show all ${count} ${noun ?? "items"}`}
          className="ui-meta mt-1 rounded-md px-1.5 py-0.5 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground ui-focus ui-focus-sm"
        >
          Show all {count}
        </button>
      )}
    </>
  );
}

/** The whole list of a section in a larger dialog, with a search for what is long. */
export function ShowAllDialog<T>({
  open,
  onClose,
  title,
  noun,
  items,
  textOf,
  keyOf,
  renderRow,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Plural, lower case: names the search ("Search notes"). */
  noun: string;
  items: T[];
  /** What the search looks in. */
  textOf: (item: T) => string;
  keyOf: (item: T) => string;
  renderRow: (item: T) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => textOf(i).toLowerCase().includes(q)) : items;
  }, [items, query, textOf]);

  return (
    <Dialog open={open} onClose={onClose} title={title} size="lg">
      <div className="sticky top-0 z-10 -mt-1 bg-popover pb-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={`Search ${noun}`}
          placeholder={`Search ${noun}`}
          className={cn(fieldClass, "h-8")}
        />
      </div>
      {shown.length === 0 ? (
        <PanelEmpty>Nothing matches that.</PanelEmpty>
      ) : (
        <PanelList label={`All ${noun}`} count={shown.length} maxRem={null}>
          {shown.map((i) => (
            <Fragment key={keyOf(i)}>{renderRow(i)}</Fragment>
          ))}
        </PanelList>
      )}
    </Dialog>
  );
}
