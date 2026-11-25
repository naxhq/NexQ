import { useEffect, useRef, useState } from "react";
import { Dialog, Button } from "../ui";
import { addWorkspaceItem, listLibrary } from "../lib/ipc";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { LibraryItem, SkippedFile } from "../lib/types";
import { addPastedText } from "./addMaterial";
import { readableName } from "./libraryStatus";
import { fieldClass, hintClass, labelClass } from "./styles";

/** Paste text: it becomes a Markdown document in this workspace. */
export function PasteTextDialog({ workspaceId, open, onClose }: { workspaceId: string; open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      setText("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addPastedText(workspaceId, title, text);
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
      title="Paste text"
      description="Notes, a brief, an email thread. It is saved as a document in this workspace."
      initialFocusRef={titleRef}
      dismissible={!busy}
      footer={
        <>
          <Button  onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary"  onClick={save} disabled={busy || !text.trim()}>
            {busy ? "Saving" : "Add to workspace"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="paste-title" className={labelClass}>
            Name
          </label>
          <input id="paste-title" ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Pasted text" className={fieldClass} />
        </div>
        <div>
          <label htmlFor="paste-body" className={labelClass}>
            Text
          </label>
          <textarea id="paste-body" value={text} onChange={(e) => setText(e.target.value)} rows={9} className={`${fieldClass} resize-y`} />
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

const KIND_WORD = { document: "Document", folder: "Folder", server: "Tool" } as const;

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
                      {KIND_WORD[i.kind]}
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
