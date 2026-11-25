import { useEffect, useRef, useState } from "react";
import type { TalkingPoint } from "../../lib/types";
import { useTalkingPointsStore } from "../../stores/talkingPointsStore";
import { LazyRichEditor } from "../editor/LazyRichEditor";
import { parseDoc, type TpDoc } from "../doc/model";
import { Button } from "../../ui";
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
  const state = useTalkingPointsStore((s) => s.saveState[note.id]);
  const theirs = useTalkingPointsStore((s) => s.theirs[note.id]);
  const [both, setBoth] = useState(false);
  const conflict = state === "conflict";

  // the meeting edit starts from this version of the note: saving it back says so
  useEffect(() => {
    useTalkingPointsStore.getState().beginMeetingEdit(note.id);
  }, [note.id]);

  const settle = async (which: "mine" | "theirs") => {
    setBusy("workspace");
    setError(null);
    try {
      const s = useTalkingPointsStore.getState();
      await s.resolveConflict(note.id, which);
      if (useTalkingPointsStore.getState().saveState[note.id] === "failed") throw new Error(useTalkingPointsStore.getState().saveError[note.id] ?? "Could not save");
      // either way the meeting-only copy has done its job
      await s.discardMeetingEdit(meetingId, note.id);
      onDone();
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Could not save.");
      setBusy(null);
    }
  };

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
      {conflict && (
        <div role="alert" className="shrink-0 space-y-1.5 border-t border-border px-3 py-2">
          <p className="ui-body text-destructive">The note was changed in another window since you started this edit. Nothing was overwritten.</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="primary"  disabled={busy !== null} onClick={() => void settle("mine")}>
              Keep mine
            </Button>
            <Button  disabled={busy !== null} onClick={() => void settle("theirs")}>
              Use theirs
            </Button>
            <Button
              aria-expanded={both}
              onClick={() => {
                setBoth((v) => !v);
                void useTalkingPointsStore.getState().loadTheirs(note.id);
              }}
            >
              See both
            </Button>
          </div>
          {both && (
            <p className="ui-body max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-2.5" aria-label="Their version">
              {theirs ? theirs.plain_text || "(empty)" : "Loading their version"}
            </p>
          )}
        </div>
      )}
      {error && !conflict && (
        <p role="alert" className="ui-meta shrink-0 px-3 pb-1 text-destructive">
          {error}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border px-2 py-1.5">
        <Button
          onClick={() => {
            useTalkingPointsStore.getState().endMeetingEdit(note.id);
            onDone();
          }}
          disabled={busy !== null}
        >
          Cancel
        </Button>
        <Button  onClick={() => void run("meeting")} disabled={busy !== null}>
          Only this meeting
        </Button>
        <Button variant="primary"  onClick={() => void run("workspace")} disabled={busy !== null}>
          Save to workspace
        </Button>
      </div>
    </div>
  );
}
