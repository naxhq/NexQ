import { useEffect, useRef, useState } from "react";
import { Dialog, Button } from "../ui";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { WorkspaceDetail, WorkspaceSummary } from "../lib/types";
import { fieldClass, hintClass, labelClass } from "./styles";

/** Copies name, look, instructions, library and talking points; not meetings, chats, memory or secrets. */
export function CloneDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceSummary | null;
  onClose: (created?: WorkspaceDetail) => void;
}) {
  const clone = useWorkspaceStore((s) => s.clone);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (workspace) {
      setName(`${workspace.name} copy`);
      setBusy(false);
      setError(null);
    }
  }, [workspace]);

  if (!workspace) return null;
  const trimmed = name.trim();
  const clash = workspaces.some((w) => w.name.trim().toLowerCase() === trimmed.toLowerCase());
  const invalid = !trimmed || clash;

  const run = async () => {
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      onClose(await clone(workspace.id, trimmed));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={`Clone ${workspace.name}`}
      description="The copy starts as a twin of the setup, not of the history."
      size="sm"
      dismissible={!busy}
      initialFocusRef={input}
      footer={
        <>
          <Button  onClick={() => onClose()} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary"  onClick={run} disabled={invalid || busy}>
            {busy ? "Cloning" : "Clone workspace"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="mb-4 space-y-3">
          <section aria-label="What is copied">
            <h3 className="ui-section text-foreground">Copied</h3>
            <p className="ui-body text-muted-foreground">
              Colour, description and instructions. Also use General, Keep separate and Starts as. The files, folders and tools you added, with your names and pins. Talking points.
            </p>
          </section>
          <section aria-label="What is not copied">
            <h3 className="ui-section text-foreground">Not copied</h3>
            <p className="ui-body text-muted-foreground">
              Meetings, chats and memory. Permission to search a folder's text: allow it again in the copy. It doesn't become the default.
            </p>
          </section>
        </div>
        <label htmlFor="ws-clone-name" className={labelClass}>
          Name of the copy
        </label>
        <input id="ws-clone-name" ref={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={fieldClass} />
        {clash && trimmed && <p className={`${hintClass} mt-1 text-destructive`}>Another workspace already has this name.</p>}
        {error && (
          <p role="alert" className="ui-body mt-2 text-destructive">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
