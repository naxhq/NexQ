import { useEffect, useRef, useState } from "react";
import { Dialog, Button } from "../ui";
import { addWorkspaceItem, getWorkspaceNote, listLibrary } from "../lib/ipc";
import { messageOf } from "../lib/plainError";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { LibraryItem, SkippedFile, WorkspaceItem } from "../lib/types";
import { NOTE_TITLE_MAX, addPastedText, deriveNoteTitle, saveNoteEdit } from "./addMaterial";
import { readableName } from "./libraryStatus";
import { KIND_LOOK, libraryKindOf } from "./libraryKinds";
import { fieldClass, hintClass, labelClass } from "./styles";

/** A note being edited: the library item and the title it shows now. */
export interface NoteTarget {
  item: Pick<WorkspaceItem, "kind" | "ref_id" | "label">;
  title: string;
}

/**
 * Paste text and it becomes a note of this workspace; open a note and it is the same dialog to
 * change it. The title follows the first line of the text until the person writes their own.
 */
export function NoteDialog({ workspaceId, open, onClose, note }: { workspaceId: string; open: boolean; onClose: () => void; note?: NoteTarget | null }) {
  const editing = !!note;
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(note?.title ?? "");
    setTitleTouched(!!note);
    setText("");
    setBusy(false);
    setError(null);
    if (!note) return;
    let live = true;
    setLoading(true);
    getWorkspaceNote(note.item.ref_id)
      .then((n) => {
        if (!live) return;
        setTitle(n.title);
        setText(n.text);
      })
      .catch((e) => live && setError(messageOf(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, note]);

  const suggested = deriveNoteTitle(text);
  const shownTitle = titleTouched ? title : suggested;
  const canSave = !!text.trim() && !busy && !loading;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      if (note) await saveNoteEdit(workspaceId, note.item, shownTitle, text);
      else await addPastedText(workspaceId, shownTitle, text);
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={editing ? "Edit note" : "Add a note"}
      description={editing ? "Every workspace that uses this note sees the change." : "Paste notes, a brief or an email thread. It is kept as a note in this workspace."}
      initialFocusRef={editing ? bodyRef : titleRef}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!canSave}>
            {busy ? "Saving" : editing ? "Save note" : "Add note"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="note-title" className={labelClass}>
            Title
          </label>
          <input
            id="note-title"
            ref={titleRef}
            value={shownTitle}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleTouched(true);
            }}
            maxLength={NOTE_TITLE_MAX}
            placeholder="Note"
            className={fieldClass}
          />
          {!editing && !titleTouched && <p className={`${hintClass} mt-1`}>Taken from the first line. Change it if you like.</p>}
        </div>
        <div>
          <label htmlFor="note-body" className={labelClass}>
            Text
          </label>
          <textarea
            id="note-body"
            ref={bodyRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={9}
            disabled={loading}
            placeholder={loading ? "Opening the note" : undefined}
            className={`${fieldClass} resize-y`}
          />
        </div>
        {error && (
          <p role="alert" className="ui-body text-destructive">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** "Acme, Biology": the names of the workspaces that use it, never their ids. */
export function usedIn(ids: string[], workspaces: Array<{ id: string; name: string }>): string {
  const names = ids.map((id) => workspaces.find((w) => w.id === id)?.name).filter((n): n is string => !!n);
  if (names.length === 0) return "another workspace";
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** "Add from library": things already in the library that this workspace doesn't use yet. */
export function FromLibraryDialog({ workspaceId, open, onClose }: { workspaceId: string; open: boolean; onClose: () => void }) {
  const refresh = useWorkspaceStore((s) => s.refresh);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = (i: Pick<LibraryItem, "kind" | "ref_id">) => `${i.kind}:${i.ref_id}`;

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setPicked(new Set());
    setError(null);
    setBusy(false);
    let live = true;
    listLibrary()
      .then((all) => live && setItems(all.filter((i) => !i.workspace_ids.includes(workspaceId))))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, workspaceId]);

  const add = async () => {
    if (!items || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const item of items.filter((i) => picked.has(key(i)))) {
        await addWorkspaceItem(workspaceId, item.kind, item.ref_id);
      }
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Add from library"
      description="Files, folders and tools you already added somewhere else. Each stays in the library once."
      dismissible={!busy}
      footer={
        <>
          <Button  onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary"  onClick={add} disabled={busy || picked.size === 0}>
            {picked.size > 0 ? `Add ${picked.size}` : "Add"}
          </Button>
        </>
      }
    >
      {items === null && !error && <p className="ui-body text-muted-foreground">Looking at the library</p>}
      {items && items.length === 0 && <p className="ui-body text-muted-foreground">Everything in the library is already in this workspace.</p>}
      {items && items.length > 0 && (
        <ul className="max-h-72 space-y-0.5 overflow-y-auto" aria-label="Library items">
          {items.map((i) => {
            const k = key(i);
            const on = picked.has(k);
            return (
              <li key={k}>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setPicked((cur) => {
                        const next = new Set(cur);
                        if (on) next.delete(k);
                        else next.add(k);
                        return next;
                      })
                    }
                    className="mt-1 h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  />
                  <span className="min-w-0">
                    <span className="ui-body block truncate font-medium text-foreground">{readableName(i.kind, i.ref_id, i.name)}</span>
                    <span className={`${hintClass} block`}>
                      {KIND_LOOK[libraryKindOf(i)].word}
                      {i.unfiled ? ", not in any workspace" : `, used in ${usedIn(i.workspace_ids, workspaces)}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="ui-body mt-2 text-destructive">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** The files the index left out of a folder, each with its reason (too large, a secret-looking name, hidden, over the limit). */
export function SkippedFilesDialog({ folder, files, onClose }: { folder: string; files: SkippedFile[]; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Skipped in ${folder}`}
      description="These files are not searched. Nothing was changed or removed."
      footer={
        <Button onClick={onClose}>Close</Button>
      }
    >
      <ul aria-label="Skipped files" className="max-h-72 divide-y divide-border overflow-y-auto">
        {files.map((f) => (
          <li key={f.path} className="py-2">
            <p className="ui-body break-all text-foreground">{f.path}</p>
            <p className={hintClass}>{f.reason}</p>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
