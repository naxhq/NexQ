/**
 * The prompter's engine: one note, one scroll region.
 *
 * It owns the three parts from `follow/` (follower, said-it tracker, scroll
 * controller), measures the rendered note for the controller, runs the frame loop
 * (only while something moves), feeds the user's own speech in from the transcript
 * store, and reports what the view needs: the state of each block, how many are
 * left to say, the follow state and whether a manual scroll is being respected.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranscriptStore } from "../../stores/transcriptStore";
import type { ReadingSettings } from "../../stores/talkingPointsStore";
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
import { measureLines, rangeUpTo } from "./measure";
import { marksToSaid, VoiceBridge, type FollowAvailability } from "./voice";
import type { PointSaid } from "../../lib/types";

export const FOCUS_RATIO = 0.33;
/** A suggestion must hold this long before it is shown, and goes after this long. */
export const SUGGEST_AFTER_MS = 1000;
export const SUGGEST_EXPIRE_MS = 12_000;
/** An automatic move longer than this many words (or to a block that is not next door) can be undone. */
export const BIG_MOVE_WORDS = 25;
export const BACK_CHIP_MS = 8000;

/** What the prompter needs from a follower (the real one, or a fake in tests). */
export interface FollowerLike {
  onInterim(text: string, segId: string): unknown;
  onFinal(text: string, segId: string): unknown;
  snapshot(): { position: number; confidence: number; state: FollowState; suggestion?: { blockId: string; confidence: number } | null };
  seek(token: number): void;
  reset(): void;
  setIndex(index: NoteIndex): void;
}

export interface GoToSuggestion {
  blockId: string;
  /** First words of that block. */
  text: string;
  /** Where it is relative to the reading line: the chip sits at that edge. */
  edge: "top" | "bottom";
}

export interface PrompterOptions {
  doc: TpDoc | null;
  /** Changes when the note changes (resets position and "said it"). */
  noteKey: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  progressRef?: RefObject<HTMLElement | null>;
  reading: ReadingSettings;
  availability: FollowAvailability;
  /** Saved "said it" state to start from. */
  savedSaid?: readonly PointSaid[] | null;
  /** Called when the said-it state changed (the store saves it). */
  onSaidChange?: (said: PointSaid[]) => void;
  reducedMotion?: boolean;
  clock?: () => number;
  /** Offer "Go to" when you stray to another point (reading setting `suggest`). */
  suggest?: boolean;
  /** Replaces the real follower (tests). */
  follower?: FollowerLike;
}

export interface PrompterState {
  index: NoteIndex;
  states: ReadonlyMap<string, BlockState>;
  currentBlockId: string | null;
  leftToSay: number;
  totalBlocks: number;
  followState: FollowState | "off";
  /** A manual scroll is being respected right now. */
  yielding: boolean;
  playing: boolean;
  toggleSaid: (blockId: string) => void;
  play: () => void;
  pause: () => void;
  resume: () => void;
  onScroll: () => void;
  /** Mark a user action that scrolls (wheel, keys, pointer on the scrollbar). */
  noteUserIntent: () => void;
  /** Token the speaker has reached (follower), for tests and the progress line. */
  followPosition: number;
  /** Scroll to the start. */
  restart: () => void;
  /** A quiet offer to jump to the point you seem to be on. */
  suggestion: GoToSuggestion | null;
  goToSuggestion: () => void;
  dismissSuggestion: () => void;
  /** After a big automatic move: return to where you were (the follower holds there). */
  canGoBack: boolean;
  goBack: () => void;
}

function stateOf(
  i: number,
  id: string,
  cur: number,
  saidIt: boolean,
  said: (id: string) => boolean,
  auto: (id: string) => boolean,
): BlockState {
  if (saidIt && said(id)) return auto(id) ? "autosaid" : "said";
  if (i === cur) return "current";
  return i < cur ? "past" : "ahead";
}

