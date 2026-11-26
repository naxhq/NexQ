// "Jump to that moment": scroll the live transcript to the line spoken at a note's time.
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import type { TranscriptSegment } from "../lib/types";

/** Asks the meeting window to show a panel (the dock listens when it supports this). */
export const REVEAL_PANEL_EVENT = "nexq:reveal-panel";

/** The line spoken at or just before `ms` (meeting time), else the first one after it. */
export function segmentAt(segments: TranscriptSegment[], ms: number, startedAt: number | null): TranscriptSegment | null {
  let before: TranscriptSegment | null = null;
  let after: TranscriptSegment | null = null;
  for (const s of segments) {
    const at = startedAt ? Math.max(0, s.timestamp_ms - startedAt) : s.timestamp_ms;
    if (at <= ms) before = s;
    else if (!after) after = s;
  }
  return before ?? after;
}

export function jumpToTranscript(ms: number): boolean {
  window.dispatchEvent(new CustomEvent(REVEAL_PANEL_EVENT, { detail: { panel: "transcript" } }));
  const seg = segmentAt(useTranscriptStore.getState().segments, ms, useMeetingStore.getState().meetingStartTime);
  if (!seg) return false;
  // The panel may have just been revealed; look on the next frame.
  const go = () => {
    const el = document.querySelector(`[data-segment-id="${CSS.escape(seg.id)}"]`);
    if (!el) return false;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
    el.classList.add("ring-1", "ring-primary/40");
    setTimeout(() => el.classList.remove("ring-1", "ring-primary/40"), 1500);
    return true;
  };
  if (go()) return true;
  requestAnimationFrame(() => void go());
  return true;
}
