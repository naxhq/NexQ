import { useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Play, RefreshCw, Undo2 } from "lucide-react";
import { Dialog, Kbd, Menu, Segmented, type MenuItemSpec, Button } from "../ui";
import { cn } from "../lib/utils";
import type { NotetakerSettings, NotetakerState } from "../lib/types";
import { onNotesUpdateRequested } from "../lib/events";
import { useMeetingStore } from "../stores/meetingStore";
import { EMPTY_ENTRY, useLiveNotesStore } from "../stores/liveNotesStore";
import { NotePage } from "./NotePage";
import { MovedOnlineLine } from "./MovedOnline";
import { Countdown, RunStatusHeader } from "./RunStatusHeader";
import { can, endedSentence, endedWords, inFlight, modelLine, notCoveredText, runWords } from "./runState";
import { useAutomaticModel } from "../models/useAutomaticModel";
import { describeModel } from "../models/ModelField";
import { NotesSettingsForm, formatTokens } from "./NotesSettingsForm";
import { jumpToTranscript } from "./jump";
import { docToMarkdown } from "./page";
import { copyText } from "./clipboard";

/** The run's state in plain words. */
export function statusWords(run: NotetakerState | null, settings: NotetakerSettings | null): { word: string; note?: string } {
  return runWords("notes", run?.status, !!settings?.enabled, { manual: settings?.update_mode === "manual" });
}

