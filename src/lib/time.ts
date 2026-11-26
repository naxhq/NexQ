/**
 * THE TIME CONTRACT. Everything the notes, brief, memory, search and chat store, send or show
 * is milliseconds SINCE THE MEETING STARTED. Speech providers stamp transcript segments with
 * wall-clock (epoch) ms or with ms since the start, depending on the provider; `relMs` turns
 * either into the contract. Mirrors `rel_ms` / `base_ms` in `src-tauri/src/live_common.rs`.
 */

/** Anything below this is already relative (11 days of meeting at most). */
export const EPOCH_FLOOR_MS = 100_000_000_000;

export const isEpochMs = (ts: number): boolean => Number.isFinite(ts) && ts >= EPOCH_FLOOR_MS;

/**
 * The epoch ms that counts as 0 for a meeting: its start when that is a usable time, else the
 * earliest epoch stamp among `stamps` (a meeting with no start time), else null.
 */
export function meetingBase(startMs: number | null | undefined, stamps: Iterable<number> = []): number | null {
  if (startMs != null && isEpochMs(startMs)) return startMs;
  let min: number | null = null;
  for (const t of stamps) if (isEpochMs(t) && (min === null || t < min)) min = t;
  return min;
}

/** Milliseconds since the meeting started. A stamp before the start, or an epoch stamp with no base, is 0. */
export function relMs(ts: number, base: number | null | undefined): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  if (!isEpochMs(ts)) return ts;
  return base != null && Number.isFinite(base) ? Math.max(0, ts - base) : 0;
}

/** `relMs` for a transcript's segments: the base comes from the meeting's start, or from the segments. */
export function segmentsRel(segments: { timestamp_ms: number }[], startMs: number | null | undefined): number[] {
  const base = meetingBase(startMs, segments.map((s) => s.timestamp_ms));
  return segments.map((s) => relMs(s.timestamp_ms, base));
}
