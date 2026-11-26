/**
 * The two quiet offers the prompter can make about where you are:
 * "Go to: <point>" when you stray to another point (the follower holds still and suggests),
 * and "Back to where I was" after a big automatic move. Both are chips with their own timing;
 * this hook owns that timing and the jump itself, the prompter owns the scrolling.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { FollowState, NoteIndex, ScrollController } from "../follow";
import type { DocBlock } from "../doc/model";
import {
  BACK_CHIP_MS,
  BIG_MOVE_WORDS,
  SUGGEST_AFTER_MS,
  SUGGEST_EXPIRE_MS,
  type FollowerLike,
  type GoToSuggestion,
} from "./prompterTypes";

type Snap = ReturnType<FollowerLike["snapshot"]>;

export interface JumpEnv {
  follower: MutableRefObject<FollowerLike | null>;
  ctrl: MutableRefObject<ScrollController>;
  indexRef: MutableRefObject<NoteIndex>;
  /** Where the scroll controller should aim when voice following. */
  voiceTarget: MutableRefObject<number>;
  /** Filled in by the prompter once it has them (they are defined after this hook is called). */
  late: MutableRefObject<{ resume: () => void; updateCurrent: (token: number) => void } | null>;
  blocks: DocBlock[];
  curBlock: number;
  wantVoice: boolean;
  followState: FollowState | "off";
  suggestEnabled: boolean;
  /** The panel is on screen; a hidden one does no polling. */
  shown?: boolean;
  clock: () => number;
}

export function useJumpOffers(env: JumpEnv) {
  const { blocks, curBlock, wantVoice, followState, clock } = env;
  const enabledRef = useRef(env.suggestEnabled);
  enabledRef.current = env.suggestEnabled;

  const rawSuggest = useRef<{ blockId: string; since: number } | null>(null);
  const dismissed = useRef<string | null>(null);
  const [suggestBlock, setSuggestBlock] = useState<string | null>(null);
  const lastPos = useRef<number | null>(null);
  const backTo = useRef<number | null>(null);
  const backTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);

  /** Called with every follower snapshot. */
  const observe = useCallback((snap: Snap) => {
    if (snap.state === "following") {
      const prev = lastPos.current;
      if (prev !== null) {
        const far = Math.abs(snap.position - prev) > BIG_MOVE_WORDS;
        const ix = env.indexRef.current;
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
    // unsure, lost or paused: a long off-script line makes the follower "lost" and silence makes it "paused",
    // and the offer is just as useful then; only a sure follower has no need of one
    const sg = snap.state !== "following" ? snap.suggestion : null;
    if (!sg || !enabledRef.current) {
      rawSuggest.current = null;
      dismissed.current = null;
      setSuggestBlock(null);
    } else if (rawSuggest.current?.blockId !== sg.blockId) {
      rawSuggest.current = { blockId: sg.blockId, since: env.clock() };
      setSuggestBlock(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A move the user made (scroll, jump): not an automatic one, so no "back" offer for it. */
  const markPosition = useCallback((token: number) => {
    lastPos.current = token;
  }, []);

  useEffect(
    () => () => {
      if (backTimer.current) clearTimeout(backTimer.current);
    },
    [],
  );

  // a suggestion shows once it has held for a second, and goes after twelve
  useEffect(() => {
    if (!wantVoice || env.shown === false) return;
    const t = setInterval(() => {
      const r = rawSuggest.current;
      if (!r || dismissed.current === r.blockId) return setSuggestBlock((b) => (b === null ? b : null));
      const age = clock() - r.since;
      const show = age >= SUGGEST_AFTER_MS && age < SUGGEST_EXPIRE_MS;
      setSuggestBlock((b) => (show ? (b === r.blockId ? b : r.blockId) : b === null ? b : null));
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantVoice, env.shown]);

  const jumpTo = useCallback(
    (tok: number) => {
      env.follower.current!.seek(tok); // the follower holds here until it hears you again
      lastPos.current = tok;
      env.voiceTarget.current = tok;
      env.ctrl.current.setVoice(tok, "following");
      env.late.current?.updateCurrent(tok);
      env.late.current?.resume();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const goToSuggestion = useCallback(() => {
    const id = rawSuggest.current?.blockId;
    const bi = env.indexRef.current.blocks.findIndex((b) => b.id === id);
    if (bi < 0) return;
    rawSuggest.current = null;
    setSuggestBlock(null);
    jumpTo(env.indexRef.current.blocks[bi].first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  const goBack = useCallback(() => {
    const tok = backTo.current;
    if (tok === null) return;
    backTo.current = null;
    if (backTimer.current) clearTimeout(backTimer.current);
    setCanGoBack(false);
    jumpTo(tok);
  }, [jumpTo]);

  const dismissSuggestion = useCallback(() => {
    dismissed.current = rawSuggest.current?.blockId ?? null;
    if (dismissed.current) env.follower.current?.dismissSuggestion?.(dismissed.current); // it does not come back
    setSuggestBlock(null);
  }, []);

  const suggestion = useMemo<GoToSuggestion | null>(() => {
    if (!suggestBlock || !wantVoice || followState === "following" || followState === "off") return null;
    const i = blocks.findIndex((b) => b.id === suggestBlock);
    if (i < 0) return null;
    const text = blocks[i].text.trim().split(/\s+/).slice(0, 6).join(" ") || "next point";
    return { blockId: suggestBlock, text, edge: i < curBlock ? "top" : "bottom" };
  }, [suggestBlock, wantVoice, followState, blocks, curBlock]);

  return { observe, markPosition, suggestion, goToSuggestion, dismissSuggestion, canGoBack, goBack };
}