export function usePrompter(opts: PrompterOptions): PrompterState {
  const { doc, noteKey, scrollRef, contentRef, progressRef, reading, availability } = opts;
  const clock = opts.clock ?? (() => Date.now());
  const reduced = opts.reducedMotion ?? false;

  const blocks = useMemo(() => (doc ? docBlocks(doc) : []), [doc]);
  const index = useMemo(() => buildNoteIndex(blocks.map((b) => ({ id: b.id, text: b.text }))), [blocks]);

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
  const rawSuggest = useRef<{ blockId: string; since: number } | null>(null);
  const dismissed = useRef<string | null>(null);
  const [suggestBlock, setSuggestBlock] = useState<string | null>(null);
  const lastPos = useRef<number | null>(null);
  const backTo = useRef<number | null>(null);
  const backTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const lastMarksKey = useRef("");
  const modeRef = useRef<"off" | "wpm" | "voice" | null>(null);
  const lastSet = useRef(-1);
  const intentAt = useRef(0);
  const voiceTarget = useRef(0);
  const yieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const curBlockRef = useRef(0);
  const indexRef = useRef(index);
  indexRef.current = index;

  const voiceOk = availability.ok;
  const wantVoice = reading.mode === "voice" && voiceOk;
  const wantSaid = reading.saidIt && voiceOk;

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

  // -- measuring ---------------------------------------------------------------------------

  const measureRaf = useRef(0);
  const scheduleMeasure = useCallback(() => {
    if (measureRaf.current) return;
    measureRaf.current = requestAnimationFrame(() => {
      measureRaf.current = 0;
      const el = scrollRef.current;
      const content = contentRef.current;
      if (!el || !content) return;
      content.style.paddingBottom = `${Math.round(el.clientHeight * (1 - FOCUS_RATIO))}px`;
      try {
        const lines = measureLines(content, indexRef.current);
        ctrl.current.setMetrics({ lines, contentHeight: el.scrollHeight, viewportHeight: el.clientHeight });
      } catch {
        /* a measuring failure leaves manual scrolling working */
      }
    });
  }, [scrollRef, contentRef]);

  useEffect(() => {
    scheduleMeasure();
  }, [index, reading.fontSize, reading.lineSpacing, scheduleMeasure]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => scheduleMeasure());
    ro.observe(el);
    if (content) ro.observe(content);
    void (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(scheduleMeasure);
    return () => {
      ro.disconnect();
      if (measureRaf.current) cancelAnimationFrame(measureRaf.current);
      measureRaf.current = 0;
    };
  }, [scrollRef, contentRef, scheduleMeasure]);

  // -- the user's voice --------------------------------------------------------------------

  const publishVoiceState = useCallback(() => {
    const f = follower.current!;
    const snap = f.snapshot();
    setFollowState((prev) => (prev === snap.state ? prev : snap.state));
    setFollowPosition(snap.position);
    if (snap.state === "following") {
      const prev = lastPos.current;
      if (prev !== null) {
        const far = Math.abs(snap.position - prev) > BIG_MOVE_WORDS;
        const ix = indexRef.current;
        const blockAt = (t: number) => (ix.tokens.length ? ix.tokens[Math.max(0, Math.min(ix.tokens.length - 1, Math.floor(t)))].block : 0);
        const skipped = Math.abs(blockAt(snap.position) - blockAt(prev)) > 1;
        if (far || skipped) {
          backTo.current = prev;
          setCanGoBack(true);
          if (backTimer.current) clearTimeout(backTimer.current);
          backTimer.current = setTimeout(() => {
            backTo.current = null;
            setCanGoBack(false);
          }, BACK_CHIP_MS);
        }
      }
      lastPos.current = snap.position;
    }
    said.current!.setPlace(snap.position);
    const sg = snap.state === "unsure" ? snap.suggestion : null;
    if (!sg || !optsRef.current.suggest) {
      rawSuggest.current = null;
      dismissed.current = null;
      setSuggestBlock(null);
    } else if (rawSuggest.current?.blockId !== sg.blockId) {
      rawSuggest.current = { blockId: sg.blockId, since: clock() };
      setSuggestBlock(null);
    }
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
    const tick = wantVoice ? setInterval(publishVoiceState, 700) : null;
    return () => {
      unsub();
      if (tick) clearInterval(tick);
    };
  }, [wantVoice, wantSaid, publishVoiceState, noteKey]);

  // a suggestion shows once it has held for a second, and goes after twelve
  useEffect(() => () => {
    if (backTimer.current) clearTimeout(backTimer.current);
  }, []);

  useEffect(() => {
    if (!wantVoice) return;
    const t = setInterval(() => {
      const r = rawSuggest.current;
      if (!r || dismissed.current === r.blockId) return setSuggestBlock((b) => (b === null ? b : null));
      const age = clock() - r.since;
      const show = age >= SUGGEST_AFTER_MS && age < SUGGEST_EXPIRE_MS;
      setSuggestBlock((b) => (show ? (b === r.blockId ? b : r.blockId) : b === null ? b : null));
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantVoice]);

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
    let raf = 0;
    let stopped = false;
    const frame = () => {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      const el = scrollRef.current;
      if (!el) return;
      const c = ctrl.current;
      const want = effRef.current;
      if (modeRef.current !== want) {
        modeRef.current = want;
        c.setMode(want);
        if (want === "wpm") c.setWpmPosition(c.tokenAtScroll(el.scrollTop));
      }
      if (want === "off") return;
      const top = c.update();
      if (!c.isYielding() && Math.abs(el.scrollTop - top) >= 0.5) {
        el.scrollTop = top;
        lastSet.current = el.scrollTop;
      }
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
  }, [scrollRef, progressRef, updateCurrent]);

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
      lastPos.current = token;
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

  const goToSuggestion = useCallback(() => {
    const id = rawSuggest.current?.blockId;
    const bi = indexRef.current.blocks.findIndex((b) => b.id === id);
    if (bi < 0) return;
    const tok = indexRef.current.blocks[bi].first;
    follower.current!.seek(tok);
    lastPos.current = tok;
    voiceTarget.current = tok;
    ctrl.current.setVoice(tok, "following");
    rawSuggest.current = null;
    setSuggestBlock(null);
    updateCurrent(tok);
    resume();
  }, [updateCurrent, resume]);
  const goBack = useCallback(() => {
    const tok = backTo.current;
    if (tok === null) return;
    follower.current!.seek(tok); // the follower holds here until it hears you again
    lastPos.current = tok;
    voiceTarget.current = tok;
    ctrl.current.setVoice(tok, "following");
    backTo.current = null;
    if (backTimer.current) clearTimeout(backTimer.current);
    setCanGoBack(false);
    updateCurrent(tok);
    resume();
  }, [updateCurrent, resume]);
  const dismissSuggestion = useCallback(() => {
    dismissed.current = rawSuggest.current?.blockId ?? null;
    setSuggestBlock(null);
  }, []);

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
    blocks.forEach((b, i) => m.set(b.id, stateOf(i, b.id, curBlock, reading.saidIt, (id) => s.isSaid(id), (id) => s.marks()[id] === "auto")));
    return m;
    // `rev` is the said tracker's change counter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, curBlock, reading.saidIt, rev]);

  // the part of the current block already spoken, dimmed through the CSS highlight API where it exists
  useEffect(() => {
    const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!css?.highlights || !HighlightCtor) return;
    const content = contentRef.current;
    const block = blocks[curBlock];
    if (!content || !block || !wantVoice || followState !== "following") {
      css.highlights.delete("tp-spoken");
      return;
    }
    const span = index.blocks[curBlock];
    const el = content.querySelector(`[data-block-id="${block.id}"]`);
    const tok = Math.floor(followPosition);
    if (!el || !span || tok <= span.first || tok > span.end) {
      css.highlights.delete("tp-spoken");
      return;
    }
    const endChar = index.tokens[Math.min(tok, span.end) - 1]?.end ?? 0;
    const r = rangeUpTo(el, endChar);
    if (r) css.highlights.set("tp-spoken", new HighlightCtor(r));
    else css.highlights.delete("tp-spoken");
    return () => {
      css.highlights?.delete("tp-spoken");
    };
  }, [blocks, curBlock, followPosition, followState, wantVoice, index, contentRef]);

  const suggestion = useMemo<GoToSuggestion | null>(() => {
    if (!suggestBlock || !wantVoice || followState !== "unsure") return null;
    const i = blocks.findIndex((b) => b.id === suggestBlock);
    if (i < 0) return null;
    const text = blocks[i].text.trim().split(/\s+/).slice(0, 6).join(" ") || "next point";
    return { blockId: suggestBlock, text, edge: i < curBlock ? "top" : "bottom" };
  }, [suggestBlock, wantVoice, followState, blocks, curBlock]);

  const leftToSay = useMemo(() => (said.current ? said.current.leftToSay() : 0), [rev, blocks, index]);

  return {
    index,
    states,
    currentBlockId: blocks[curBlock]?.id ?? null,
    leftToSay,
    totalBlocks: index.blocks.filter((b) => b.end > b.first).length,
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
    suggestion,
    goToSuggestion,
    dismissSuggestion,
    canGoBack,
    goBack,
  };
}
