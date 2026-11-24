// The one-time "star NexQ on GitHub" card. This file holds the decisions and
// constants; useStarPrompt wires them to the app and StarPrompt draws the card.
import type { MeetingSummary } from "./types";

/** Finished meetings before the card is offered. */
export const FINISHED_MEETINGS_NEEDED = 5;

/** The newest finished meeting must have ended this recently (the card follows a meeting, not an app start). */
export const RECENT_END_WINDOW_MS = 2 * 60_000;

/** Wait after a meeting-ended event: both windows send one, and the save has to settle. */
export const TRIGGER_DELAY_MS = 2_500;

/** The card must be on screen this long before it counts as shown. */
export const SHOWN_AFTER_MS = 2_000;

/** How long "Thanks" stays before the card closes. */
export const THANKS_CLOSE_MS = 4_000;

/** How many meetings to read; five finished ones are always within the newest 50. */
export const MEETINGS_TO_READ = 50;

/** Key in nexq-settings.json. Absent in older saved configs, which means "not shown yet". */
export const STAR_PROMPT_SHOWN_KEY = "starPromptShown";

/** A meeting that ended and has a transcript (an empty one doesn't count). */
export function isFinishedMeeting(m: Pick<MeetingSummary, "end_time" | "segment_count">): boolean {
  return !!m.end_time && m.segment_count > 0;
}

/**
 * Milliseconds since the epoch for an end_time. Rust writes RFC 3339 in UTC
 * with up to nine fractional digits ("...:05.123456789+00:00"); a value
 * without an offset is read as UTC too. NaN when it can't be read.
 */
export function parseEndTime(value: string): number {
  let text = value.trim();
  text = text.replace(/(\.\d{3})\d+/, "$1");
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += "Z";
  return Date.parse(text);
}

/** When the newest finished meeting ended, or null when there is none. */
export function newestFinishedEndMs(meetings: MeetingSummary[]): number | null {
  let newest: number | null = null;
  for (const m of meetings) {
    if (!isFinishedMeeting(m)) continue;
    const ms = parseEndTime(m.end_time as string);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}

export interface StarPromptCheck {
  /** Saved as shown in an earlier run (and not waiting for another chance this session). */
  alreadyShown: boolean;
  meetings: MeetingSummary[];
  nowMs: number;
  demoActive: boolean;
  hasActiveMeeting: boolean;
  meetingStarting: boolean;
}

/**
 * Has the user just finished their fifth (or later) meeting? Says nothing
 * about whether the card can be on screen right now (see starPromptBlocked).
 */
export function shouldOfferStarPrompt(c: StarPromptCheck): boolean {
  if (c.alreadyShown) return false;
  if (c.demoActive || c.hasActiveMeeting || c.meetingStarting) return false;

  const finished = c.meetings.filter((m) => isFinishedMeeting(m) && !Number.isNaN(parseEndTime(m.end_time as string)));
  if (finished.length < FINISHED_MEETINGS_NEEDED) return false;

  const newest = newestFinishedEndMs(finished);
  if (newest === null) return false;
  const age = c.nowMs - newest;
  // A little slack either side of "now" for clocks that differ by a moment.
  return age >= -60_000 && age <= RECENT_END_WINDOW_MS;
}

export interface StarPromptBlockers {
  /** The wizard has not finished. */
  wizard: boolean;
  /** Anything other than the launcher dashboard (settings). */
  notOnLauncher: boolean;
  updateDialogOpen: boolean;
  updateToastShowing: boolean;
  /** NexQ is about to restart into an update. */
  installing: boolean;
}

/**
 * True while something else has the screen. These pass, and the waiting card
 * then appears. (A meeting or demo is different: it drops the card, see useStarPrompt.)
 */
export function starPromptWaiting(b: StarPromptBlockers): boolean {
  return b.wizard || b.notOnLauncher || b.updateDialogOpen || b.updateToastShowing || b.installing;
}
