import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, Check, Copy, ListPlus, RefreshCw } from "lucide-react";
import { Dialog, buttonClass } from "../../ui";
import { saveAnswerToLibrary } from "../../lib/ipc";
import type { WorkspaceMessage } from "../../lib/types";
import { showToast } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { cn } from "../../lib/utils";
import { ModelPicker, PickerCaret } from "./ModelPicker";
import type { ModelChoice } from "./models";

const actionClass =
  "ui-meta inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50";

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
        <button type="button" onClick={() => void copy()} className={actionClass}>
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
        <ModelPicker
          value={current}
          label="Ask again with another model"
          onPick={onRetryWith}
          onOpenSettings={onOpenSettings}
          disabled={busy}
          buttonClassName={cn(actionClass)}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Ask another model
          <PickerCaret />
        </ModelPicker>
        <button type="button" onClick={() => setSaving(true)} className={actionClass} disabled={message.id < 0}>
          <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Save to library
        </button>
        <button type="button" onClick={() => setAddOpen(true)} className={actionClass}>
          <ListPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Add to instructions
        </button>
      </div>
      {saving && <SaveDialog messageId={message.id} initial={titleFrom(question)} onClose={() => setSaving(false)} />}
      <AddToInstructions open={addOpen} workspaceId={workspaceId} text={plainAnswer(message.content)} onClose={() => setAddOpen(false)} />
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
          <button type="button" onClick={onClose} disabled={busy} className={cn(buttonClass.base, buttonClass.quiet)}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={busy || !title.trim()} className={cn(buttonClass.base, buttonClass.primary)}>
            {busy ? "Saving" : "Save"}
          </button>
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
        className="ui-body w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
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

function AddToInstructions({ open, workspaceId, text, onClose }: { open: boolean; workspaceId: string; text: string; onClose: () => void }) {
  if (!open) return null;
  return <AddToInstructionsDialog workspaceId={workspaceId} initial={plainInstructionText(text)} onClose={onClose} />;
}

function AddToInstructionsDialog({ workspaceId, initial, onClose }: { workspaceId: string; initial: string; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const confirm = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const store = useWorkspaceStore.getState();
      const detail = (await store.loadDetail(workspaceId)) ?? store.details[workspaceId];
      const current = detail?.instructions?.trimEnd() ?? "";
      // Exactly what is in the box, after what is already there.
      await store.update(workspaceId, { instructions: current ? `${current}\n\n${text}` : text });
      showToast("Added to the instructions.", "success");
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
      title="Add this to the instructions?"
      description="These words become instructions the AI follows in every question of this workspace. Edit them, and keep only what you want it to obey."
      size="lg"
      initialFocusRef={field}
      dismissible={!busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={cn(buttonClass.base, buttonClass.quiet)}>
            Cancel
          </button>
          <button type="button" onClick={() => void confirm()} disabled={busy || !text.trim()} className={cn(buttonClass.base, buttonClass.primary)}>
            {busy ? "Adding" : "Add to instructions"}
          </button>
        </>
      }
    >
      <label htmlFor="ws-add-instr" className="ui-section mb-1.5 block text-foreground">
        Text to add
      </label>
      <textarea
        id="ws-add-instr"
        ref={field}
        value={text}
        maxLength={INSTRUCTION_CAP}
        rows={10}
        onChange={(e) => setText(e.target.value)}
        className="ui-body max-h-[50vh] w-full resize-y overflow-y-auto rounded-lg border border-input bg-background px-3 py-2 text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      <p className="ui-meta mt-1 text-right tabular-nums text-muted-foreground">
        {text.length.toLocaleString()} of {INSTRUCTION_CAP.toLocaleString()} characters. Plain text only: links, images and HTML were removed.
      </p>
      {error && (
        <p role="alert" className="ui-body mt-2 text-destructive">
          Couldn't change the instructions: {error}
        </p>
      )}
    </Dialog>
  );
}
