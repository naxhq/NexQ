import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ConfirmDialog, InlineEdit } from "../../ui";
import { Portal, anchorOf, placeBox, useDismiss, useMeasured, type Anchor } from "../../ui/portal";
import { formatCheckedAgo } from "../../lib/claudeModels";
import type { WorkspaceChat } from "../../lib/types";
import { useWorkspaceChatStore } from "../../stores/workspaceChatStore";
import { cn } from "../../lib/utils";
import { COLUMN } from "./column";
import { PickerCaret } from "./ModelPicker";

const iconBtn =
  "inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60";

/** Filter by title, newest first. */
export function filterChats(chats: WorkspaceChat[], query: string): WorkspaceChat[] {
  const q = query.trim().toLowerCase();
  const list = q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
  return [...list].sort((a, b) => b.updated_at - a.updated_at);
}

/**
 * The pane header: the open chat's name (click to rename), a list of the workspace's chats
 * with search, rename and delete, and New chat. Plain buttons, no tabs strip.
 */
export function ChatSwitcher({
  workspaceId,
  chats,
  chat,
  busyIds,
}: {
  workspaceId: string;
  chats: WorkspaceChat[];
  chat: WorkspaceChat | null;
  /** Chats that are writing an answer now. */
  busyIds: string[];
}) {
  const store = useWorkspaceChatStore;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [deleting, setDeleting] = useState<WorkspaceChat | null>(null);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const uid = useId();
  const shown = useMemo(() => filterChats(chats, query), [chats, query]);
  const { setEl, size } = useMeasured<HTMLDivElement>(open ? shown.length : null);

  const close = useCallback((restore: boolean) => {
    setOpen(false);
    setQuery("");
    setRenaming(null);
    if (restore) trigger.current?.focus();
  }, []);
  useDismiss(open && !deleting, [box, trigger], () => close(false));

  useEffect(() => {
    if (open) search.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => setActive(0), [query]);

  const openIt = () => {
    if (trigger.current) setAnchor(anchorOf(trigger.current));
    setOpen(true);
  };
  const pick = (c: WorkspaceChat) => {
    store.getState().selectChat(workspaceId, c.id);
    close(true);
  };
  const create = async () => {
    close(false);
    await store.getState().newChat(workspaceId);
    document.querySelector<HTMLElement>("[data-chat-composer]")?.focus();
  };
  const commitRename = (c: WorkspaceChat) => {
    void store.getState().renameChat(c.id, renameText);
    setRenaming(null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (renaming) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && e.target === search.current) {
      e.preventDefault();
      if (shown[active]) pick(shown[active]);
    }
  };

  const pos = anchor ? placeBox(anchor, size, { align: "start", gap: 6 }) : null;
  const now = Date.now();

  return (
    <header className="border-b border-border/60 px-5 py-2">
      <div className={cn(COLUMN, "flex items-center gap-1")}>
        <div className="min-w-0 flex-1">
          {chat ? (
            <InlineEdit
              value={chat.title || "New chat"}
              label="chat name"
              onCommit={(t) => void store.getState().renameChat(chat.id, t)}
              className="ui-section"
            />
          ) : (
            <span className="ui-section text-muted-foreground">New chat</span>
          )}
        </div>
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close(false) : openIt())}
          className="ui-meta inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          Chats{chats.length > 0 ? ` (${chats.length})` : ""}
          <PickerCaret />
        </button>
        <button
          type="button"
          onClick={() => void create()}
          className="ui-meta inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New chat
        </button>
      </div>
      {open && pos && (
        <Portal>
          <div
            ref={(el) => {
              box.current = el;
              setEl(el);
            }}
            role="dialog"
            aria-label="Chats"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !deleting) {
                e.stopPropagation();
                close(true);
              }
            }}
            style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, width: "min(22rem, calc(100vw - 16px))" }}
            className="ui-pop-in flex max-h-[min(26rem,70vh)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                ref={search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                aria-label="Search chats"
                aria-controls={`${uid}-list`}
                placeholder="Search chats"
                className="ui-body min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </div>
            <ul id={`${uid}-list`} aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto py-1">
              {shown.map((c, i) => (
                <li key={c.id} className={cn("group mx-1 flex items-center gap-1 rounded-md pr-1", i === active ? "bg-accent/70" : "hover:bg-accent/50")}>
                  {renaming === c.id ? (
                    <input
                      autoFocus
                      value={renameText}
                      aria-label={`Rename ${c.title}`}
                      maxLength={120}
                      onChange={(e) => setRenameText(e.target.value)}
                      onBlur={() => commitRename(c)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename(c);
                        } else if (e.key === "Escape") {
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                      className="ui-body m-1 min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => pick(c)}
                      aria-current={chat?.id === c.id ? "true" : undefined}
                      className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <span className={cn("ui-body block truncate text-foreground", chat?.id === c.id && "font-semibold")}>{c.title || "New chat"}</span>
                      <span className="ui-meta block text-muted-foreground">
                        {busyIds.includes(c.id) ? "Writing an answer" : formatCheckedAgo(c.updated_at, now)}
                      </span>
                    </button>
                  )}
                  {renaming !== c.id && (
                    <span className="flex shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        aria-label={`Rename ${c.title}`}
                        className={iconBtn}
                        onClick={() => {
                          setRenameText(c.title);
                          setRenaming(c.id);
                        }}
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                      </button>
                      <button type="button" aria-label={`Delete ${c.title}`} className={iconBtn} onClick={() => setDeleting(c)}>
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </span>
                  )}
                </li>
              ))}
              {shown.length === 0 && <li className="ui-meta px-3 py-2 text-muted-foreground">{query ? "No chat matches." : "No chats yet."}</li>}
            </ul>
          </div>
        </Portal>
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete this chat?"
        body={deleting ? `"${deleting.title || "New chat"}" and its answers are deleted. This can't be undone.` : undefined}
        confirmLabel="Delete chat"
        tone="danger"
        onConfirm={() => {
          if (deleting) void store.getState().deleteChat(deleting.id);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />
    </header>
  );
}
