import type { TranscriptSegment } from "../../lib/types";
import { meetingBase, relMs } from "../../lib/time";

/** Stamps at or above this are clock times (epoch ms); below it they already are ms since the meeting started. */
export const EPOCH_FLOOR_MS = 100_000_000_000;
const isEpoch = (ts: number) => ts >= EPOCH_FLOOR_MS;

/**
 * Milliseconds since the meeting started, the way the backend counts them (`rel_ms`): a stamp that already is
 * relative stays as it is, a clock time loses the meeting's start (or, with no usable start, the earliest
 * clock time in the transcript), and a stamp before the start is 0. Converted once, never twice.
 */
export function relativeMs(ts: number, base: number | null): number {
  if (ts <= 0) return 0;
  if (!isEpoch(ts)) return ts;
  return base === null ? 0 : Math.max(0, ts - base);
}

/**
 * Which line of a transcript was being spoken at `atMs` (ms since the start, as citations carry it): the
 * nearest one that started at or before it (0 ms included: the first line), so a moment between two
 * lines lands on the earlier one. Null for an empty transcript.
 */
export function rawIndexAtMs(segments: TranscriptSegment[], meetingStartMs: number, atMs: number): number | null {
  if (segments.length === 0) return null;
  const clocks = segments.map((s) => s.timestamp_ms).filter(isEpoch);
  const base = isEpoch(meetingStartMs) ? meetingStartMs : clocks.length ? Math.min(...clocks) : null;
  const rel = (s: TranscriptSegment) => relativeMs(s.timestamp_ms, base);
  let best = -1;
  let bestAt = -1;
  segments.forEach((s, i) => {
    const t = rel(s);
    if (t <= atMs && t >= bestAt) {
      best = i;
      bestAt = t;
    }
  });
  if (best >= 0) return best;
  // Before the first line: the earliest one.
  let first = 0;
  segments.forEach((s, i) => {
    if (rel(s) < rel(segments[first])) first = i;
  });
  return first;
}

/** Finds the row of a merged index once the virtual list has drawn it, focuses it and marks it for a moment. */
export function focusAndMarkRow(root: ParentNode, mergedIndex: number, onDone?: () => void): () => void {
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clear: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    const el = root.querySelector<HTMLElement>(`[data-testid="transcript-row"][data-index="${mergedIndex}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      el.classList.add("ring-2", "ring-primary");
      clear = setTimeout(() => el.classList.remove("ring-2", "ring-primary"), 2200);
      onDone?.();
      return;
    }
    if (++tries < 30) timer = setTimeout(attempt, 40);
  };
  attempt();
  return () => {
    if (timer) clearTimeout(timer);
    if (clear) clearTimeout(clear);
  };
}
