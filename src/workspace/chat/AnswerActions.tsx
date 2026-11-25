import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, Check, Copy, ListPlus, RefreshCw } from "lucide-react";
import { Dialog, Button, buttonClasses } from "../../ui";
import { addAnswerToInstructions, saveAnswerToLibrary } from "../../lib/ipc";
import type { WorkspaceMessage } from "../../lib/types";
import { showToast } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { cn } from "../../lib/utils";
import { ModelPicker, PickerCaret } from "./ModelPicker";
import { DOCUMENT_CAP, INSTRUCTION_CAP, describeRemoved, hiddenCount, sanitizeDocumentText, sanitizeInstructionText, stripHidden } from "./instructionText";
import type { ModelChoice } from "./models";


/** The answer without its `[S1]` tags, for copying and for saving. */
export function plainAnswer(content: string): string {
  return stripHidden(content).replace(/\s?\[S\d+(?:\s*,\s*S\d+)*\]/g, "").trim();
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
      {saving && <SaveDialog messageId={message.id} initial={titleFrom(question)} answer={message.content} onClose={() => setSaving(false)} />}
      <AddToInstructions open={addOpen} workspaceId={workspaceId} messageId={message.id} text={plainAnswer(message.content)} onClose={() => setAddOpen(false)} />
    </>
  );
}

/**
 * The document that is stored is the text in the box, read and editable here as plain text: no
 * HTML, no link or image targets, no hidden characters. If something had to be removed, the box
 * is cleaned and nothing is saved until it is read again. The backend refuses anything cleaning
 * would change, so what was shown is what is stored.
 */
function SaveDialog({ messageId, initial, answer, onClose }: { messageId: number; initial: string; answer: string; onClose: () => void }) {
  const [title, setTitle] = useState(initial);
  const [text, setText] = useState(() => sanitizeDocumentText(answer));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const save = async () => {
    const name = title.trim();
    if (!name || !text.trim() || busy) return;
    const clean = sanitizeDocumentText(text);
    if (clean !== text) {
      const hidden = hiddenCount(text);
      setText(clean);
      setError(
        hidden > 0
          ? `Removed ${hidden} hidden ${hidden === 1 ? "character" : "characters"}${Array.from(text).length - hidden > DOCUMENT_CAP ? ` and everything after ${DOCUMENT_CAP.toLocaleString()} characters` : ""}. Read it again, then save.`
          : `Cut at ${DOCUMENT_CAP.toLocaleString()} characters. Read it again, then save.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveAnswerToLibrary(messageId, name, text);
      showToast("Saved to the library as a document.", "success");
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save this answer to the library"
      description="It becomes a document in this workspace, so later answers can use it. What you see below is what is saved, as it is: code, links and HTML are kept, and only hidden characters are removed."
      size="lg"
      initialFocusRef={input}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !title.trim() || !text.trim()}>
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
        className="ui-body w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none ui-focus ui-r-lg"
      />
      <label className="ui-section mb-1.5 mt-3 block text-foreground" htmlFor="ws-save-text">
        Text to save
      </label>
      <textarea
        id="ws-save-text"
        value={text}
        rows={10}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        className="ui-body max-h-[45vh] w-full resize-y overflow-y-auto rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none ui-focus ui-r-lg"
      />
      <p className="ui-meta mt-1 text-right tabular-nums text-muted-foreground">
        {text.length.toLocaleString()} characters.
      </p>
      {error && (
        <p role="alert" className="ui-body mt-2 text-destructive">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export { INSTRUCTION_CAP } from "./instructionText";

/** An answer as plain instruction text (see `instructionText.ts`): what the dialog starts from. */
export function plainInstructionText(markdown: string): string {
  return sanitizeInstructionText(markdown);
}

function AddToInstructions({ open, workspaceId, messageId, text, onClose }: { open: boolean; workspaceId: string; messageId: number; text: string; onClose: () => void }) {
  if (!open) return null;
  return <AddToInstructionsDialog workspaceId={workspaceId} messageId={messageId} preview={plainInstructionText(text)} onClose={onClose} />;
}

/**
 * The words the person reviews are the words that are stored: the box is editable, what is in it
 * is sent as it is, and the backend refuses anything that cleaning would change. If the text has
 * hidden characters, HTML or link targets (typed or pasted), the box is cleaned and nothing is
 * sent until it is reviewed again. Undo puts the instructions back right after.
 */
function AddToInstructionsDialog({ workspaceId, messageId, preview, onClose }: { workspaceId: string; messageId: number; preview: string; onClose: () => void }) {
  const [text, setText] = useState(preview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ before: string } | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const confirm = async () => {
    if (busy || !text.trim()) return;
    const clean = sanitizeInstructionText(text);
    if (clean !== text) {
      const removed = describeRemoved(text);
      setText(clean);
      setError(`Removed: ${removed.length ? removed.join(", ") : "extra spaces"}. Read it again, then add it.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const store = useWorkspaceStore.getState();
      const before = ((await store.loadDetail(workspaceId)) ?? store.details[workspaceId])?.instructions ?? "";
      await addAnswerToInstructions(messageId, text);
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
      description="These words become instructions the AI follows in every question of this workspace. Edit them, and keep only what you want it to obey."
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
            <Button variant="primary" onClick={() => void confirm()} disabled={busy || !text.trim()}>
              {busy ? "Adding" : "Add to instructions"}
            </Button>
          </>
        )
      }
    >
      <label htmlFor="ws-add-instr" className="ui-section mb-1.5 block text-foreground">
        Text to add
      </label>
      <textarea
        id="ws-add-instr"
        ref={field}
        value={text}
        readOnly={!!done}
        maxLength={INSTRUCTION_CAP}
        rows={10}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        className="ui-body max-h-[50vh] w-full resize-y overflow-y-auto rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none ui-focus ui-r-lg"
      />
      <p className="ui-meta mt-1 text-right tabular-nums text-muted-foreground">
        {text.length.toLocaleString()} of {INSTRUCTION_CAP.toLocaleString()} characters. Plain text only: links, images and HTML are not kept.
      </p>
      {error && (
        <p role="alert" className="ui-body mt-2 text-destructive">
          {error}
        </p>
      )}
    </Dialog>
  );
}
