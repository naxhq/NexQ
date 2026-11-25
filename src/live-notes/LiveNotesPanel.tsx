import { useEffect, useMemo, useState } from "react";
import { Copy, MoreHorizontal, RefreshCw, Undo2 } from "lucide-react";
import { Dialog, Kbd, Menu, Segmented, buttonClass, type MenuItemSpec } from "../ui";
import { cn } from "../lib/utils";
import type { NotetakerSettings, NotetakerState } from "../lib/types";
import { onNotesUpdateRequested } from "../lib/events";
import { useMeetingStore } from "../stores/meetingStore";
import { EMPTY_ENTRY, useLiveNotesStore } from "../stores/liveNotesStore";
import { NotePage } from "./NotePage";
import { RunStatusHeader, runWords } from "./RunStatusHeader";
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
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id ?? "");
  const store = useLiveNotesStore;
  const entry = store((s) => s.entries[meetingId] ?? EMPTY_ENTRY);
  const { doc, fresh, arrivals, undoStack } = entry;
  const run = store((s) => s.runs[meetingId] ?? null);
  const settings = store((s) => s.settings);
  const error = store((s) => s.error);
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
        const r = s.runs[meetingId]?.status;
        if (s.settings?.enabled && r !== "running" && r !== "capped") void s.updateNow();
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

  const { word, note: baseNote } = statusWords(run, settings);
  const nextS = run?.status === "idle" && run.next_in_ms && run.next_in_ms > 0 ? Math.ceil(run.next_in_ms / 1000) : 0;
  const note = baseNote ?? (nextS ? `next update in about ${nextS} s` : undefined);
  const colors = settings?.colors ?? true;
  const hasBlocks = (doc?.blocks.length ?? 0) > 0;
  const enabled = !!settings?.enabled;
  const capped = run?.status === "capped";
  const failed = run?.status === "error" || (run?.status === "paused" && !!run.reason);
  const used = run?.tokens_used ?? 0;
  const cap = run?.cap ?? settings?.cap ?? 0;

  const menu: MenuItemSpec[] = [
    { id: "copy", label: "Copy all as Markdown", disabled: !hasBlocks, onSelect: () => void copyText(docToMarkdown(doc), "Notes copied") },
    {
      id: "mode",
      label: settings?.update_mode === "manual" ? "Update automatically" : "Update only when I ask",
      onSelect: () => void store.getState().patchSettings({ update_mode: settings?.update_mode === "manual" ? "automatic" : "manual" }),
    },
    { id: "colors", label: "Colour people and places", checked: colors, onSelect: () => void store.getState().patchSettings({ colors: !colors }) },
    { id: "settings", label: "Model, detail and limit", separatorBefore: true, onSelect: () => setDialog(true) },
    { id: "stop", label: "Stop notes for this meeting", danger: true, disabled: !enabled || run?.status === "finished", onSelect: () => void store.getState().stop() },
  ];

  return (
    <div className="rs-root" data-testid="notes-panel">
      <RunStatusHeader title="Live notes" word={word} note={note}>
        {enabled && (
          <button
            type="button"
            className="rs-tool rs-tool-solid"
            disabled={run?.status === "running" || capped || run?.status === "finished"}
            onClick={() => void store.getState().updateNow()}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Update now
            <Kbd>N</Kbd>
          </button>
        )}
        {hasBlocks && (
          <button type="button" className="rs-tool" aria-label="Copy all as Markdown" onClick={() => void copyText(docToMarkdown(doc), "Notes copied")}>
            <Copy className="h-3 w-3" aria-hidden />
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

      {capped && (
        <div className="rs-notice" role="group" aria-labelledby="ln-cap-title">
          <div id="ln-cap-title" className="rs-notice-title">Keep taking notes?</div>
          <p>
            The notes used {formatTokens(used)} tokens, the limit you set. Keep going adds {formatTokens(settings?.cap ?? cap)} more.
          </p>
          <div className="rs-notice-actions">
            <button type="button" className={cn(buttonClass.base, buttonClass.primary, "h-7")} onClick={() => void store.getState().keepGoing()}>
              Keep going
            </button>
            <button type="button" className={cn(buttonClass.base, buttonClass.quiet, "h-7")} onClick={() => void store.getState().stop()}>
              Stop
            </button>
          </div>
        </div>
      )}

      {failed && !capped && (
        <div className="rs-notice" role="alert">
          <div className="rs-notice-title">{run?.status === "error" ? "Notes stopped" : "Notes paused"}</div>
          <p>{run?.reason || "The model could not answer."}</p>
          <div className="rs-notice-actions">
            <button type="button" className="rs-tool rs-tool-solid" onClick={() => setDialog(true)}>Change model</button>
            <button type="button" className="rs-tool" onClick={() => void store.getState().start()}>Try again</button>
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
              <button type="button" className={cn(buttonClass.base, buttonClass.primary)} onClick={() => void store.getState().turnOn(scope)}>
                Turn on notes
              </button>
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
          <button type="button" className={cn(buttonClass.base, buttonClass.primary)} onClick={() => setDialog(false)}>
            Done
          </button>
        }
      >
        {settings && <NotesSettingsForm settings={settings} onChange={(p) => void store.getState().patchSettings(p)} />}
      </Dialog>
    </div>
  );
}
