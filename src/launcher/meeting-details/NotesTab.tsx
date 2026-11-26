import { useEffect, useMemo, useState } from "react";
import { Copy, Download, Undo2 } from "lucide-react";
import { EMPTY_ENTRY, useLiveNotesStore } from "../../stores/liveNotesStore";
import { NotePage } from "../../live-notes/NotePage";
import { docToMarkdown } from "../../live-notes/page";
import { copyText } from "../../live-notes/clipboard";
import { saveExportFile } from "../../lib/export";
import { can, endedSentence, endedWords, inFlight, notCoveredText, runWords } from "../../live-notes/runState";
import { MovedOnlineLine } from "../../live-notes/MovedOnline";
import { useMeetingStore } from "../../stores/meetingStore";

interface NotesTabProps {
  meetingId: string;
  title: string;
  /** Jump to the transcript line spoken at this meeting time (ms). */
  onJump?: (ms: number) => void;
}

/** The notes of a meeting, set as a page. Editable; copy or save as Markdown. */
export function NotesTab({ meetingId, title, onJump }: NotesTabProps) {
  const store = useLiveNotesStore;
  const { doc, undoStack } = store((s) => s.entries[meetingId] ?? EMPTY_ENTRY);
  const settings = store((s) => s.settings);
  const run = store((s) => s.runs[meetingId] ?? null);
  const notice = store((s) => s.notice);
  const live = useMeetingStore((s) => s.activeMeeting?.id === meetingId);
  const error = store((s) => s.error);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    setLoaded(false);
    void store
      .getState()
      .attach(meetingId)
      .then((u) => {
        if (gone) u();
        else off = u;
        setLoaded(true);
      });
    return () => {
      gone = true;
      off?.();
    };
  }, [meetingId, store]);

  const actions = useMemo(() => {
    const s = store.getState();
    return {
      setText: (id: string, text: string) => void s.setText(meetingId, id, text),
      setType: (id: string, type: Parameters<typeof s.setType>[2]) => void s.setType(meetingId, id, type),
      togglePin: (id: string) => void s.togglePin(meetingId, id),
      addLine: (type: Parameters<typeof s.addLine>[1], parent: string | null, text: string, after?: string | null) => void s.addLine(meetingId, type, parent, text, after),
      deleteLine: (id: string) => void s.deleteLine(meetingId, id),
      undo: () => void s.undo(meetingId),
    };
  }, [store, meetingId]);

  const mine = doc;
  const markdown = docToMarkdown(mine, title);
  const empty = !mine || mine.blocks.length === 0;

  return (
    <div className="rs-root mx-auto w-full max-w-3xl" data-testid="notes-tab">
      <div className="rs-head">
        <h2 className="rs-status">Notes</h2>
        <button type="button" className="rs-tool rs-tool-solid" disabled={empty} onClick={() => void copyText(markdown, "Notes copied")}>
          <Copy className="h-3 w-3" aria-hidden />
          Copy as Markdown
        </button>
        <button
          type="button"
          className="rs-tool rs-tool-solid"
          disabled={empty}
          onClick={() => void saveExportFile({ defaultName: `${title || "meeting"} notes`, extension: "md", filterLabel: "Markdown", content: markdown })}
        >
          <Download className="h-3 w-3" aria-hidden />
          Save as file
        </button>
        {undoStack.length > 0 && (
          <button type="button" className="rs-tool" onClick={() => void store.getState().undo(meetingId)}>
            <Undo2 className="h-3 w-3" aria-hidden />
            Undo {undoStack[undoStack.length - 1].label.toLowerCase()}
          </button>
        )}
      </div>
      <MovedOnlineLine moved={run?.moved_online} what="Notes" onDismiss={() => void store.getState().dismissMoved(meetingId)} />
      {run && !(empty && run.status === "off") && !(empty && run.ended?.kind === "nothing_to_note") && (
        <div className="rs-notice" role="group" aria-label="State of the notes">
          <div className="rs-notice-title" data-testid="notes-tab-state">
            {live ? runWords("notes", run.status, run.status !== "off", { manual: settings?.update_mode === "manual" }).word : endedWords(run)}
          </div>
          {!live && endedSentence(run.ended) && <p>{endedSentence(run.ended)}</p>}
          {!live && notCoveredText(run.not_covered) && <p>{notCoveredText(run.not_covered)}</p>}
          {run.reason && !live && ["error", "capped", "paused"].includes(run.status) && <p>{run.reason}</p>}
          {!live && (can(run, "update") || can(run, "keep_going") || inFlight(run)) && (
            <div className="rs-notice-actions">
              {(can(run, "update") || inFlight(run)) && (
                <button type="button" className="rs-tool rs-tool-solid" disabled={inFlight(run)} onClick={() => void store.getState().updateNow(meetingId)}>
                  {inFlight(run) ? "Updating" : "Update notes"}
                </button>
              )}
              {can(run, "keep_going") && (
                <button type="button" className="rs-tool" onClick={() => void store.getState().keepGoing(meetingId)}>
                  Keep going
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {notice && (
        <div className="rs-notice" role="status">
          <div className="rs-notice-title">Not updated</div>
          <p>{notice}</p>
        </div>
      )}
      {error && (
        <div className="rs-notice" role="alert">
          <div className="rs-notice-title">That did not work</div>
          <p>{error}</p>
        </div>
      )}
      {!loaded ? (
        <p className="rs-empty text-muted-foreground" role="status">Loading the notes</p>
      ) : empty && run?.ended?.kind === "nothing_to_note" ? (
        <div className="rs-empty">
          <h3>Nothing to note</h3>
          <p>{endedSentence(run.ended)}</p>
        </div>
      ) : empty ? (
        <div className="rs-empty">
          <h3>No notes for this meeting</h3>
          <p>Turn on live notes in the meeting window and they are saved here, ready to edit and export.</p>
        </div>
      ) : (
        <NotePage
          doc={mine!}
          colors={settings?.colors ?? true}
          editable
          jump={onJump}
          actions={actions}
          className="min-h-[24rem]"
        />
      )}
    </div>
  );
}
