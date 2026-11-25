/**
 * The talking points of one workspace, for the workspace page: a list on the left
 * (reorder, duplicate, copy, delete) and the editor on the right. Reading the notes
 * in a meeting is a different surface (the Points panel).
 */
import { useEffect, useMemo, useState } from "react";
import { FileText, Plus } from "lucide-react";
import { useTalkingPointsStore } from "../stores/talkingPointsStore";
import { listWorkspaces } from "../lib/ipc";
import type { WorkspaceSummary } from "../lib/types";
import { ConfirmDialog, Dialog, EmptyState, Select, buttonClass } from "../ui";
import { cn } from "../lib/utils";
import { NoteList } from "./NoteList";
import { NoteEditorPane } from "./NoteEditorPane";
import { ImportDialog } from "./ImportDialog";
import { emptyDoc } from "./doc/model";
import "./talkingPoints.css";

export interface TalkingPointsEditorProps {
  workspaceId: string;
  /** Open on this note instead of the first. */
  initialId?: string | null;
  className?: string;
}

export function TalkingPointsEditor({ workspaceId, className, initialId = null }: TalkingPointsEditorProps) {
  const store = useTalkingPointsStore;
  const notes = store((s) => s.byWorkspace[workspaceId]);
  const loading = store((s) => s.loading[workspaceId]);
  const loadError = store((s) => s.loadError[workspaceId]);
  const actionError = store((s) => s.actionError);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const create = async (init?: Parameters<ReturnType<typeof store.getState>["create"]>[1]) => {
    const p = await store.getState().create(workspaceId, init ?? { title: "Untitled note", doc: emptyDoc() });
    if (p) setSelectedId(p.id);
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
          <button type="button" className={cn(buttonClass.base, buttonClass.primary)} onClick={() => void store.getState().load(workspaceId)}>
            Try again
          </button>
        }
      />
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-4 md:flex-row", className)}>
      <aside aria-label="Talking points" className="flex shrink-0 flex-col md:w-64">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <h2 className="ui-section">Talking points</h2>
          <span className="flex items-center gap-1">
            <button type="button" className={cn(buttonClass.base, "h-7 px-2.5 hover:bg-accent")} onClick={() => setImportOpen(true)}>
              Import
            </button>
            <button type="button" className={cn(buttonClass.base, buttonClass.primary, "h-7 gap-1 px-2.5")} onClick={() => void create()}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New note
            </button>
          </span>
        </div>
        {actionError && (
          <p role="alert" className="ui-meta mb-2 px-1 text-destructive">
            {actionError}
          </p>
        )}
        {list.length > 0 && (
          <NoteList
            notes={list}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onReorder={(ids) => void store.getState().reorder(workspaceId, ids)}
            onDuplicate={(id) => void store.getState().duplicate(id).then((c) => c && setSelectedId(c.id))}
            onCopy={openCopy}
            onDelete={setDeleteId}
          />
        )}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <NoteEditorPane key={selected.id} note={selected} />
        ) : (
          <EmptyState
            mark={<FileText className="h-6 w-6" aria-hidden />}
            title="Write your first talking points"
            body="Keep what you want to say in front of you during a call. Paste Markdown to start from something you already have."
            action={
              <span className="flex items-center gap-2">
                <button type="button" className={cn(buttonClass.base, buttonClass.primary)} onClick={() => void create()}>
                  Write a note
                </button>
                <button type="button" className={cn(buttonClass.base, "border border-border hover:bg-accent")} onClick={() => setImportOpen(true)}>
                  Import Markdown
                </button>
              </span>
            }
          />
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
            <button type="button" className={cn(buttonClass.base, buttonClass.quiet)} onClick={() => setCopyId(null)} disabled={copyBusy}>
              Cancel
            </button>
            <button type="button" className={cn(buttonClass.base, buttonClass.primary)} onClick={() => void doCopy()} disabled={!target || copyBusy}>
              Copy note
            </button>
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