/** The live notes panel of the meeting window. Takes no props. */
export function NotesPanel() {
  const live = useMeetingStore((s) => s.activeMeeting?.id ?? "");
  // After the meeting ends the notes stay on show, read as they were.
  const last = useRef("");
  if (live) last.current = live;
  const meetingId = live || last.current;
  const ended = !live && !!meetingId;
  const store = useLiveNotesStore;
  const entry = store((s) => s.entries[meetingId] ?? EMPTY_ENTRY);
  const { doc, fresh, arrivals, undoStack } = entry;
  const run = store((s) => s.runs[meetingId] ?? null);
  const settings = store((s) => s.settings);
  const error = store((s) => s.error);
  const notice = store((s) => s.notice);
  const deadline = store((s) => s.deadlines[meetingId] ?? null);
  const automatic = useAutomaticModel(store((s) => s.settings?.provider ?? null)).model;
  const [dialog, setDialog] = useState(false);
  const [scope, setScope] = useState<NotetakerSettings["scope"]>("meeting");

  useEffect(() => {
    if (!meetingId) return;
    let off: (() => void) | null = null;
    let gone = false;
    void store
      .getState()
      .attach(meetingId)
      .then((u) => {
        if (gone) u();
        else off = u;
      });
    return () => {
      gone = true;
      off?.();
    };
  }, [meetingId, store]);

  // Settings change from the other window too.
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    void store
      .getState()
      .watchSettings()
      .then((u) => (gone ? u() : (off = u)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [store]);

  // The N key (raised by the meeting window's shortcuts) asks for an update.
  useEffect(
    () =>
      onNotesUpdateRequested(() => {
        const s = store.getState();
        const r = s.runs[meetingId];
        if (s.settings?.enabled && can(r, "update") && !inFlight(r)) void s.updateNow();
      }),
    [store, meetingId],
  );

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

  if (!meetingId) {
    return <div className="rs-root"><p className="rs-empty text-muted-foreground">Notes appear here once a meeting has started.</p></div>;
  }

  const stat = statusWords(run, settings);
  const word = ended ? endedWords(run) : stat.word;
  const baseNote = ended ? undefined : stat.note;
  const waiting = run?.status === "waiting" || run?.status === "on";
  const note = baseNote ?? (deadline && waiting && settings?.update_mode !== "manual" ? <Countdown deadline={deadline} /> : undefined);
  const busy = inFlight(run);
  const colors = settings?.colors ?? true;
  const hasBlocks = (doc?.blocks.length ?? 0) > 0;
  const enabled = !!settings?.enabled && !ended;
  const capped = run?.status === "capped" || (can(run, "keep_going") && run?.status !== "off");
  const failed = !capped && (run?.status === "error" || (run?.status === "paused" && !!run.reason));
  const missed = notCoveredText(run?.not_covered);
  const used = run?.tokens_used ?? 0;
  // The run's own limit: after Keep going it is higher than the setting.
  const cap = run?.cap || settings?.cap || 0;

  const menu: MenuItemSpec[] = [
    ...(enabled && can(run, "pause") ? [{ id: "pause", label: "Pause notes", onSelect: () => void store.getState().pause() }] : []),
    { id: "copy", label: "Copy all as Markdown", disabled: !hasBlocks, onSelect: () => void copyText(docToMarkdown(doc), "Notes copied") },
    {
      id: "mode",
      label: settings?.update_mode === "manual" ? "Update automatically" : "Update only when I ask",
      onSelect: () => void store.getState().patchSettings({ update_mode: settings?.update_mode === "manual" ? "automatic" : "manual" }),
    },
    { id: "colors", label: "Colour people and places", checked: colors, onSelect: () => void store.getState().patchSettings({ colors: !colors }) },
    { id: "settings", label: "Model, detail and limit", separatorBefore: true, onSelect: () => setDialog(true) },
    { id: "stop", label: "Stop notes for this meeting", danger: true, disabled: !enabled || run?.status === "finished" || run?.status === "off", onSelect: () => void store.getState().stop() },
  ];

  return (
    <div className="rs-root" data-testid="notes-panel">
      <RunStatusHeader title="Live notes" word={word} note={note}>
        {enabled && (can(run, "update") || busy) && (
          <button type="button" className="rs-tool rs-tool-solid" disabled={busy} onClick={() => void store.getState().updateNow()}>
            <RefreshCw className="h-3 w-3" aria-hidden />
            Update now
            <Kbd>N</Kbd>
          </button>
        )}
        {enabled && can(run, "resume") && (
          <button type="button" className="rs-tool rs-tool-solid" onClick={() => void store.getState().resume()}>
            <Play className="h-3 w-3" aria-hidden />
            Resume
          </button>
        )}
        {enabled && can(run, "start") && (
          <button type="button" className="rs-tool rs-tool-solid" onClick={() => void store.getState().start()}>
            <Play className="h-3 w-3" aria-hidden />
            <span aria-hidden>Start again</span>
            <span className="rs-sr">Start notes again</span>
          </button>
        )}
        {!ended && !(settings?.enabled) && settings && hasBlocks && (
          <button type="button" className="rs-tool rs-tool-solid" onClick={() => void store.getState().turnOn(settings.scope)}>
            <Play className="h-3 w-3" aria-hidden />
            Turn on notes
          </button>
        )}
        <Menu
          items={menu}
          label="Notes options"
          align="end"
          renderTrigger={(props) => (
            <button {...props} type="button" className="rs-tool h-[1.625rem] w-[1.625rem] justify-center px-0" aria-label="Notes options">
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        />
      </RunStatusHeader>

      <MovedOnlineLine moved={run?.moved_online} what="Notes" onDismiss={() => void store.getState().dismissMoved(meetingId)} />

      {capped && (
        <div className="rs-notice" role="group" aria-labelledby="ln-cap-title">
          <div id="ln-cap-title" className="rs-notice-title">Keep taking notes?</div>
          <p>
            The notes used {formatTokens(used)} tokens, the limit you set. Keep going adds {formatTokens(cap)} more.
          </p>
          <div className="rs-notice-actions">
            {can(run, "keep_going") && (
              <Button variant="primary" size="sm" onClick={() => void store.getState().keepGoing(meetingId)}>
                Keep going
              </Button>
            )}
            <Button size="sm"  onClick={() => void store.getState().stop()}>
              Stop
            </Button>
          </div>
        </div>
      )}

      {failed && !capped && (
        <div className="rs-notice" role="alert">
          <div className="rs-notice-title">{run?.status === "error" ? "Notes stopped" : "Notes paused"}</div>
          <p>{run?.reason || "The model could not answer."}</p>
          <div className="rs-notice-actions">
            <button type="button" className="rs-tool rs-tool-solid" onClick={() => setDialog(true)}>Change model</button>
            {can(run, "try_again") && <button type="button" className="rs-tool" onClick={() => void store.getState().tryAgain()}>Try again</button>}
            {can(run, "start") && !can(run, "try_again") && <button type="button" className="rs-tool" onClick={() => void store.getState().start()}>Start notes again</button>}
          </div>
        </div>
      )}

      {ended && endedSentence(run?.ended) && (
        <div className="rs-notice" role="group" aria-label="How the notes ended">
          <div className="rs-notice-title">{endedWords(run)}</div>
          <p>{endedSentence(run?.ended)}</p>
        </div>
      )}

      {missed && (
        <div className="rs-notice" role="group" aria-labelledby="ln-missed-title">
          <div id="ln-missed-title" className="rs-notice-title">{missed}</div>
          <p>That part of the call is not in the notes yet.</p>
          {(can(run, "update") || busy) && (
            <div className="rs-notice-actions">
              <button type="button" className="rs-tool rs-tool-solid" disabled={busy} onClick={() => void store.getState().updateNow(meetingId)}>{busy ? "Updating" : "Update notes"}</button>
            </div>
          )}
        </div>
      )}

      {notice && (
        <div className="rs-notice" role="status">
          <div className="rs-notice-title">Not updated</div>
          <p>{notice}</p>
          <div className="rs-notice-actions">
            <button type="button" className="rs-tool" onClick={() => store.getState().clearError()}>Dismiss</button>
          </div>
        </div>
      )}

      {error && (
        <div className="rs-notice" role="alert">
          <div className="rs-notice-title">That did not work</div>
          <p>{error}</p>
          <div className="rs-notice-actions">
            <button type="button" className="rs-tool" onClick={() => store.getState().clearError()}>Dismiss</button>
          </div>
        </div>
      )}

      {!enabled && settings && !hasBlocks ? (
        <div className="rs-empty">
          <h3>Live notes</h3>
          <p>Turns the conversation into a tidy page of topics, decisions, tasks and questions while you talk. It sends only the transcript to your chosen model, nothing from your workspace.</p>
          <p data-testid="notes-model-line">{modelLine({ provider: settings?.provider ?? null, label: describeModel({ provider: settings?.provider ?? null, model: settings?.model ?? null, effort: null }) }, automatic)}</p>
          <div className="mt-3 flex flex-col gap-2">
            <Segmented
              label="Turn on for"
              value={scope}
              onChange={setScope}
              options={[
                { value: "meeting", label: "This meeting" },
                { value: "every", label: "Every meeting" },
              ]}
            />
            <div>
              <Button variant="primary"  onClick={() => void store.getState().turnOn(scope)}>
                Turn on notes
              </Button>
            </div>
          </div>
        </div>
      ) : !hasBlocks ? (
        <div className="rs-empty">
          <h3>Nothing yet</h3>
          <p>The first notes appear after a minute or so of conversation.</p>
        </div>
      ) : (
        doc && (
          <NotePage
            doc={doc}
            colors={colors}
            editable
            follow
            fresh={fresh}
            arrivals={arrivals}
            jump={jumpToTranscript}
            actions={actions}
          />
        )
      )}

      {(enabled || hasBlocks) && (
        <footer className="rs-foot">
          {enabled && cap > 0 && (
            <>
              <span>{formatTokens(used)} of {formatTokens(cap)} tokens{run?.total_tokens ? `, ${formatTokens(run.total_tokens)} seen in all` : ""}</span>
              <div
                className="rs-meter"
                role="meter"
                aria-label="Notes tokens used"
                aria-valuemin={0}
                aria-valuemax={cap}
                aria-valuenow={Math.min(used, cap)}
                data-high={used / cap > 0.85}
              >
                <span style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} />
              </div>
            </>
          )}
          {undoStack.length > 0 && (
            <button type="button" className="rs-tool ml-auto" onClick={() => void store.getState().undo(meetingId)}>
              <Undo2 className="h-3 w-3" aria-hidden />
              Undo {undoStack[undoStack.length - 1].label.toLowerCase()}
            </button>
          )}
        </footer>
      )}

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Live notes settings"
        footer={
          <Button variant="primary"  onClick={() => setDialog(false)}>
            Done
          </Button>
        }
      >
        {settings && <NotesSettingsForm settings={settings} onChange={(p) => void store.getState().patchSettings(p)} />}
      </Dialog>
    </div>
  );
}
