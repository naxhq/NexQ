import type { TranscriptSegment } from "../../lib/types";

/**
 * Which line of a transcript was being spoken at `atMs` of the meeting: the
 * nearest one that started at or before it (0 ms included: the first line),
 * so a moment between two lines lands on the earlier one. Null for an empty
 * transcript. Times are as saved: absolute, so the meeting's start is taken off.
 */
export function rawIndexAtMs(segments: TranscriptSegment[], meetingStartMs: number, atMs: number): number | null {
  if (segments.length === 0) return null;
  const rel = (s: TranscriptSegment) => (meetingStartMs ? Math.max(0, s.timestamp_ms - meetingStartMs) : s.timestamp_ms);
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
