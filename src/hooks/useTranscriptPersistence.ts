import { useEffect, useRef } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { appendTranscriptSegment } from "../lib/ipc";

const FLUSH_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Hook that persists transcript segments to SQLite incrementally.
 * Every 30 seconds during an active meeting, it flushes any new
 * (not-yet-persisted) transcript segments to the database.
 * Tracks which segments have been persisted by index.
 */
export function useTranscriptPersistence() {
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const lastPersistedIndex = useMeetingStore((s) => s.lastPersistedIndex);
  const setLastPersistedIndex = useMeetingStore((s) => s.setLastPersistedIndex);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!activeMeeting) {
      // No active meeting — clear interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    const meetingId = activeMeeting.id;

    async function flushSegments() {
      const segments = useTranscriptStore.getState().segments;
      const currentLastIndex = useMeetingStore.getState().lastPersistedIndex;

      // Persist only the contiguous finalized prefix after the last checkpoint.
      // If a later final arrives while an earlier interim is still open, don't
      // advance past that interim or it can be skipped when it finalizes.
      let persistUntil = currentLastIndex;
      while (persistUntil < segments.length && segments[persistUntil].is_final) {
        persistUntil += 1;
      }

      const newSegments = segments.slice(currentLastIndex, persistUntil);

      if (newSegments.length === 0) return;

      for (const segment of newSegments) {
        try {
          await appendTranscriptSegment(meetingId, JSON.stringify(segment));
        } catch (err) {
          console.error("[transcriptPersistence] Failed to persist segment:", err);
          // Stop trying to persist more if one fails
          return;
        }
      }

      setLastPersistedIndex(persistUntil);
    }

    // Set up the 30-second interval
    intervalRef.current = setInterval(flushSegments, FLUSH_INTERVAL_MS);

    return () => {
      // On cleanup, do a final flush
      flushSegments();

      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [activeMeeting, setLastPersistedIndex]);
}
