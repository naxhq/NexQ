import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button, IconButton } from "../ui";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { fieldClass, hintClass } from "./styles";
import { PanelSection } from "./PanelSection";

/** Rough size the way the old custom instructions counted it: characters over four. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** The workspace's instructions: read in place, edited in place. Saved only when asked. */
export function InstructionsBlock({ workspaceId, instructions }: { workspaceId: string; instructions: string }) {
  const update = useWorkspaceStore((s) => s.update);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(instructions);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(instructions);
  }, [instructions, editing]);
  useEffect(() => setEditing(false), [workspaceId]);

  const save = async () => {
    setBusy(true);
    try {
      await update(workspaceId, { instructions: draft });
      setEditing(false);
    } catch (e) {
      showToast(`Couldn't save the instructions: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection
      id="instructions"
      title="Instructions"
      action={
        !editing && (
          <IconButton onClick={() => setEditing(true)} aria-label="Edit instructions">
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        )
      }
      bodyClassName="space-y-1.5"
    >
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            aria-label="Instructions for the AI"
            autoFocus
            className={`${fieldClass} resize-y`}
            placeholder="How the AI should work here."
          />
          <div className="flex items-center justify-between">
            <span className={hintClass}>About {estimateTokens(draft)} tokens</span>
            <span className="flex gap-1.5">
              <Button
                onClick={() => {
                  setDraft(instructions);
                  setEditing(false);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={save} disabled={busy || draft === instructions}>
                {busy ? "Saving" : "Save"}
              </Button>
            </span>
          </div>
        </div>
      ) : instructions.trim() ? (
        <p className="ui-body line-clamp-3 whitespace-pre-wrap text-muted-foreground">{instructions}</p>
      ) : (
        <p className="ui-meta text-muted-foreground">None yet. Say how the AI should work here: who the people are, what to focus on.</p>
      )}
    </PanelSection>
  );
}
