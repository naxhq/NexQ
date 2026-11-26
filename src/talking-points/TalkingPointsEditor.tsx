/**
 * The talking points of one workspace: the list of notes on the left (search when there are many,
 * reorder, duplicate, copy, delete, import) and the writing surface on the right. Under 640 px the
 * two take turns, with a way back to the list. The heading, the close button and the save state
 * belong to the dialog around it (`TalkingPointsDialog`); reading the notes in a meeting is a
 * different surface (the Points panel).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, ArrowLeft, FileText, FileUp, Plus, Search } from "lucide-react";
import { useTalkingPointsStore, type NoteSort } from "../stores/talkingPointsStore";
import { listWorkspaces } from "../lib/ipc";
import type { WorkspaceSummary } from "../lib/types";
import { ConfirmDialog, Dialog, EmptyState, IconButton, Menu, Select, Button, Tooltip } from "../ui";
import { cn } from "../lib/utils";
import { NoteList } from "./NoteList";
import { NoteEditorPane } from "./NoteEditorPane";
import { ImportDialog } from "./ImportDialog";
import { emptyDoc } from "./doc/model";
import { SORT_OPTIONS, SORT_SHORT, sortNotes } from "./noteSort";
import "./talkingPoints.css";

/** With this many notes the list gets a search field. */
const SEARCH_FROM = 6;

export interface TalkingPointsEditorProps {
  workspaceId: string;
  /** Open on this note instead of the first. */
  initialId?: string | null;
  /** Told which note is open (null: none), so the dialog can show its save state. */
  onSelect?: (id: string | null) => void;
  className?: string;
}

