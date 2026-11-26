import { useEffect, useRef, useState } from "react";
import { Pencil, ScrollText } from "lucide-react";
import { Button, Dialog } from "../ui";
import { showToast } from "../stores/toastStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { fieldClass, hintClass } from "./styles";
import { PanelAction, PanelSection } from "./PanelSection";
import { PanelEmpty } from "./PanelRow";

/** Rough size the way the old custom instructions counted it: characters over four. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * The workspace's instructions: one line here (what they start with, or "None yet"), the whole text in
 * a dialog to read and edit. Saved only when asked.
 */
export function InstructionsBlock({ workspaceId, instructions }: { workspaceId: string; instructions: string }) {
  const update = useWorkspaceStore((s) => s.update);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(instructions);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(instructions);
  }, [instructions, editing]);
  useEffect(() => setEditing(false), [workspaceId]);

  const close = () => {
    setDraft(instructions);
    setEditing(false);
  };
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

  const preview = instructions.replace(/\s+/g, " ").trim();
  return (
    <PanelSection
      id="instructions"
      icon={ScrollText}
      title="Instructions"
      info="How the AI should work in this workspace: who the people are, what to focus on, how to answer. It reads them before every answer here."
      infoLabel="About instructions"
      action={<PanelAction label="Edit instructions" icon={Pencil} onClick={() => setEditing(true)} />}
    >
      {preview ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-haspopup="dialog"
          className="ui-body ui-focus ui-r-md -mx-1 block w-[calc(100%+0.5rem)] truncate rounded-md px-1 py-0.5 text-left text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          {preview}
        </button>
      ) : (
        <PanelEmpty>None yet.</PanelEmpty>
      )}
      <Dialog
        open={editing}
        onClose={close}
        dismissible={!busy}
        title="Instructions"
        description="How the AI should work in this workspace."
        initialFocusRef={field}
        footer={
          <>
            <span className={`${hintClass} mr-auto`}>About {estimateTokens(draft)} tokens</span>
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={busy || draft === instructions}>
              {busy ? "Saving" : "Save"}
            </Button>
          </>
        }
      >
        <textarea
          ref={field}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={10}
          aria-label="Instructions for the AI"
          className={`${fieldClass} resize-y`}
          placeholder="Who the people are, what to focus on, how to answer."
        />
      </Dialog>
    </PanelSection>
  );
}
