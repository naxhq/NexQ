import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog, Kbd } from "../ui";
import { VoiceprintMark } from "../voiceprint";
import { cn } from "../lib/utils";
import { formatShortcut } from "../lib/shortcutLabel";
import { railOrder, useWorkspaceStore } from "../stores/workspaceStore";
import { fieldClass, hintClass } from "./styles";

export const SWITCHER_SHORTCUT = "CmdOrCtrl+Shift+O";

/** Pure: the workspaces a typed filter keeps (names, then descriptions), in rail order. */
export function filterWorkspaces<T extends { name: string; description?: string }>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const byName = list.filter((w) => w.name.toLowerCase().includes(q));
  const byText = list.filter((w) => !byName.includes(w) && (w.description ?? "").toLowerCase().includes(q));
  return [...byName, ...byText];
}

/**
 * Switch workspace (Ctrl+Shift+O, or the name in the breadcrumb): type to
 * filter, arrows to move, Enter to open. A dialog, so it is reachable and
 * readable the same way as everything else.
 */
export function WorkspaceSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const openId = useWorkspaceStore((s) => s.openId);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const shown = useMemo(() => filterWorkspaces(railOrder(workspaces, false), query), [workspaces, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(Math.max(0, railOrder(workspaces, false).findIndex((w) => w.id === openId)));
    }
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => setActive((a) => Math.min(a, Math.max(shown.length - 1, 0))), [shown.length]);

  const choose = (id: string) => {
    openWorkspace(id);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(shown.length - 1);
    } else if (e.key === "Enter" && shown[active]) {
      e.preventDefault();
      choose(shown[active].id);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Switch workspace" size="sm" initialFocusRef={input}>
      <input
        ref={input}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[active] ? `${listId}-${shown[active].id}` : undefined}
        aria-label="Find a workspace"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        placeholder="Type to find a workspace"
        className={fieldClass}
      />
      <ul id={listId} role="listbox" aria-label="Workspaces" className="mt-2 max-h-72 overflow-y-auto">
        {shown.map((w, i) => (
          <li
            key={w.id}
            id={`${listId}-${w.id}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(w.id)}
            className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2", i === active && "bg-accent")}
          >
            <VoiceprintMark id={w.id} hue={w.color} size={18} />
            <span className="min-w-0 flex-1">
              <span className="ui-body block truncate font-medium text-foreground">{w.name}</span>
              {w.description && <span className={`${hintClass} block truncate`}>{w.description}</span>}
            </span>
            {w.id === openId && <span className={hintClass}>Open</span>}
          </li>
        ))}
        {shown.length === 0 && <li className="ui-body px-2.5 py-3 text-muted-foreground">No workspace matches that.</li>}
      </ul>
      <p className={`${hintClass} mt-2`}>
        <Kbd>{formatShortcut(SWITCHER_SHORTCUT)}</Kbd> opens this from anywhere in the launcher.
      </p>
    </Dialog>
  );
}
