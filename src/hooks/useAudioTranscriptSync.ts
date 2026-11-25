// Syncs audio playback position to transcript segments.
// - Finds the active segment from the playback time (binary search, store subscription)
// - Updates activeSegmentId in the audio player store only when it changes
// - Auto-scrolls to the active segment (pauses on manual wheel scroll,
//   re-enables after 5 seconds of inactivity)

import { useEffect, useMemo, useRef } from "react";
import { useAudioPlayerStore } from "@/stores/audioPlayerStore";
import { findActiveSegmentIndex } from "@/lib/activeSegment";
import { segmentsRel } from "@/lib/time";
import type { TranscriptSegment } from "@/lib/types";

const MANUAL_SCROLL_COOLDOWN_MS = 5000;

export function useAudioTranscriptSync(
  segments: TranscriptSegment[],
  meetingStartMs: number,
  recordingOffsetMs: number,
  /** Scrolls the transcript to a raw segment id (e.g. via the virtualizer's scrollToIndex). */
  scrollToSegment?: (segmentId: string) => void
): void {
  // Granular selectors. currentTimeMs is deliberately NOT selected here: this
  // hook runs inside TranscriptView, so subscribing would re-render the whole
  // transcript on every time update. It is read via store.subscribe below.
  const isPlaying = useAudioPlayerStore((s) => s.isPlaying);
  const activeSegmentId = useAudioPlayerStore((s) => s.activeSegmentId);

  // Refs for manual scroll state — not Zustand state to avoid re-renders
  const autoScrollEnabledRef = useRef(true);
  // Latest scroll callback, so a new function identity never re-triggers a scroll.
  const scrollToSegmentRef = useRef(scrollToSegment);
  scrollToSegmentRef.current = scrollToSegment;
  const manualScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adjusted start time of each segment (ascending), for binary search.
  const startsMs = useMemo(
    () => segmentsRel(segments, meetingStartMs).map((t) => t - recordingOffsetMs),
    [segments, meetingStartMs, recordingOffsetMs]
  );

  // --- Active segment tracking (store subscription, no React re-render) ---
  useEffect(() => {
    if (!isPlaying || segments.length === 0) return;

    const update = () => {
      const { currentTimeMs, activeSegmentId: current, setActiveSegmentId } =
        useAudioPlayerStore.getState();
      const idx = findActiveSegmentIndex(startsMs, currentTimeMs);
      const id = idx >= 0 ? segments[idx].id : null;
      if (id !== current) setActiveSegmentId(id);
    };

    update();
    return useAudioPlayerStore.subscribe(update);
  }, [isPlaying, segments, startsMs]);

  // --- Auto-scroll when active segment changes ---
  useEffect(() => {
    if (!isPlaying) return;
    if (!activeSegmentId) return;
    if (!autoScrollEnabledRef.current) return;

    scrollToSegmentRef.current?.(activeSegmentId);
  }, [activeSegmentId, isPlaying]);

  // --- Manual scroll detection: pause auto-scroll, re-enable after cooldown ---
  useEffect(() => {
    function handleWheel() {
      autoScrollEnabledRef.current = false;

      if (manualScrollTimerRef.current) {
        clearTimeout(manualScrollTimerRef.current);
      }

      manualScrollTimerRef.current = setTimeout(() => {
        autoScrollEnabledRef.current = true;
        manualScrollTimerRef.current = null;
      }, MANUAL_SCROLL_COOLDOWN_MS);
    }

    window.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      window.removeEventListener("wheel", handleWheel);
      if (manualScrollTimerRef.current) {
        clearTimeout(manualScrollTimerRef.current);
      }
    };
  }, []);

  // --- Cleanup timer on unmount ---
  // Per spec: keep activeSegmentId at its last value on unmount/pause — no explicit clear.
  useEffect(() => {
    return () => {
      if (manualScrollTimerRef.current) {
        clearTimeout(manualScrollTimerRef.current);
      }
    };
  }, []);
}
