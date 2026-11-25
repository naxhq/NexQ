import { useEffect, useState } from "react";
import { FileText, MoreHorizontal, Pause, Play, RefreshCw } from "lucide-react";
import { Dialog, Menu, type MenuItemSpec, Button } from "../ui";
import { cn } from "../lib/utils";
import type { BriefFact } from "../lib/types";
import { openBriefSource } from "./openSource";
import { useMeetingStore } from "../stores/meetingStore";
import { sheetTimeMs, useLiveBriefStore } from "../stores/liveBriefStore";
import { formatTokens } from "../live-notes/NotesSettingsForm";
import { NoteText } from "../live-notes/NoteBlockRow";
import { Age } from "./Age";
import { can, inFlight, modelLine } from "../live-notes/runState";
import { describeModel } from "../models/ModelField";
import { useAutomaticModel } from "../models/useAutomaticModel";
import { Countdown, RunStatusHeader } from "../live-notes/RunStatusHeader";
import { runWords, type RunStatusName } from "../live-notes/runState";
import { BriefSettingsForm } from "./BriefSettingsForm";
import "../live-notes/liveNotes.css";

/** A sheet older than this is no longer handed to live answers (spec 6b). */
export const ANSWER_FRESH_MS = 4 * 60_000;

export function briefStatusWords(status: string | undefined, enabled: boolean): string {
  return runWords("brief", status as RunStatusName | undefined, enabled).word;
}

function SourceChip({ fact }: { fact: BriefFact }) {
  const src = fact.sources?.[0];
  const inner = (
    <>
      <FileText className="mr-1 h-3 w-3 shrink-0" aria-hidden />
      <span>{src?.title ?? fact.source}</span>
    </>
  );
  if (!src) return <span className="lb-chip">{inner}</span>;
  return (
    <button type="button" className="lb-chip" onClick={() => void openBriefSource(src)} aria-label={`Open source: ${src.title}`}>
      {inner}
    </button>
  );
}