export function TalkingPointsEditor({ workspaceId, className, initialId = null, onSelect }: TalkingPointsEditorProps) {
  const store = useTalkingPointsStore;
  const notes = store((s) => s.byWorkspace[workspaceId]);
  const loading = store((s) => s.loading[workspaceId]);
  const loadError = store((s) => s.loadError[workspaceId]);
  const actionError = store((s) => s.actionError);
  const sort: NoteSort = store((s) => s.noteSort[workspaceId]) ?? "manual";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Narrow windows show the list or the note, not both. */
  const [view, setView] = useState<"list" | "note">(initialId ? "note" : "list");
  const [query, setQuery] = useState("");
  /** A note made a moment ago: the caret starts in its title. */
  const [freshId, setFreshId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [copyId, setCopyId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);

  useEffect(() => {
    void store.getState().load(workspaceId);
    setSelectedId(initialId);
    return () => {
      void store.getState().flushAll();
    };
  }, [workspaceId, store]);

  const list = notes ?? [];
  useEffect(() => {
    if (selectedId && list.some((n) => n.id === selectedId)) return;
    setSelectedId(list[0]?.id ?? null);
  }, [list, selectedId]);

  const selected = list.find((n) => n.id === selectedId) ?? null;
  useEffect(() => {
    onSelect?.(selected?.id ?? null);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // the open note went away (deleted here or elsewhere): a narrow window goes back to the list
  const hadSelected = useRef(false);
  useEffect(() => {
    if (hadSelected.current && !selected) setView("list");
    hadSelected.current = !!selected;
  }, [selected]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const found = q ? list.filter((n) => `${n.title} ${n.plain_text}`.toLowerCase().includes(q)) : list;
    return sortNotes(found, sort);
  }, [list, q, sort]);

  const open = (id: string) => {
    setSelectedId(id);
    setView("note");
  };

  const create = async (init?: Parameters<ReturnType<typeof store.getState>["create"]>[1]) => {
    const p = await store.getState().create(workspaceId, init ?? { title: "Untitled note", doc: emptyDoc() });
    if (p) {
      setQuery("");
      setFreshId(init ? null : p.id);
      open(p.id);
    }
  };

  const openCopy = (id: string) => {
    setCopyId(id);
    setTarget(null);
    listWorkspaces()
      .then((all) => setWorkspaces(all.filter((w) => !w.archived && w.id !== workspaceId)))
      .catch(() => setWorkspaces([]));
  };

  const copyNote = list.find((n) => n.id === copyId);
  const delNote = list.find((n) => n.id === deleteId);

  const doCopy = async () => {
    if (!copyId || !target) return;
    setCopyBusy(true);
    const copy = await store.getState().copyTo(copyId, target);
    setCopyBusy(false);
    if (copy) setCopyId(null);
  };

  const options = useMemo(() => workspaces.map((w) => ({ value: w.id, label: w.name })), [workspaces]);

  if (!notes && loading) {
    return (
      <div className="ui-body p-6 text-muted-foreground" role="status">
        Loading talking points
      </div>
    );
  }
  if (!notes && loadError) {
    return (
      <EmptyState
        title="Talking points did not load"
        body={loadError}
        action={
          <Button variant="primary" onClick={() => void store.getState().load(workspaceId)}>
            Try again
          </Button>
        }
      />
    );
  }

  const importButton = (
    <Tooltip content="Import Markdown">
      <IconButton variant="quiet" size="md" aria-label="Import Markdown" onClick={() => setImportOpen(true)}>
        <FileUp className="h-4 w-4" aria-hidden />
      </IconButton>
    </Tooltip>
  );

  return (
    <div className={cn("flex min-h-0 flex-1 gap-4", className)}>
      {list.length > 0 && (
        <aside aria-label="All notes" className={cn("min-h-0 w-full shrink-0 flex-col gap-2 sm:flex sm:w-64", view === "list" ? "flex" : "hidden")}>
          <div className="flex items-center gap-1.5">
            <Button variant="primary" className="flex-1 gap-1" onClick={() => void create()}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New note
            </Button>
            {importButton}
          </div>
          {list.length >= SEARCH_FROM && (
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search notes"
                placeholder="Search notes"
                className="ui-body ui-r-lg ui-focus h-8 w-full rounded-lg border bg-background pl-8 pr-2 outline-none placeholder:text-muted-foreground"
              />
            </label>
          )}
          {list.length > 1 && (
            <Menu
              label="Sort notes"
              align="start"
              items={SORT_OPTIONS.map((o) => ({
                id: o.id,
                label: o.label,
                checked: sort === o.id,
                onSelect: () => store.getState().setNoteSort(workspaceId, o.id),
              }))}
              renderTrigger={(props) => (
                <button
                  {...props}
                  type="button"
                  aria-label={`Sort notes: ${SORT_SHORT[sort]}`}
                  className="ui-meta ui-focus ui-r-md -mt-0.5 inline-flex h-7 w-fit items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
                  {SORT_SHORT[sort]}
                </button>
              )}
            />
          )}
          {actionError && (
            <p role="alert" className="ui-meta px-1 text-destructive">
              {actionError}
            </p>
          )}
          <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
            {shown.length > 0 ? (
              <NoteList
                notes={shown}
                selectedId={selectedId}
                reorderable={!q && sort === "manual"}
                onSelect={open}
                onReorder={(ids) => void store.getState().reorder(workspaceId, ids)}
                onDuplicate={(id) =>
                  void store
                    .getState()
                    .duplicate(id)
                    .then((c) => c && open(c.id))
                }
                onCopy={openCopy}
                onDelete={setDeleteId}
              />
            ) : (
              <p className="ui-body px-2 py-3 text-muted-foreground" role="status">
                No note matches "{query.trim()}".
              </p>
            )}
          </div>
        </aside>
      )}

      <div className={cn("min-h-0 min-w-0 flex-1 flex-col sm:flex", list.length === 0 || view === "note" ? "flex" : "hidden")}>
        {selected ? (
          <>
            <button
              type="button"
              onClick={() => setView("list")}
              className="ui-body ui-focus ui-r-md mb-2 inline-flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground sm:hidden"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              All notes
            </button>
            <NoteEditorPane key={selected.id} note={selected} autoFocusTitle={freshId === selected.id} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              mark={<FileText className="h-6 w-6" aria-hidden />}
              title="Write your first talking points"
              body="What you want to say, in front of you during a call."
              action={
                <span className="flex items-center gap-2">
                  <Button variant="primary" onClick={() => void create()}>
                    Write a note
                  </Button>
                  <Button variant="ghost" onClick={() => setImportOpen(true)}>
                    Import Markdown
                  </Button>
                </span>
              }
            />
          </div>
        )}
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={async ({ title, doc }) => {
          await create({ title, doc });
        }}
      />

      <ConfirmDialog
        open={!!delNote}
        title={delNote ? `Delete "${delNote.title}"?` : "Delete note"}
        body="This removes the note from the workspace. Meetings that used it keep what they saved."
        confirmLabel="Delete note"
        tone="danger"
        onCancel={() => setDeleteId(null)}
        onConfirm={() => {
          const id = deleteId;
          setDeleteId(null);
          if (id) void store.getState().remove(id);
        }}
      />

      <Dialog
        open={!!copyNote}
        onClose={() => setCopyId(null)}
        title="Copy to another workspace"
        description={copyNote ? `A copy of "${copyNote.title}" is added to the workspace you choose. The original stays here.` : undefined}
        dismissible={!copyBusy}
        footer={
          <>
            <Button onClick={() => setCopyId(null)} disabled={copyBusy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void doCopy()} disabled={!target || copyBusy}>
              Copy note
            </Button>
          </>
        }
      >
        {options.length === 0 ? (
          <p className="ui-body text-muted-foreground">There is no other workspace yet.</p>
        ) : (
          <Select label="Workspace" value={target} onChange={setTarget} options={options} placeholder="Choose a workspace" />
        )}
      </Dialog>
    </div>
  );
}
