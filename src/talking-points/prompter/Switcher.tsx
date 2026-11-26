import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "../../lib/utils";

export interface SwitcherNote {
  id: string;
  title: string;
  /** Searched as well as the title. */
  text: string;
  /** Where it comes from when not the meeting's own workspace. */
  from?: string;
  sort: number;
}

/** Recent first (most recent at the top), then the rest in their own order. Filtering keeps title matches ahead of text matches. */
export function rankNotes(notes: readonly SwitcherNote[], recent: readonly string[], query: string): SwitcherNote[] {
  const q = query.trim().toLowerCase();
  const rIndex = new Map(recent.map((id, i) => [id, i]));
  const order = (a: SwitcherNote, b: SwitcherNote) => {
    const ra = rIndex.get(a.id) ?? Infinity;
    const rb = rIndex.get(b.id) ?? Infinity;
    return ra !== rb ? ra - rb : a.sort - b.sort;
  };
  if (!q) return [...notes].sort(order);
  const title: SwitcherNote[] = [];
  const body: SwitcherNote[] = [];
  for (const n of notes) {
    if (n.title.toLowerCase().includes(q)) title.push(n);
    else if (n.text.toLowerCase().includes(q)) body.push(n);
  }
  return [...title.sort(order), ...body.sort(order)];
}

interface Props {
  notes: readonly SwitcherNote[];
  recent: readonly string[];
  currentId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Type to filter, arrows to move, Enter to open, Escape to close. A combobox over a listbox. */
export function Switcher({ notes, recent, currentId, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const ranked = useMemo(() => rankNotes(notes, recent, query), [notes, recent, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setActive(0);
  }, [query]);

  const optionId = (i: number) => `${listId}-o${i}`;
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(ranked.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, ranked.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const n = ranked[active];
      if (n) onPick(n.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    if (e.key !== "Escape") e.stopPropagation();
  };

  return (
    <div className="w-[min(22rem,90vw)] overflow-hidden" onKeyDown={onKey}>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={ranked.length ? optionId(active) : undefined}
          aria-label="Find a note"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a note"
          className="ui-body h-9 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div id={listId} role="listbox" aria-label="Notes" className="max-h-56 overflow-y-auto p-1">
        {ranked.length === 0 && <p className="ui-body px-3 py-3 text-muted-foreground">No note matches that.</p>}
        {ranked.map((n, i) => (
          <div
            key={n.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(n.id)}
            className={cn(
              "ui-body flex cursor-default items-baseline justify-between gap-3 rounded-lg px-3 py-1.5",
              i === active && "bg-accent",
            )}
          >
            <span className={cn("min-w-0 truncate", n.id === currentId && "font-semibold")}>{n.title}</span>
            {n.from && <span className="ui-meta shrink-0 text-muted-foreground">{n.from}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
