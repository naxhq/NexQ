// What a helper's run state means for the panel: the words, which buttons exist,
// and the plain facts the header shows. Pure, so both panels and the tests share it.
import type { EndedKind, NotCovered, NotetakerState, RunAction, RunEnded } from "../lib/types";
import { formatClock } from "./page";

export type RunKind = "notes" | "brief";
export type RunStatusName = NotetakerState["status"];

export interface RunLike {
  status?: RunStatusName;
  can?: RunAction[];
}

/** What the backend says may be done now. No state yet means nothing yet. */
export function can(run: RunLike | null | undefined, action: RunAction): boolean {
  return !!run?.can?.includes(action);
}

/** A model call is going: the only time a button is disabled for the run's sake. */
export const inFlight = (run: RunLike | null | undefined): boolean => run?.status === "running";

/** One set of words for what a helper is doing. */
export function runWords(kind: RunKind, status: RunStatusName | undefined, enabled: boolean, opts: { manual?: boolean } = {}): { word: string; note?: string } {
  if (!enabled) return { word: "Off" };
  switch (status) {
    case "running":
      return { word: kind === "notes" ? "Taking notes" : "Checking the workspace" };
    case "paused":
    case "capped":
      return { word: "Paused" };
    case "error":
    case "finished":
    case "off":
      return { word: "Stopped" };
    case "on":
      return opts.manual ? { word: "Waiting for you", note: "press Update now" } : { word: "On" };
    default:
      return opts.manual ? { word: "Waiting for you", note: "press Update now" } : { word: "Waiting for speech" };
  }
}

/** "next update in 12 s", from a deadline; one string per second. */
export function countdownText(deadline: number, now: number): string {
  const s = Math.max(0, Math.ceil((deadline - now) / 1000));
  if (s === 0) return "updating soon";
  return s < 90 ? `next update in ${s} s` : `next update in ${Math.ceil(s / 60)} min`;
}

/** "Not covered: 2:00 to 40:00", from the backend's range. */
export function notCoveredText(nc: NotCovered | null | undefined): string | null {
  return nc ? `Not covered: ${formatClock(nc.from_ms)} to ${formatClock(nc.to_ms)}` : null;
}

const ENDED_HEADING: Record<EndedKind, string> = {
  covered: "Finished",
  limit: "Stopped at the limit",
  error: "Stopped by an error",
  plan_limit: "Stopped by a usage limit",
  paused: "Paused",
  manual: "Not updated automatically",
  out_of_time: "Stopped early",
  stopped: "Stopped",
  interrupted: "Interrupted",
  other_meeting: "Stopped for another meeting",
  nothing_to_note: "Nothing to note",
};
const ENDED_SENTENCE: Record<EndedKind, string> = {
  covered: "The notes cover the whole call.",
  limit: "The notes stopped at the limit you set.",
  error: "The notes stopped because of an error.",
  plan_limit: "The notes stopped because your plan's usage limit was reached.",
  paused: "The notes were paused when the meeting ended.",
  manual: "The notes were on manual, so they were not updated by themselves.",
  out_of_time: "The last update ran out of time.",
  stopped: "You stopped the notes.",
  interrupted: "NexQ was closed before the notes were finished.",
  other_meeting: "The notes stopped because another meeting started.",
  // The backend's detail says it ("The notes read the whole call and found nothing to write down").
  nothing_to_note: "The notes read the whole call.",
};

/** One plain sentence for why the notes of a finished meeting ended as they did. */
export function endedSentence(ended: RunEnded | null | undefined): string | null {
  if (!ended) return null;
  if (ended.kind === "nothing_to_note") return ended.detail ? `${ended.detail}.` : "The notes read the whole call and found nothing to write down.";
  const base = ENDED_SENTENCE[ended.kind];
  return ended.detail ? `${base} ${ended.detail}` : base;
}

/** What became of the notes of a meeting that is over, in plain words. */
export function endedWords(run: { status?: RunStatusName; not_covered?: NotCovered | null; ended?: RunEnded | null } | null | undefined): string {
  if (run?.ended) return ENDED_HEADING[run.ended.kind];
  switch (run?.status) {
    case "capped":
      return "Stopped at the limit";
    case "error":
      return "Stopped by an error";
    case "paused":
      return "Paused when the meeting ended";
    case "running":
    case "on":
    case "waiting":
      // Between passes the notes are still being worked on: a live word, never "Finished".
      return runWords("notes", run.status, true).word;
    default:
      return run?.not_covered ? "Stopped early" : "Finished";
  }
}

/** The model a run will use, said before it is turned on. */
export function modelLine(chosen: { provider: string | null; label: string }, automatic: { label: string } | null): string {
  if (chosen.provider) return `Uses ${chosen.label}`;
  return automatic ? `Automatic, uses ${automatic.label}` : "Automatic, choosing a model";
}
