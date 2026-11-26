import { useEffect, useState } from "react";
import { Dialog, Button } from "../ui";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { listMemory } from "../lib/ipc";
import type { WorkspaceSummary } from "../lib/types";
import { hintClass } from "./styles";

type Choice = "move" | "archive" | "delete";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What deleting a workspace would touch, in words ("12 meetings and 2 chats"). */
export function describeContents(w: Pick<WorkspaceSummary, "meeting_count" | "chat_count">): string {
  return `${plural(w.meeting_count, "meeting")} and ${plural(w.chat_count, "chat")}`;
}

/** What the memory of a deleted workspace does: it is deleted with it, and the number is said. */
export function memoryDeleted(count: number | null): string {
  if (count === null) return "Its saved memory is deleted with it.";
  if (count === 0) return "It has no saved memory.";
  return `Its memory, ${count} ${count === 1 ? "item" : "items"}, is deleted with it.`;
}

/**
 * Deleting a workspace asks what happens to its meetings and chats: move them
 * to General (the default), archive the workspace instead, or delete them.
 * Files in the library are never deleted from here.
 */
export function DeleteWorkspaceDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceSummary | null;
  onClose: (done: boolean) => void;
}) {
  const remove = useWorkspaceStore((s) => s.remove);
  const archive = useWorkspaceStore((s) => s.archive);
  const [choice, setChoice] = useState<Choice>("move");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saved memory goes with the workspace in every choice but Archive: say how much.
  const [memory, setMemory] = useState<number | null>(null);

  useEffect(() => {
    if (workspace) {
      setChoice("move");
      setBusy(false);
      setError(null);
    }
  }, [workspace]);
  const workspaceId = workspace?.id;
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    setMemory(null);
    listMemory(workspaceId)
      .then((items) => live && setMemory(Array.isArray(items) ? items.filter((m) => m.status === "saved").length : 0))
      .catch(() => live && setMemory(null));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  if (!workspace) return null;
  const contents = describeContents(workspace);
  const options: Array<{ id: Choice; title: string; body: string }> = [
    {
      id: "move",
      title: "Move to General",
      body: `${contents} go to General, with its talking points. ${memoryDeleted(memory)} Files stay in your library.`,
    },
    { id: "archive", title: "Archive it instead", body: "Hides it from the list. Everything stays, memory included, and you can bring it back." },
    {
      id: "delete",
      title: "Delete everything in it",
      body: `Permanently removes ${contents}, its talking points and its memory${memory ? ` (${memory} ${memory === 1 ? "item" : "items"})` : ""}. This can't be undone.`,
    },
  ];
  const confirmLabel = choice === "move" ? "Delete workspace" : choice === "archive" ? "Archive workspace" : "Delete everything";

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (choice === "archive") await archive(workspace.id, true);
      else await remove(workspace.id, choice);
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => !busy && onClose(false)}
      title={`Delete ${workspace.name}?`}
      description="Choose what happens to what is in it."
      dismissible={!busy}
      footer={
        <>
          <Button  onClick={() => onClose(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={choice === "delete" ? "danger" : "primary"}
            
            onClick={run}
            disabled={busy}>
            {busy ? "Working" : confirmLabel}
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="What happens to what is in it" className="space-y-1">
        {options.map((o) => (
          <label
            key={o.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent ${choice === o.id ? "bg-accent" : ""}`}
          >
            <input
              type="radio"
              name="ws-delete-choice"
              checked={choice === o.id}
              onChange={() => setChoice(o.id)}
              className="mt-1 h-3.5 w-3.5 accent-[hsl(var(--primary))]"
            />
            <span className="min-w-0">
              <span className="ui-section block text-foreground">{o.title}</span>
              <span className={`${hintClass} block`}>{o.body}</span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="ui-body mt-3 text-destructive">
          {error}
        </p>
      )}
    </Dialog>
  );
}
