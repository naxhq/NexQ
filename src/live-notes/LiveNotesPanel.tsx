import { useEffect, useMemo, useState } from "react";
import { Copy, MoreHorizontal, RefreshCw, Undo2 } from "lucide-react";
import { Dialog, Kbd, Menu, Segmented, buttonClass, type MenuItemSpec } from "../ui";
import { cn } from "../lib/utils";
import type { NotetakerSettings, NotetakerState } from "../lib/types";
import { onNotesUpdateRequested } from "../lib/events";
import { useMeetingStore } from "../stores/meetingStore";
import { useLiveNotesStore } from "../stores/liveNotesStore";
import { NotePage } from "./NotePage";
import { NotesSettingsForm, formatTokens } from "./NotesSettingsForm";
import { jumpToTranscript } from "./jump";
import { docToMarkdown } from "./page";
import { copyText } from "./clipboard";

/** The run's state in plain words. */
export function statusWords(run: NotetakerState | null, settings: NotetakerSettings | null): { word: string; note?: string } {
  if (!settings?.enabled) return { word: "Notes are off" };
  const manual = settings.update_mode === "manual";
  switch (run?.status) {
    case "running":
      return { word: "Taking notes" };
    case "paused":
    case "capped":
      return { word: "Paused" };
    case "error":
    case "finished":
    case "off":
      return { word: "Stopped" };
    case "idle":
    default:
      return manual ? { word: "Waiting for you", note: "Press Update now" } : { word: "Waiting for speech" };
  }
}

/** The live notes panel of the meeting window. Takes no props. */
export function NotesPanel() {
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id ?? "");
  const store = useLiveNotesStore;
  const doc = store((s) => s.doc);
  const run = store((s) => s.run);
  const settings = store((s) => s.settings);
  const fresh = store((s) => s.fresh);
  const arrivals = store((s) => s.arrivals);
  const undoStack = store((s) => s.undoStack);
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

  // The N key (raised by the meeting window's shortcuts) asks for an update.
  useEffect(
    () =>
      onNotesUpdateRequested(() => {
        const s = store.getState();
        if (s.settings?.enabled && s.run?.status !== "running" && s.run?.status !== "capped") void s.updateNow();
      }),
    [store],
  );

  const actions = useMemo(() => {
    const s = store.getState();
    return {
      setText: (id: string, text: string) => void s.setText(id, text),
      setType: (id: string, type: Parameters<typeof s.setType>[1]) => void s.setType(id, type),
      togglePin: (id: string) => void s.togglePin(id),
      addLine: (...a: Parameters<typeof s.addLine>) => void s.addLine(...a),
      deleteLine: (id: string) => void s.deleteLine(id),
      undo: () => void s.undo(),
    };
  }, [store]);

  if (!meetingId) {
    return <div className="ln-root"><p className="ln-empty text-muted-foreground">Notes appear here once a meeting has started.</p></div>;
  }

  const { word, note } = statusWords(run, settings);
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
    <div className="ln-root" data-testid="notes-panel">
      <header className="ln-head">
        <h2 className="ln-status" aria-live="polite">
          {word}
          {note && <span className="ln-status-note">{`, ${note.toLowerCase()}`}</span>}
        </h2>
        {enabled && (
          <button
            type="button"
            className="ln-tool ln-tool-solid"
            disabled={run?.status === "running" || capped || run?.status === "finished"}
            onClick={() => void store.getState().updateNow()}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Update now
            <Kbd>N</Kbd>
          </button>
        )}
        {hasBlocks && (
          <button type="button" className="ln-tool" aria-label="Copy all as Markdown" onClick={() => void copyText(docToMarkdown(doc), "Notes copied")}>
            <Copy className="h-3 w-3" aria-hidden />
          </button>
        )}
        <Menu
          items={menu}
          label="Notes options"
          align="end"
          renderTrigger={(props) => (
            <button {...props} type="button" className="ln-tool h-[1.625rem] w-[1.625rem] justify-center px-0" aria-label="Notes options">
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        />
      </header>

      {capped && (
        <div className="ln-notice" role="group" aria-labelledby="ln-cap-title">
          <div id="ln-cap-title" className="ln-notice-title">Keep taking notes?</div>
          <p>
            The notes used {formatTokens(used)} tokens, the limit you set. Keep going adds {formatTokens(settings?.cap ?? cap)} more.
          </p>
          <div className="ln-notice-actions">
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
        <div className="ln-notice" role="alert">
          <div className="ln-notice-title">{run?.status === "error" ? "Notes stopped" : "Notes paused"}</div>
          <p>{run?.reason || "The model could not answer."}</p>
          <div className="ln-notice-actions">
            <button type="button" className="ln-tool ln-tool-solid" onClick={() => setDialog(true)}>Change model</button>
            <button type="button" className="ln-tool" onClick={() => void store.getState().start()}>Try again</button>
          </div>
        </div>
      )}

      {error && (
        <div className="ln-notice" role="alert">
          <div className="ln-notice-title">That did not work</div>
          <p>{error}</p>
          <div className="ln-notice-actions">
            <button type="button" className="ln-tool" onClick={() => store.getState().clearError()}>Dismiss</button>
          </div>
        </div>
      )}

      {!enabled && settings && !hasBlocks ? (
        <div className="ln-empty">
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
        <div className="ln-empty">
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
        <footer className="ln-foot">
          {enabled && cap > 0 && (
            <>
              <span>{formatTokens(used)} of {formatTokens(cap)} tokens</span>
              <div
                className="ln-meter"
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
            <button type="button" className="ln-tool ml-auto" onClick={() => void store.getState().undo()}>
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
