/**
 * Talking points in the meeting window: a quiet teleprompter. The note is set as
 * fine typography; what you are saying is at full contrast on a thin marker in the
 * upper third, what is ahead sits a little back, what you have said settles.
 * It reads the note with our own renderer (the editor loads only when you edit).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Pencil, Play, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useMeetingStore } from "../../stores/meetingStore";
import { useConfigStore } from "../../stores/configStore";
import { useTalkingPointsStore } from "../../stores/talkingPointsStore";
import { getMeetingScope, listWorkspaces } from "../../lib/ipc";
import { DocView } from "../../talking-points/reader/DocView";
import { parseDoc, type TpDoc } from "../../talking-points/doc/model";
import { usePrompter, FOCUS_RATIO } from "../../talking-points/prompter/usePrompter";
import { followAvailability } from "../../talking-points/prompter/voice";
import { languageNote as langNote, resolveLanguage } from "../../talking-points/prompter/language";
import { Switcher, type SwitcherNote } from "../../talking-points/prompter/Switcher";
import { ReadingSettingsPopover } from "../../talking-points/prompter/ReadingSettingsPopover";
import { PromptEditor } from "../../talking-points/prompter/PromptEditor";
import { EmptyState, Segmented, Tooltip, Kbd, buttonClass } from "../../ui";
import { cn } from "../../lib/utils";
import "../../talking-points/talkingPoints.css";

const FOLLOW_TEXT: Record<string, string> = {
  following: "Following you",
  unsure: "Listening",
  lost: "Lost your place. Scroll to show me.",
  paused: "Waiting for you",
};

function useReducedMotion(): boolean {
  const [r, setR] = useState(() => (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) || false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setR(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return r;
}

export function PointsPanel() {
  const meeting = useMeetingStore((s) => s.activeMeeting);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const mutedYou = useConfigStore((s) => s.mutedYou);
  const youEngine = useConfigStore((s) => s.meetingAudioConfig?.you?.stt_provider);
  const youLanguage = useConfigStore((s) => s.meetingAudioConfig?.you?.language);
  const meetingId = meeting?.id ?? "";
  const home = meeting?.workspace_id ?? "general";

  const store = useTalkingPointsStore;
  const byWorkspace = store((s) => s.byWorkspace);
  const loadError = store((s) => s.loadError);
  const reading = store((s) => s.reading);
  const recent = store((s) => s.recent[home]);
  const lastNote = store((s) => s.lastNote[home]);
  const meetingEdits = store((s) => s.meetingEdits);
  const progress = store((s) => s.progress);
  const saveState = store((s) => s.saveState);

  const [scopeIds, setScopeIds] = useState<string[]>([home]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [settings, setSettings] = useState(false);
  const [editing, setEditing] = useState(false);
  const reduced = useReducedMotion();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLSpanElement | null>(null);
  const titleBtn = useRef<HTMLButtonElement | null>(null);
  const savedTop = useRef(0);

  // Which workspaces' notes this meeting may use: its own plus any it borrows.
  useEffect(() => {
    let live = true;
    setScopeIds((prev) => (prev.length === 1 && prev[0] === home ? prev : [home]));
    if (!meetingId) return;
    // a call that throws at once (no backend yet) must not take the panel down
    Promise.resolve()
      .then(() => getMeetingScope(meetingId))
      .then((sc) => {
        if (!live) return;
        const next = Array.from(new Set([home, ...sc.effective]));
        setScopeIds((prev) => (prev.join("|") === next.join("|") ? prev : next));
      })
      .catch(() => undefined);
    Promise.resolve()
      .then(() => listWorkspaces())
      .then((all) => live && setNames(Object.fromEntries(all.map((w) => [w.id, w.name]))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [meetingId, home]);

  useEffect(() => {
    for (const id of scopeIds) void store.getState().load(id);
  }, [scopeIds, store]);

  useEffect(() => {
    store.getState().resetMeeting();
    return () => {
      void store.getState().flushProgress();
    };
  }, [meetingId, store]);

  const notes = useMemo(
    () => scopeIds.flatMap((id) => (byWorkspace[id] ?? []).map((p) => ({ p, own: id === home }))),
    [scopeIds, byWorkspace, home],
  );

  // the note on screen: the one chosen, else the last one used in this workspace, else the first
  useEffect(() => {
    if (selectedId && notes.some((n) => n.p.id === selectedId)) return;
    const pick = notes.find((n) => n.p.id === lastNote) ?? notes[0];
    setSelectedId(pick ? pick.p.id : null);
  }, [notes, selectedId, lastNote]);

  const note = notes.find((n) => n.p.id === selectedId)?.p ?? null;
  useEffect(() => {
    if (!note || !meetingId) return;
    void store.getState().loadMeetingState(meetingId, note.id);
  }, [note?.id, meetingId, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const meetingOnly = note ? meetingEdits[note.id] : undefined;
  const docJson = meetingOnly ?? note?.doc_json ?? "";
  const doc: TpDoc | null = useMemo(() => (note ? parseDoc(docJson) : null), [note, docJson]);

  const availability = followAvailability({
    audioMode,
    mutedYou,
    youEngine,
  });

  const honesty = langNote(resolveLanguage(youLanguage, note?.plain_text ?? ""));

  const p = usePrompter({
    doc,
    noteKey: note?.id ?? "",
    scrollRef,
    contentRef,
    progressRef,
    reading,
    availability,
    suggest: reading.suggest,
    savedSaid: note ? progress[note.id] : null,
    onSaidChange: (said) => note && meetingId && store.getState().setProgress(meetingId, note.id, said),
    reducedMotion: reduced,
  });

  const choose = useCallback(
    (id: string) => {
      setSelectedId(id);
      setSwitcher(false);
      setEditing(false);
      store.getState().rememberNote(home, id);
      titleBtn.current?.focus();
    },
    [home, store],
  );

  const switcherNotes: SwitcherNote[] = notes.map(({ p: n, own }) => ({
    id: n.id,
    title: n.title,
    text: n.plain_text,
    sort: n.sort,
    from: own ? undefined : names[n.workspace_id] ?? "Another workspace",
  }));

  const setMode = (mode: "manual" | "auto" | "voice") => store.getState().setReading({ mode });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const k = e.key;
    if (k === " " || k === "Spacebar") {
      // Space belongs to the reader while it has focus: it must not start an Assist
      e.stopPropagation();
      if (reading.mode === "auto") {
        e.preventDefault();
        if (p.playing) p.pause();
        else p.play();
      } else p.noteUserIntent();
    } else if (k === "Backspace" && p.canGoBack) {
      e.preventDefault();
      e.stopPropagation();
      p.goBack();
    } else if (k === "Enter" && p.suggestion) {
      e.preventDefault();
      e.stopPropagation();
      p.goToSuggestion();
    } else if (k === "Enter" && reading.saidIt && p.currentBlockId) {
      e.preventDefault();
      e.stopPropagation();
      p.toggleSaid(p.currentBlockId);
    } else if (k === "+" || k === "=") {
      e.preventDefault();
      e.stopPropagation();
      store.getState().setReading({ fontSize: Math.min(56, reading.fontSize + 2) });
    } else if (k === "-" || k === "_") {
      e.preventDefault();
      e.stopPropagation();
      store.getState().setReading({ fontSize: Math.max(14, reading.fontSize - 2) });
    } else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(k)) {
      p.noteUserIntent();
      e.stopPropagation();
    }
  };

  const startFirstNote = async () => {
    const created = await store.getState().create(home, { title: "Talking points" });
    if (!created) return;
    store.getState().rememberNote(home, created.id);
    setSelectedId(created.id);
    setEditing(true);
  };

  const startEditing = () => {
    savedTop.current = scrollRef.current?.scrollTop ?? 0;
    setSwitcher(false);
    setSettings(false);
    setEditing(true);
  };
  const stopEditing = () => {
    setEditing(false);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = savedTop.current;
    });
  };

  // -- empty and error states ------------------------------------------------------------------

  const loading = scopeIds.some((id) => !byWorkspace[id] && !loadError[id]);
  const err = scopeIds.map((id) => loadError[id]).find(Boolean);

  if (!note && !editing) {
    if (loading) return <div className="ui-body p-4 text-muted-foreground" role="status">Loading your notes</div>;
    if (err && notes.length === 0) {
      return (
        <EmptyState
          title="Your notes did not load"
          body={err}
          action={
            <button type="button" className={cn(buttonClass.base, buttonClass.primary)} onClick={() => scopeIds.forEach((id) => void store.getState().load(id))}>
              Try again
            </button>
          }
        />
      );
    }
    return (
      <div className="flex h-full items-center">
        <EmptyState
          title="Write your first talking points"
          body="Keep what you want to say in front of you. NexQ can follow your voice and tick off what you have covered."
          action={
            <button type="button" className={cn(buttonClass.base, buttonClass.primary)} onClick={() => void startFirstNote()}>
              Write a note
            </button>
          }
        />
      </div>
    );
  }

  const voiceNote = !availability.ok ? availability.message : null;
  const saidLabel =
    reading.saidIt && p.totalBlocks > 0 && availability.ok
      ? p.leftToSay === 0
        ? "All said"
        : `${p.leftToSay} left to say`
      : null;
  const state = note ? saveState[note.id] : undefined;

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="points-panel">
      <div className="relative shrink-0 px-1.5 pt-1.5">
        <div className="flex items-center gap-1">
          <button
            ref={titleBtn}
            type="button"
            aria-haspopup="listbox"
            aria-expanded={switcher}
            onClick={() => {
              setSettings(false);
              setSwitcher((v) => !v);
            }}
            className="ui-section min-w-0 flex-1 truncate rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {note?.title ?? "Untitled note"}
            {meetingOnly !== undefined && <span className="ui-meta ml-2 font-normal text-muted-foreground">edited for this meeting</span>}
          </button>
          <Tooltip content={<span className="inline-flex items-center gap-2">Edit this note</span>}>
            <button
              type="button"
              aria-label="Edit this note"
              onClick={startEditing}
              disabled={!note}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40"
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content="Reading settings">
            <button
              type="button"
              data-reading-trigger=""
              aria-label="Reading settings"
              aria-haspopup="dialog"
              aria-expanded={settings}
              onClick={() => {
                setSwitcher(false);
                setSettings((v) => !v);
              }}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        </div>
        {switcher && (
          <Switcher
            notes={switcherNotes}
            recent={recent ?? []}
            currentId={note?.id ?? null}
            onPick={choose}
            onClose={() => {
              setSwitcher(false);
              titleBtn.current?.focus();
            }}
          />
        )}
        {settings && (
          <ReadingSettingsPopover
            reading={reading}
            onChange={(patch) => store.getState().setReading(patch)}
            onClose={() => setSettings(false)}
            saidItNote={reading.saidIt ? voiceNote : null}
            languageNote={honesty}
          />
        )}
      </div>

      {!editing && (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 pb-1.5 pt-1">
            <Segmented
              label="How the note moves"
              value={reading.mode}
              onChange={setMode}
              options={[
                { value: "manual", label: "Manual" },
                { value: "auto", label: "Auto" },
                { value: "voice", label: "My voice", ariaLabel: availability.ok ? "Follow my voice" : `Follow my voice, unavailable. ${availability.message}` },
              ]}
            />
            {reading.mode === "auto" && (
              <Tooltip
                content={
                  <span className="inline-flex items-center gap-2">
                    {p.playing ? "Pause" : "Play"}
                    <Kbd>Space</Kbd>
                  </span>
                }
              >
                <button
                  type="button"
                  aria-label={p.playing ? "Pause auto-scroll" : "Start auto-scroll"}
                  onClick={() => (p.playing ? p.pause() : p.play())}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {p.playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                </button>
              </Tooltip>
            )}
            {reading.mode === "auto" && <span className="ui-meta text-muted-foreground tabular-nums">{reading.wpm} words a minute</span>}
            {saidLabel && (
              <span className="ui-meta ml-auto shrink-0 tabular-nums text-muted-foreground" aria-live="polite">
                {saidLabel}
              </span>
            )}
            {reading.mode === "voice" && availability.ok && p.followState !== "off" && (
              <span className="ui-meta text-muted-foreground" role="status">
                {FOLLOW_TEXT[p.followState]}
              </span>
            )}
          </div>
          {reading.mode === "voice" && availability.ok && honesty && (
            <p className="ui-meta shrink-0 px-3 pb-1.5 text-muted-foreground">{honesty}</p>
          )}
          {reading.mode === "voice" && !availability.ok && (
            <p className="ui-meta shrink-0 px-3 pb-1.5 text-muted-foreground" role="status">
              {availability.message}
            </p>
          )}
          <div className="tp-progress shrink-0" aria-hidden>
            <span ref={progressRef} style={{ transform: "scaleX(0)" }} />
          </div>
        </>
      )}

      {editing && note ? (
        <PromptEditor
          note={note}
          docJson={docJson}
          meetingId={meetingId}
          onDone={stopEditing}
        />
      ) : (
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            role="region"
            tabIndex={0}
            aria-label={`Talking points: ${note?.title ?? ""}`}
            aria-describedby="tp-reader-help"
            onKeyDown={onKeyDown}
            onScroll={p.onScroll}
            onWheel={p.noteUserIntent}
            onPointerDown={p.noteUserIntent}
            onTouchMove={p.noteUserIntent}
            className="h-full overflow-y-auto overscroll-contain rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            style={{ fontSize: reading.fontSize, lineHeight: reading.lineSpacing }}
          >
            <div ref={contentRef} className="pt-3">
              {doc && <DocView doc={doc} states={p.states} ticks={reading.saidIt} onToggleSaid={p.toggleSaid} />}
            </div>
          </div>
          <span id="tp-reader-help" className="sr-only">
            Enter ticks the current line, or goes to the suggested point. Backspace returns after a big jump. Plus and minus change the text size. Space plays or pauses auto-scroll.
          </span>
          <span aria-hidden className="tp-focus-mark" style={{ top: `calc(${FOCUS_RATIO * 100}% - 1px)` }} />
          <div aria-live="polite" className="sr-only">
            {p.suggestion ? `Go to: ${p.suggestion.text}` : ""}
          </div>
          {p.suggestion && (
            <button
              type="button"
              tabIndex={-1}
              onClick={p.goToSuggestion}
              className={cn(
                buttonClass.base,
                "tp-suggest max-w-[calc(100%-1.5rem)] border border-border bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm hover:bg-accent",
                p.suggestion.edge === "top" ? "tp-suggest-top" : "tp-suggest-bottom",
              )}
            >
              <span className="truncate">Go to: {p.suggestion.text}</span>
            </button>
          )}
          {p.canGoBack && (
            <button
              type="button"
              tabIndex={-1}
              onClick={p.goBack}
              className={cn(buttonClass.base, "tp-back border border-border bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm hover:bg-accent")}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Back to where I was
            </button>
          )}
          {p.yielding && reading.mode !== "manual" && (
            <button
              type="button"
              onClick={p.resume}
              className={cn(buttonClass.base, "tp-resume border border-border bg-popover/95 text-popover-foreground shadow-md backdrop-blur-sm hover:bg-accent")}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Resume
            </button>
          )}
        </div>
      )}
      {state === "failed" && !editing && (
        <p className="ui-meta shrink-0 border-t border-border px-3 py-1.5 text-destructive" role="alert">
          Your last change is not saved yet. It will keep trying.
        </p>
      )}
      {!editing && p.totalBlocks === 0 && <span className="sr-only">This note is empty</span>}
    </div>
  );
}

export default PointsPanel;
