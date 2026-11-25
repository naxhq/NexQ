import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, Check, Copy, ListPlus, RefreshCw } from "lucide-react";
import { Dialog, Button, buttonClasses } from "../../ui";
import { addAnswerToInstructions, saveAnswerToLibrary } from "../../lib/ipc";
import type { WorkspaceMessage } from "../../lib/types";
import { showToast } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { cn } from "../../lib/utils";
import { ModelPicker, PickerCaret } from "./ModelPicker";
import type { ModelChoice } from "./models";


/** The answer without its `[S1]` tags, for copying and for saving. */
export function plainAnswer(content: string): string {
  return content.replace(/\s?\[S\d+(?:\s*,\s*S\d+)*\]/g, "").trim();
}

function titleFrom(question: string): string {
  const one = question.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 59).trimEnd()}…` : one || "Chat answer";
}

/**
 * Copy, ask another model, save to the library, add to the instructions. Each says what it
 * did (a toast, or "Copied" in place) and what went wrong when it didn't.
 */
export function AnswerActions({
  workspaceId,
  message,
  question,
  busy,
  current,
  onRetryWith,
  onOpenSettings,
}: {
  workspaceId: string;
  message: WorkspaceMessage;
  question: string;
  busy: boolean;
  current: { provider: string; model: string } | null;
  onRetryWith: (choice: ModelChoice) => void;
  onOpenSettings: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainAnswer(message.content));
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      showToast("Couldn't copy. Select the text and copy it instead.", "error");
    }
  };

  return (
    <>
      <div className="-ml-2 mt-1 flex flex-wrap items-center gap-x-0.5">
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
        <ModelPicker
          value={current}
          label="Ask again with another model"
          onPick={onRetryWith}
          onOpenSettings={onOpenSettings}
          disabled={busy}
          buttonClassName={buttonClasses("ghost", "sm")}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Ask another model
          <PickerCaret />
        </ModelPicker>
        <Button variant="ghost" size="sm" onClick={() => setSaving(true)} disabled={message.id < 0}>
          <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Save to library
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)} disabled={message.id < 0}>
          <ListPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Add to instructions
        </Button>
      </div>
      {saving && <SaveDialog messageId={message.id} initial={titleFrom(question)} onClose={() => setSaving(false)} />}
      <AddToInstructions open={addOpen} workspaceId={workspaceId} messageId={message.id} text={plainAnswer(message.content)} onClose={() => setAddOpen(false)} />
    </>
  );
}

function SaveDialog({ messageId, initial, onClose }: { messageId: number; initial: string; onClose: () => void }) {
  const [title, setTitle] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const save = async () => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveAnswerToLibrary(messageId, name);
      showToast("Saved to the library as a document.", "success");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save this answer to the library"
      description="It becomes a Markdown document in this workspace, so later answers can use it."
      initialFocusRef={input}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !title.trim()}>
            {busy ? "Saving" : "Save"}
          </Button>
        </>
      }
    >
      <label className="ui-section mb-1.5 block text-foreground" htmlFor="ws-save-title">
        Document name
      </label>
      <input
        id="ws-save-title"
        ref={input}
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
        className="ui-body w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none ui-focus ui-r-lg"
      />
      {error && (
        <p role="alert" className="ui-body mt-2 text-destructive">
          Couldn't save it: {error}
        </p>
      )}
    </Dialog>
  );
}

export const INSTRUCTION_CAP = 4000;

/**
 * An answer as plain instruction text: no HTML, no link or image targets or titles, no reference
 * definitions, no hidden characters, no [S1] tags. What this returns is what the user then sees
 * and may edit, and it is stored exactly as shown.
 */
export function plainInstructionText(markdown: string): string {
  return plainAnswer(markdown)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, INSTRUCTION_CAP);
}

function AddToInstructions({ open, workspaceId, messageId, text, onClose }: { open: boolean; workspaceId: string; messageId: number; text: string; onClose: () => void }) {
  if (!open) return null;
  return <AddToInstructionsDialog workspaceId={workspaceId} messageId={messageId} preview={plainInstructionText(text)} onClose={onClose} />;
}

/**
 * The backend adds the saved answer itself (it checks, in one step, that nothing the answer used
 * has left the workspace), so the text is shown here to read, not to edit. It can be undone
 * right after: the instructions go back to what they were.
 */
function AddToInstructionsDialog({ workspaceId, messageId, preview, onClose }: { workspaceId: string; messageId: number; preview: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ before: string } | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const store = useWorkspaceStore.getState();
      const before = ((await store.loadDetail(workspaceId)) ?? store.details[workspaceId])?.instructions ?? "";
      await addAnswerToInstructions(messageId);
      void store.loadDetail(workspaceId);
      setDone({ before });
    } catch (e) {
      // The backend's own words, for example that something the answer used left this workspace.
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!done || busy) return;
    setBusy(true);
    setError(null);
    try {
      await useWorkspaceStore.getState().update(workspaceId, { instructions: done.before });
      showToast("Taken out of the instructions again.", "success");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={done ? "Added to the instructions" : "Add this to the instructions?"}
      description="These words become instructions the AI follows in every question of this workspace. Add it only if you want it to obey this."
      size="lg"
      initialFocusRef={field}
      dismissible={!busy}
      footer={
        done ? (
          <>
            <Button onClick={() => void undo()} disabled={busy}>
              Undo
            </Button>
            <Button variant="primary" onClick={onClose} disabled={busy}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void confirm()} disabled={busy}>
              {busy ? "Adding" : "Add to instructions"}
            </Button>
          </>
        )
      }
    >
      <label htmlFor="ws-add-instr" className="ui-section mb-1.5 block text-foreground">
        The answer, as plain text
      </label>
      <textarea
        id="ws-add-instr"
        ref={field}
        value={preview}
        readOnly
        rows={10}
        className="ui-body max-h-[50vh] w-full resize-y overflow-y-auto rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none ui-focus ui-r-lg"
      />
      <p className="ui-meta mt-1 text-muted-foreground">Added after what is already there, as plain text: links, images and HTML are left out.</p>
      {error && (
        <p role="alert" className="ui-body mt-2 text-destructive">
          {error}
        </p>
      )}
    </Dialog>
  );
}
