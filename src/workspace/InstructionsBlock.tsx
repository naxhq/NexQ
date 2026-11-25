import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { buttonClass } from "../ui";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { fieldClass, hintClass, iconButtonClass } from "./styles";

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
    <section aria-label="Instructions" className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="ui-section text-foreground">Instructions</h3>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className={iconButtonClass} aria-label="Edit instructions">
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
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
              <button
                type="button"
                className={`${buttonClass.base} ${buttonClass.quiet}`}
                onClick={() => {
                  setDraft(instructions);
                  setEditing(false);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="button" className={`${buttonClass.base} ${buttonClass.primary}`} onClick={save} disabled={busy || draft === instructions}>
                {busy ? "Saving" : "Save"}
              </button>
            </span>
          </div>
        </div>
      ) : instructions.trim() ? (
        <p className="ui-body line-clamp-4 whitespace-pre-wrap text-muted-foreground">{instructions}</p>
      ) : (
        <p className="ui-body text-muted-foreground">None yet. Say how the AI should work here: who the people are, what to focus on.</p>
      )}
    </section>
  );
}