/** The brief panel of the meeting window. Takes no props. */
export function BriefPanel() {
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id ?? "");
  const workspaceId = useMeetingStore((s) => s.activeMeeting?.workspace_id ?? undefined);
  const store = useLiveBriefStore;
  const sheet = store((s) => s.sheet);
  const hidden = store((s) => s.hidden);
  const run = store((s) => s.run);
  const settings = store((s) => s.settings);
  const error = store((s) => s.error);
  const notice = store((s) => s.notice);
  const workspaceEnabled = store((st) => st.workspaceEnabled);
  const deadline = store((st) => st.deadline);
  const automatic = useAutomaticModel(store((st) => st.settings?.provider ?? null)).model;
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    if (!meetingId) return;
    let off: (() => void) | null = null;
    let gone = false;
    void store
      .getState()
      .attach(meetingId, workspaceId ?? null)
      .then((u) => {
        if (gone) u();
        else off = u;
      });
    return () => {
      gone = true;
      off?.();
    };
  }, [meetingId, workspaceId, store]);

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

  if (!meetingId) {
    return <div className="rs-root"><p className="rs-empty text-muted-foreground">The brief appears here once a meeting has started.</p></div>;
  }

  const enabled = workspaceEnabled ?? false;
  const busy = inFlight(run);
  const paused = run?.status === "paused" || can(run, "resume");
  const capped = run?.status === "capped" || (can(run, "keep_going") && run?.status !== "off");
  const failed = !capped && (run?.status === "error" || (run?.status === "paused" && !!run.reason));
  const waiting = run?.status === "waiting" || run?.status === "on";
  const at = sheet ? sheetTimeMs(sheet) : 0;
  const stale = sheet ? Date.now() - at > ANSWER_FRESH_MS : false;

  const menu: MenuItemSpec[] = [
    ...(enabled && can(run, "pause") ? [{ id: "pause", label: "Pause the brief", onSelect: () => void store.getState().pause() }] : []),
    { id: "settings", label: "Model and limit", onSelect: () => setDialog(true) },
    { id: "off", label: "Turn the brief off", danger: true, separatorBefore: true, disabled: !enabled, onSelect: () => void store.getState().turnOff() },
  ];

  return (
    <div className="rs-root" data-testid="brief-panel">
      <RunStatusHeader title="Brief" word={briefStatusWords(run?.status, enabled)} note={deadline && waiting && !paused ? <Countdown deadline={deadline} /> : undefined}>
        {enabled && (can(run, "update") || busy) && (
          <button type="button" className="rs-tool rs-tool-solid" disabled={busy} onClick={() => void store.getState().refresh()}>
            <RefreshCw className="h-3 w-3" aria-hidden />
            Refresh
          </button>
        )}
        {enabled && can(run, "resume") && (
          <button type="button" className="rs-tool rs-tool-solid" aria-label="Resume the brief" onClick={() => void store.getState().resume()}>
            <Play className="h-3 w-3" aria-hidden />
            Resume
          </button>
        )}
        {enabled && can(run, "start") && (
          <button type="button" className="rs-tool rs-tool-solid" onClick={() => void store.getState().start()}>
            <Play className="h-3 w-3" aria-hidden />
            <span aria-hidden>Start again</span>
            <span className="rs-sr">Start the brief again</span>
          </button>
        )}
        <Menu
          items={menu}
          label="Brief options"
          align="end"
          renderTrigger={(props) => (
            <button {...props} type="button" className="rs-tool h-[1.625rem] w-[1.625rem] justify-center px-0" aria-label="Brief options">
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        />
      </RunStatusHeader>

      {capped && (
        <div className="rs-notice" role="group" aria-labelledby="lb-cap-title">
          <div id="lb-cap-title" className="rs-notice-title">Keep the brief going?</div>
          <p>It used {formatTokens(run?.tokens_used ?? 0)} tokens, the limit you set. Keep going adds {formatTokens(settings?.cap || run?.cap || 0)} more.</p>
          <div className="rs-notice-actions">
            {can(run, "keep_going") && <Button variant="primary" size="sm" onClick={() => void store.getState().keepGoing()}>Keep going</Button>}
            <Button size="sm"  onClick={() => void store.getState().pause()}>Stop</Button>
          </div>
        </div>
      )}
      {failed && !capped && (
        <div className="rs-notice" role="alert">
          <div className="rs-notice-title">{run?.status === "error" ? "The brief stopped" : "The brief paused"}</div>
          <p>{run?.reason || "The model could not answer."}</p>
          <div className="rs-notice-actions">
            <button type="button" className="rs-tool rs-tool-solid" onClick={() => setDialog(true)}>Change model</button>
            {can(run, "try_again") && <button type="button" className="rs-tool" onClick={() => void store.getState().tryAgain()}>Try again</button>}
          </div>
        </div>
      )}
      {notice && (
        <div className="rs-notice" role="status">
          <div className="rs-notice-title">Not refreshed</div>
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

      <div className="rs-scroll" role="region" aria-label="Brief">
        {!enabled ? (
          <div className="rs-empty">
            <h3>Brief</h3>
            <p>While you talk, NexQ looks through this workspace for what is known about the topic and keeps a short sheet. Live answers use it. It sends the transcript and the matching passages to your chosen model.</p>
            <p data-testid="brief-model-line">{modelLine({ provider: settings?.provider ?? null, label: describeModel({ provider: settings?.provider ?? null, model: settings?.model ?? null, effort: null }) }, automatic)}</p>
            <Button variant="primary"  onClick={() => void store.getState().turnOn()} className="mt-3">
              Turn on the brief
            </Button>
          </div>
        ) : !sheet ? (
          <div className="rs-empty" role="status">
            <h3>{hidden ? "Finding what’s known about the new topic" : "Listening for the topic"}</h3>
            <p>{hidden ? "The old sheet is hidden so answers do not use it." : "The first sheet appears after a minute or so of conversation."}</p>
          </div>
        ) : (
          <>
            <div className="lb-now">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <h3 className="lb-now-text">{sheet.now}</h3>
                <Age at={at} />
              </div>
            </div>
            {sheet.facts.length === 0 ? (
              <p className="lb-uses">Nothing in the workspace matches this topic.</p>
            ) : (
              <ul className="lb-facts" aria-label="Facts about this topic">
                {sheet.facts.slice(0, 6).map((f, i) => (
                  <li key={`${f.passage_id ?? "x"}-${i}`} className="lb-fact">
                    <div className="lb-fact-text"><NoteText text={f.text} /></div>
                    <SourceChip fact={f} />
                  </li>
                ))}
              </ul>
            )}
            {sheet.earlier.length > 0 && (
              <details className="lb-earlier">
                <summary>Earlier points ({sheet.earlier.length})</summary>
                <ul>
                  {sheet.earlier.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="lb-uses">{stale ? "Too old for answers. Refresh to use it again." : "Answers use this brief while it is fresh."}</p>
          </>
        )}
      </div>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Brief settings"
        footer={<Button variant="primary"  onClick={() => setDialog(false)}>Done</Button>}
      >
        {settings && <BriefSettingsForm settings={settings} onChange={(p) => void store.getState().patchSettings(p)} />}
      </Dialog>
    </div>
  );
}
