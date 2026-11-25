import { useRef, useState } from "react";
import type { TalkingPoint } from "../../lib/types";
import { useTalkingPointsStore } from "../../stores/talkingPointsStore";
import { LazyRichEditor } from "../editor/LazyRichEditor";
import { parseDoc, type TpDoc } from "../doc/model";
import { buttonClass } from "../../ui";
import { cn } from "../../lib/utils";

interface Props {
  note: TalkingPoint;
  /** The text on screen: the meeting-only copy when there is one. */
  docJson: string;
  meetingId: string;
  onDone: () => void;
}

/**
 * Editing a note while the meeting runs. Two ways to keep it: for this meeting only
 * (the workspace note stays as it was) or in the workspace (every later meeting).
 */
export function PromptEditor({ note, docJson, meetingId, onDone }: Props) {
  const draft = useRef<TpDoc | null>(null);
  const [busy, setBusy] = useState<"meeting" | "workspace" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);

  const run = async (kind: "meeting" | "workspace") => {
    const doc = draft.current ?? parseDoc(docJson);
    setBusy(kind);
    setError(null);
    try {
      const s = useTalkingPointsStore.getState();
      if (kind === "meeting") await s.saveMeetingOnly(meetingId, note.id, doc);
      else await s.saveToWorkspace(meetingId, note.id, doc);
      onDone();
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Could not save.");
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2">
        <LazyRichEditor
          docJson={docJson}
          resetKey={note.id}
          ariaLabel={`Edit ${note.title}`}
          autoFocus
          compact
          onChange={(doc) => {
            draft.current = doc;
            dirty.current = true;
          }}
        />
      </div>
      {error && (
        <p role="alert" className="ui-meta shrink-0 px-3 pb-1 text-destructive">
          {error}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border px-2 py-1.5">
        <button type="button" className={cn(buttonClass.base, buttonClass.quiet)} onClick={onDone} disabled={busy !== null}>
          Cancel
        </button>
        <button type="button" className={cn(buttonClass.base, buttonClass.quiet)} onClick={() => void run("meeting")} disabled={busy !== null}>
          Only this meeting
        </button>
        <button type="button" className={cn(buttonClass.base, buttonClass.primary)} onClick={() => void run("workspace")} disabled={busy !== null}>
          Save to workspace
        </button>
      </div>
    </div>
  );
}
