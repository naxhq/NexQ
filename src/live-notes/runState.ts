// What a helper's run state means for the panel: the words, which buttons exist,
// and the plain facts the header shows. Pure, so both panels and the tests share it.
import type { NotCovered, NotetakerState, RunAction } from "../lib/types";
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

/** What became of the notes of a meeting that is over, in plain words. */
export function endedWords(run: { status?: RunStatusName; not_covered?: NotCovered | null } | null | undefined): string {
  switch (run?.status) {
    case "capped":
      return "Stopped at the limit";
    case "error":
      return "Stopped by an error";
    case "paused":
      return "Paused when the meeting ended";
    case "running":
      return "Updating the notes";
    default:
      return run?.not_covered ? "Stopped early" : "Finished";
  }
}

/** The model a run will use, said before it is turned on. */
export function modelLine(chosen: { provider: string | null; label: string }, automatic: { label: string } | null): string {
  if (chosen.provider) return `Uses ${chosen.label}`;
  return automatic ? `Automatic, uses ${automatic.label}` : "Automatic, choosing a model";
}
