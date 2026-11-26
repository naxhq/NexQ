/** Types, timings and the pure block-state rule of the prompter engine. */
import type { RefObject } from "react";
import type { ReadingSettings } from "../../stores/talkingPointsStore";
import type { FollowState, NoteIndex } from "../follow";
import type { TpDoc } from "../doc/model";
import type { BlockState } from "../reader/DocView";
import type { FollowAvailability } from "./voice";
import type { PointSaid } from "../../lib/types";
import type { SpokenEnd, SpokenRanges } from "./spoken";

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
  /** The user waved an offer away: the follower stops offering that point. */
  dismissSuggestion?(blockId: string): void;
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
  /** The spoken part of the current block (null when not following): what the highlight and the strike draw. */
  spoken: SpokenEnd | null;
  /** The words spoken in every block so far (a record, kept after you move on): what the "Checked off" strike draws. */
  spokenRanges: SpokenRanges;
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

export function stateOf(
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
