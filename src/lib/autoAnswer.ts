// Auto-Answer on a provider's own turn detection (Cartesia, Deepgram Flux),
// and the rules for which automatic answer may be stopped:
// - an answer you asked for (a click or a shortcut) stops a running automatic one;
// - an automatic answer never stops yours;
// - an automatic answer to an incomplete question gives way to the
//   complete one.
// Stopped automatic answers aren't kept. Logs carry counts and timings only.

import { cancelGeneration } from "./ipc";
import { logToFile } from "./logger";
import { runUserAction } from "./userAction";
import type { TurnSignal } from "./types";
import { useQuestionStore, type AutoAnswerRef } from "../stores/questionStore";
import { useStreamStore } from "../stores/streamStore";

/** Longest wait for a stopped answer to let go before the next one starts. */
export const RELEASE_WAIT_MS = 2000;

/** What the backend says when another answer is already running. */
export const REFUSED = "Generation already in progress";

/** The same words, whatever the punctuation or case ("…first" and "…first?"). */
export function sameQuestion(a: string | null | undefined, b: string | null | undefined): boolean {
  const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return a != null && b != null && words(a) === words(b);
}

export type TurnStep =
  /** Answer `question` now; first stop the line's early answer when `replaces`. */
  | { kind: "answer"; question: string; early: boolean; replaces: boolean }
  /** The early answer was right: it stands. */
  | { kind: "confirm" }
  /** The early answer was a guess that didn't hold: stop it. */
  | { kind: "withdraw" }
  | { kind: "none" };

/**
 * What Auto-Answer does with a line from the other party that carries a turn
 * signal. `question` is the line's newest sentence when it looks like a
 * question, else null; `current` is the newest automatic answer.
 */
export function decideTurnStep(
  turn: TurnSignal,
  segmentId: string,
  question: string | null,
  current: AutoAnswerRef | null,
): TurnStep {
  // Only an early answer for this line can turn out to be premature.
  const early = current && current.early && current.segmentId === segmentId ? current : null;
  switch (turn) {
    case "eager_end":
      if (!question || sameQuestion(early?.question, question)) return { kind: "none" };
      return { kind: "answer", question, early: true, replaces: !!early };
    case "resumed":
      return early ? { kind: "withdraw" } : { kind: "none" };
    case "end":
      if (early) {
        if (sameQuestion(early.question, question)) return { kind: "confirm" };
        return question
          ? { kind: "answer", question, early: false, replaces: true }
          : { kind: "withdraw" };
      }
      if (!question) return { kind: "none" };
      // A repeated "done" for a question already answered.
      if (current?.segmentId === segmentId && sameQuestion(current.question, question)) return { kind: "none" };
      return { kind: "answer", question, early: false, replaces: false };
  }
}

/** Whether an answer (any) is being sent or streamed in this window. */
export function answerRunning(): boolean {
  const stream = useStreamStore.getState();
  return stream.isStreaming || stream.phase === "sending";
}

/**
 * Stops `ref` if it's still running, without keeping it. Resolves once it has
 * let go, at most RELEASE_WAIT_MS later, so the next answer isn't refused.
 */
export async function stopAutoAnswer(ref: AutoAnswerRef): Promise<void> {
  const stream = useStreamStore.getState();
  if (!stream.isRunning(ref.requestId)) return;
  stream.discardRequest(ref.requestId);
  await cancelGeneration(ref.requestId).catch(() => {});
  // Stopped while still sending: no end event will settle the progress.
  useStreamStore.getState().clearPending(ref.requestId);
  await Promise.race([ref.done, new Promise((resolve) => setTimeout(resolve, RELEASE_WAIT_MS))]);
}

/** Whether the newest automatic answer is still being sent or streamed. */
export function autoAnswerRunning(): boolean {
  const ref = useQuestionStore.getState().autoAnswer;
  return !!ref && useStreamStore.getState().isRunning(ref.requestId);
}

/** The same, for a component: an automatic answer doesn't lock your actions. */
export function useAutoAnswerRunning(): boolean {
  const requestId = useQuestionStore((s) => s.autoAnswer?.requestId);
  return useStreamStore((s) => requestId !== undefined && s.isRunning(requestId));
}

/** Before an answer you asked for: stop a running automatic one. */
export async function makeWayForYou(): Promise<void> {
  const store = useQuestionStore.getState();
  const ref = store.autoAnswer;
  if (!ref || !useStreamStore.getState().isRunning(ref.requestId)) return;
  store.setAutoAnswer(null);
  // Its answer is dropped, so the question goes back to a card to click.
  store.holdBack(ref.segmentId, ref.question);
  logAutoAnswer("stoppedForYou");
  await stopAutoAnswer(ref);
}

/**
 * An answer you asked for (a click or a shortcut). A running automatic answer
 * stops for it; an answer you asked for earlier doesn't, so this one is refused.
 * Settles with your answer, without holding up the Auto-Answer steps meanwhile.
 */
export function runYourAction(mode: string, question?: string): Promise<void> {
  let answer: Promise<void> = Promise.resolve();
  return inTurn(async () => {
    if (autoAnswerRunning()) await makeWayForYou();
    answer = runUserAction(mode, question);
  }).then(() => answer);
}

// Decisions run one at a time, so one never starts while another's stop is
// still letting go. With nothing queued, a step runs at once.
let queued: Promise<unknown> | null = null;

/** Runs `task` once the previous Auto-Answer step has finished (now, if none is running). */
export function inTurn<T>(task: () => T | Promise<T>): Promise<T> {
  let result: Promise<T>;
  if (queued) {
    result = queued.then(task, task);
  } else {
    try {
      result = Promise.resolve(task());
    } catch (err) {
      result = Promise.reject(err);
    }
  }
  const settled = result.then(() => {}, () => {});
  queued = settled;
  void settled.then(() => {
    if (queued === settled) queued = null;
  });
  return result;
}

const counts = { early: 0, kept: 0, withdrawn: 0, answered: 0, held: 0, stoppedForYou: 0 };
type AutoAnswerEvent = keyof typeof counts;

/** One log line per event, with running totals; never any transcript text. */
export function logAutoAnswer(event: AutoAnswerEvent, detail?: string): void {
  counts[event] += 1;
  const totals = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ");
  logToFile("info", "auto-answer", `${event}${detail ? ` (${detail})` : ""}; totals: ${totals}`);
}
