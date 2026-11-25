import { useEffect, useRef, useState } from "react";
import { GripVertical, MoreHorizontal } from "lucide-react";
import type { TalkingPoint } from "../lib/types";
import { Menu, type MenuItemSpec } from "../ui";
import { cn } from "../lib/utils";
import { countWords } from "./doc/model";
import { dropIndex, moveItem } from "./reorder";

interface Props {
  notes: readonly TalkingPoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onDuplicate: (id: string) => void;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
}

interface Drag {
  id: string;
  from: number;
  target: number;
  dy: number;
  startY: number;
}

/**
 * The notes of a workspace. Drag the grip with pointer events (no HTML5 drag and
 * drop), or focus it and press Alt with an arrow key; the menu has Move up and
 * Move down too, so nothing needs a pointer.
 */
export function NoteList({ notes, selectedId, onSelect, onReorder, onDuplicate, onCopy, onDelete }: Props) {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [said, setSaid] = useState("");

  const ids = notes.map((n) => n.id);

  const move = (id: string, delta: -1 | 1) => {
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    onReorder(moveItem(ids, from, to));
    setSaid(`${notes[from].title} moved to position ${to + 1} of ${ids.length}`);
    // keep focus on the grip of the moved row once it re-rendered
    requestAnimationFrame(() => grips.current.get(id)?.focus());
  };

  const onGripKey = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(id, -1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(id, 1);
    }
  };

  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const d: Drag = { id, from: ids.indexOf(id), target: ids.indexOf(id), dy: 0, startY: e.clientY };
    dragRef.current = d;
    setDrag(d);
  };

  const onGripMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const mids = ids.map((id) => {
      const r = rows.current.get(id)?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : 0;
    });
    // the dragged row's own midpoint follows the pointer
    const target = dropIndex(mids, d.from, e.clientY);
    const next = { ...d, dy: e.clientY - d.startY, target };
    dragRef.current = next;
    setDrag(next);
  };

  const finish = (commit: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (commit && d && d.target !== d.from) {
      onReorder(moveItem(ids, d.from, d.target));
      setSaid(`${notes[d.from].title} moved to position ${d.target + 1} of ${ids.length}`);
    }
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id]);

  return (
    <>
      <ul role="list" aria-label="Notes" className="relative space-y-0.5">
        {notes.map((n, i) => {
          const selected = n.id === selectedId;
          const dragging = drag?.id === n.id;
          const words = countWords(n.plain_text);
          const items: MenuItemSpec[] = [
            { id: "dup", label: "Duplicate", onSelect: () => onDuplicate(n.id) },
            { id: "copy", label: "Copy to another workspace", onSelect: () => onCopy(n.id) },
            { id: "up", label: "Move up", disabled: i === 0, separatorBefore: true, onSelect: () => move(n.id, -1) },
            { id: "down", label: "Move down", disabled: i === notes.length - 1, onSelect: () => move(n.id, 1) },
            { id: "del", label: "Delete", danger: true, separatorBefore: true, onSelect: () => onDelete(n.id) },
          ];
          // the row the drag would drop on gets a line above or below it
          const showLine = drag && drag.target === i && drag.from !== i;
          const lineBelow = drag ? drag.target > drag.from : false;
          return (
            <li
              key={n.id}
              ref={(el) => {
                if (el) rows.current.set(n.id, el);
                else rows.current.delete(n.id);
              }}
              data-note-id={n.id}
              className={cn("group relative flex items-center rounded-lg", selected && "bg-accent/70", dragging && "z-10 opacity-80 shadow-md bg-accent")}
              style={dragging ? { transform: `translateY(${drag!.dy}px)`, transition: "none" } : undefined}
            >
              {showLine && (
                <span
                  aria-hidden
                  className={cn("pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-primary", lineBelow ? "-bottom-px" : "-top-px")}
                />
              )}
              {selected && <span aria-hidden className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-primary" />}
              <button
                ref={(el) => {
                  if (el) grips.current.set(n.id, el);
                  else grips.current.delete(n.id);
                }}
                type="button"
                aria-label={`Reorder ${n.title}. Press the up or down arrow, or drag.`}
                onPointerDown={(e) => onGripDown(e, n.id)}
                onPointerMove={onGripMove}
                onPointerUp={() => finish(true)}
                onPointerCancel={() => finish(false)}
                onKeyDown={(e) => onGripKey(e, n.id)}
                className="inline-flex h-9 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/50 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(n.id)}
                className="min-w-0 flex-1 rounded-md px-1.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className={cn("ui-body block truncate", selected && "font-semibold")}>{n.title}</span>
                <span className="ui-meta block truncate text-muted-foreground">
                  {words} {words === 1 ? "word" : "words"}
                  {n.in_context ? ", used as AI context" : ""}
                </span>
              </button>
              <Menu
                label={`Actions for ${n.title}`}
                align="end"
                items={items}
                renderTrigger={(props) => (
                  <button
                    {...props}
                    type="button"
                    aria-label={`Actions for ${n.title}`}
                    className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-60 outline-none transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </button>
                )}
              />
            </li>
          );
        })}
      </ul>
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </>
  );
}
