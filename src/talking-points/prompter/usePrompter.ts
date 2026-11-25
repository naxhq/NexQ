/**
 * The prompter's engine: one note, one scroll region.
 *
 * It owns the three parts from `follow/` (follower, said-it tracker, scroll
 * controller), measures the rendered note for the controller, runs the frame loop
 * (only while something moves), feeds the user's own speech in from the transcript
 * store, and reports what the view needs: the state of each block, how many are
 * left to say, the follow state and whether a manual scroll is being respected.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranscriptStore } from "../../stores/transcriptStore";
import {
  SaidTracker,
  ScrollController,
  VoiceFollower,
  buildNoteIndex,
  type FollowState,
  type NoteIndex,
  type SaidMark,
} from "../follow";
import { docBlocks, type TpDoc } from "../doc/model";
import type { BlockState } from "../reader/DocView";
import { useShown } from "../../overlay/useShown";
import { useJumpOffers } from "./useJumpOffers";
import { useNoteMeasure } from "./useNoteMeasure";
import { useSpokenHighlight } from "./useSpokenHighlight";
import {
  FOCUS_RATIO,
  stateOf,
  type FollowerLike,
  type PrompterOptions,
  type PrompterState,
} from "./prompterTypes";
import { marksToSaid, VoiceBridge } from "./voice";

export * from "./prompterTypes";

export function usePrompter(opts: PrompterOptions): PrompterState {
  const { doc, noteKey, scrollRef, contentRef, progressRef, reading, availability } = opts;
  const clock = opts.clock ?? (() => Date.now());
  const reduced = opts.reducedMotion ?? false;

  const blocks = useMemo(() => (doc ? docBlocks(doc) : []), [doc]);
  const index = useMemo(() => buildNoteIndex(blocks.map((b) => ({ id: b.id, text: b.text }))), [blocks]);

  const indexRef = useRef(index);
  indexRef.current = index;

  const mkCtrl = useCallback(
    () => new ScrollController({ clock, focusRatio: FOCUS_RATIO, reducedMotion: reduced, wpm: reading.wpm }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reduced],
  );

  const follower = useRef<FollowerLike | null>(null);
  const said = useRef<SaidTracker | null>(null);
  const ctrl = useRef<ScrollController>(null as unknown as ScrollController);
  if (!ctrl.current) ctrl.current = mkCtrl();
  if (!follower.current) follower.current = opts.follower ?? new VoiceFollower(index, { clock });
  if (!said.current) said.current = new SaidTracker(index, { clock });
  const bridge = useRef<VoiceBridge>(new VoiceBridge([]));

  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((n) => (n + 1) | 0), []);
  const [followState, setFollowState] = useState<FollowState | "off">("off");
  const [yielding, setYielding] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [curBlock, setCurBlock] = useState(0);
  const [followPosition, setFollowPosition] = useState(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const lastMarksKey = useRef("");
  const modeRef = useRef<"off" | "wpm" | "voice" | null>(null);
  const lastSet = useRef(-1);
  const intentAt = useRef(0);
  const voiceTarget = useRef(0);
  const yieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const curBlockRef = useRef(0);

  const voiceOk = availability.ok;
  const wantVoice = reading.mode === "voice" && voiceOk;
  const wantSaid = reading.saidIt && voiceOk;

  // A hidden panel or background tab does no work: no frame loop, no polling.
  const shown = useShown(scrollRef);

  // the "Go to" and "Back to where I was" offers; they need resume and updateCurrent, defined further down
  const late = useRef<{ resume: () => void; updateCurrent: (token: number) => void } | null>(null);
  const jump = useJumpOffers({
    follower,
    ctrl,
    indexRef,
    voiceTarget,
    late,
    blocks,
    curBlock,
    wantVoice,
    followState,
    suggestEnabled: !!opts.suggest,
    shown,
    clock,
  });
  const jumpRef = useRef(jump);
  jumpRef.current = jump;

  // -- note changes: new index, reset position, load saved "said it" ------------------------

  const savedKey = useMemo(() => JSON.stringify(opts.savedSaid ?? []), [opts.savedSaid]);
  useEffect(() => {
    follower.current!.setIndex(index);
    said.current!.setIndex(index);
    ctrl.current.setMetrics({ lines: [], contentHeight: 0, viewportHeight: 0 });
    scheduleMeasure();
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const lastNote = useRef<string | null>(null);
  useEffect(() => {
    const newNote = lastNote.current !== noteKey;
    lastNote.current = noteKey;
    if (newNote) {
      follower.current!.reset();
      said.current!.reset();
      bridge.current.reset();
      bridge.current.prime(useTranscriptStore.getState().segments);
      ctrl.current = mkCtrl();
      ctrl.current.setWpm(reading.wpm);
      modeRef.current = null;
      voiceTarget.current = 0;
      setPlaying(false);
      setYielding(false);
      setCurBlock(0);
      curBlockRef.current = 0;
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = 0;
        lastSet.current = el.scrollTop;
      }
      scheduleMeasure();
    }
    // saved marks (also when they arrive after the note opened)
    const marks: Record<string, SaidMark> = {};
    for (const s of optsRef.current.savedSaid ?? []) {
      marks[s.block_id] = s.by === "voice" ? (s.ticked ? "auto" : "manual_off") : s.ticked ? "manual_on" : "manual_off";
    }
    said.current!.load(marks);
    lastMarksKey.current = JSON.stringify(said.current!.marks());
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteKey, savedKey]);

  useEffect(() => {
    ctrl.current.setWpm(reading.wpm);
  }, [reading.wpm]);

  const scheduleMeasure = useNoteMeasure({
    scrollRef,
    contentRef,
    ctrl,
    indexRef,
    layoutKey: [index, reading.fontSize, reading.lineSpacing],
  });

  // -- the user's voice --------------------------------------------------------------------

  const publishVoiceState = useCallback(() => {
    const f = follower.current!;
    const snap = f.snapshot();
    setFollowState((prev) => (prev === snap.state ? prev : snap.state));
    setFollowPosition(snap.position);
    jumpRef.current.observe(snap);
    said.current!.setPlace(snap.position);
    ctrl.current.setVoice(snap.position, snap.state);
    if (snap.state === "following") voiceTarget.current = snap.position;
    const marks = said.current!.marks();
    const key = JSON.stringify(marks);
    if (key !== lastMarksKey.current) {
      lastMarksKey.current = key;
      bump();
      optsRef.current.onSaidChange?.(marksToSaid(marks));
    }
  }, [bump]);

  useEffect(() => {
    const sinks = [];
    if (wantVoice) sinks.push(follower.current!);
    if (wantSaid) sinks.push(said.current!);
    bridge.current.setSinks(sinks);
    bridge.current.prime(useTranscriptStore.getState().segments);
    if (sinks.length === 0) {
      setFollowState("off");
      return;
    }
    if (wantVoice) setFollowState(follower.current!.snapshot().state);
    const unsub = useTranscriptStore.subscribe((s) => {
      if (bridge.current.push(s.segments) > 0) publishVoiceState();
    });
    // "paused" is the absence of speech: nothing arrives, so look again now and then
    const tick = wantVoice && shown ? setInterval(publishVoiceState, 700) : null;
    return () => {
      unsub();
      if (tick) clearInterval(tick);
    };
  }, [wantVoice, wantSaid, publishVoiceState, noteKey, shown]);

  // -- scroll mode and the frame loop ---------------------------------------------------------

  const effMode: "off" | "wpm" | "voice" = reading.mode === "auto" ? "wpm" : wantVoice ? "voice" : "off";
  const effRef = useRef(effMode);
  effRef.current = effMode;

  const syncYield = useCallback(() => {
    const c = ctrl.current;
    setYielding(c.isYielding());
    if (yieldTimer.current) clearTimeout(yieldTimer.current);
    if (c.isYielding()) {
      yieldTimer.current = setTimeout(() => setYielding(ctrl.current.isYielding()), c.yieldRemainingMs() + 30);
    }
  }, []);

  const tokenToBlock = useCallback((token: number): number => {
    const ix = indexRef.current;
    if (ix.tokens.length === 0) return 0;
    const t = ix.tokens[Math.max(0, Math.min(ix.tokens.length - 1, Math.floor(token)))];
    return t.block;
  }, []);

  const updateCurrent = useCallback(
    (token: number) => {
      const b = tokenToBlock(token);
      if (b !== curBlockRef.current) {
        curBlockRef.current = b;
        setCurBlock(b);
      }
    },
    [tokenToBlock],
  );

  useEffect(() => {
    // The mode is kept in step even when no frames run (a stopped loop must still switch the controller off).
    const syncMode = (el: HTMLElement | null) => {
      const want = effRef.current;
      if (modeRef.current === want) return;
      modeRef.current = want;
      ctrl.current.setMode(want);
      if (want === "wpm" && el) ctrl.current.setWpmPosition(ctrl.current.tokenAtScroll(el.scrollTop));
    };
    // Frames only run while something moves the note (auto or voice mode) AND the panel is on screen.
    if (effMode === "off" || !shown) {
      syncMode(scrollRef.current);
      return;
    }
    let raf = 0;
    let stopped = false;
    const frame = () => {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      const el = scrollRef.current;
      if (!el) return;
      const c = ctrl.current;
      syncMode(el);
      const top = c.update();
      if (!c.isYielding() && Math.abs(el.scrollTop - top) >= 0.5) {
        el.scrollTop = top;
        lastSet.current = el.scrollTop;
      }
      const want = effRef.current;
      if (want === "wpm" || (want === "voice" && followStateRef.current !== "following")) {
        updateCurrent(c.tokenAtScroll(el.scrollTop));
      }
      if (progressRef?.current) {
        const max = Math.max(1, el.scrollHeight - el.clientHeight);
        progressRef.current.style.transform = `scaleX(${Math.max(0, Math.min(1, el.scrollTop / max)).toFixed(4)})`;
      }
      if (c.isYielding() !== yieldRef.current) {
        yieldRef.current = c.isYielding();
        setYielding(yieldRef.current);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [scrollRef, progressRef, updateCurrent, effMode, shown]);

  const followStateRef = useRef<FollowState | "off">("off");
  followStateRef.current = followState;
  const yieldRef = useRef(false);

  // The voice position drives "current" while the follower is sure
  useEffect(() => {
    if (wantVoice && followState === "following") updateCurrent(followPosition);
  }, [wantVoice, followState, followPosition, updateCurrent]);

  // -- manual scroll -------------------------------------------------------------------------------

  const noteUserIntent = useCallback(() => {
    intentAt.current = performance.now();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ours = effRef.current !== "off" && Math.abs(el.scrollTop - lastSet.current) < 2 && performance.now() - intentAt.current > 250;
    const token = ctrl.current.tokenAtScroll(el.scrollTop);
    if (ours) {
      return;
    }
    const c = ctrl.current;
    c.onUserScroll(el.scrollTop);
    lastSet.current = el.scrollTop;
    if (effRef.current !== "off") {
      follower.current!.seek(token);
      jumpRef.current.markPosition(token);
      voiceTarget.current = token;
      c.setVoice(token, "following");
      yieldRef.current = true;
      syncYield();
    }
    updateCurrent(token);
  }, [scrollRef, syncYield, updateCurrent]);

  const resume = useCallback(() => {
    const el = scrollRef.current;
    const old = ctrl.current;
    const fresh = mkCtrl();
    fresh.setMetrics({ lines: [], contentHeight: 0, viewportHeight: 0 });
    fresh.setWpm(old.getWpm());
    modeRef.current = null;
    if (el) fresh.setWpmPosition(old.tokenAtScroll(el.scrollTop));
    fresh.setVoice(voiceTarget.current, "following");
    if (playingRef.current) fresh.play();
    ctrl.current = fresh;
    scheduleMeasure();
    yieldRef.current = false;
    setYielding(false);
  }, [mkCtrl, scrollRef, scheduleMeasure]);

  late.current = { resume, updateCurrent };

  const playingRef = useRef(false);
  playingRef.current = playing;

  const play = useCallback(() => {
    const el = scrollRef.current;
    if (el) ctrl.current.setWpmPosition(ctrl.current.tokenAtScroll(el.scrollTop));
    ctrl.current.play();
    setPlaying(true);
  }, [scrollRef]);
  const pause = useCallback(() => {
    ctrl.current.pause();
    setPlaying(false);
  }, []);

  // leaving auto-scroll stops playing
  useEffect(() => {
    if (reading.mode !== "auto" && playingRef.current) {
      ctrl.current.pause();
      setPlaying(false);
    }
  }, [reading.mode]);

  const restart = useCallback(() => {
    const el = scrollRef.current;
    follower.current!.seek(0);
    ctrl.current.setWpmPosition(0);
    voiceTarget.current = 0;
    ctrl.current.setVoice(0, "following");
    if (el) {
      el.scrollTop = 0;
      lastSet.current = el.scrollTop;
    }
    updateCurrent(0);
  }, [scrollRef, updateCurrent]);

  const toggleSaid = useCallback(
    (blockId: string) => {
      said.current!.toggle(blockId);
      const marks = said.current!.marks();
      lastMarksKey.current = JSON.stringify(marks);
      bump();
      optsRef.current.onSaidChange?.(marksToSaid(marks));
    },
    [bump],
  );

  // -- derived view state ------------------------------------------------------------------------

  const states = useMemo(() => {
    const m = new Map<string, BlockState>();
    const s = said.current!;
    blocks.forEach((b, i) =>
      m.set(b.id, stateOf(i, b.id, curBlock, reading.saidIt && b.kind !== "heading", (id) => s.isSaid(id), (id) => s.marks()[id] === "auto")),
    );
    return m;
    // `rev` is the said tracker's change counter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, curBlock, reading.saidIt, rev]);

  useSpokenHighlight({ blocks, index, curBlock, followPosition, followState, wantVoice, contentRef });

  // headings are structure, not things to say: they never count and are never ticked
  const leftToSay = useMemo(() => {
    const s = said.current;
    if (!s) return 0;
    return index.blocks.reduce((n, b, i) => (blocks[i]?.kind !== "heading" && b.end > b.first && !s.isSaid(b.id) ? n + 1 : n), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, blocks, index]);

  return {
    index,
    states,
    currentBlockId: blocks[curBlock]?.id ?? null,
    leftToSay,
    totalBlocks: index.blocks.filter((b, i) => b.end > b.first && blocks[i]?.kind !== "heading").length,
    followState: wantVoice ? followState : "off",
    yielding,
    playing,
    toggleSaid,
    play,
    pause,
    resume,
    onScroll,
    noteUserIntent,
    followPosition,
    restart,
    suggestion: jump.suggestion,
    goToSuggestion: jump.goToSuggestion,
    dismissSuggestion: jump.dismissSuggestion,
    canGoBack: jump.canGoBack,
    goBack: jump.goBack,
  };
}
