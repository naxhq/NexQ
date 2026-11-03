// Sub-PRD 4: Subscribe to transcript_update + transcript_final events
// Connects the Tauri IPC event stream to the Zustand transcript store.
// Also processes speaker_id through speakerStore for enrichment and stats.

import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onTranscriptUpdate, onTranscriptFinal } from "../lib/events";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { useConfigStore } from "../stores/configStore";
import type { TranscriptSegment, TranscriptUpdateEvent } from "../lib/types";

const STALE_INTERIM_CHECK_MS = 2_000;

// Cache reference to avoid repeated imports
let _meetingStoreRef: typeof import("../stores/meetingStore") | null = null;

// Dev log helper — imported lazily to avoid circular deps
function devLog(msg: string) {
  import("../stores/devLogStore").then(({ useDevLogStore }) => {
    useDevLogStore.getState().addEntry("info", "speaker", msg);
  }).catch(() => {});
}

/**
 * Process a transcript segment through the speaker store:
 * - Resolve speaker_id from segment metadata (mode-aware)
 * - In in-person mode, discard mic-only "User" segments (room captures everything)
 * - Auto-create speaker if not already tracked
 * - Update speaker stats on final segments
 * - Return enriched segment with speaker_id set, or null to discard
 */
/** Words already counted in speaker stats, per final segment id. */
const countedWords = new Map<string, number>();

function currentIsInPerson(): boolean {
  try {
    if (_meetingStoreRef) {
      return _meetingStoreRef.useMeetingStore.getState().audioMode === "in_person";
    }
  } catch { /* fallback to online mode */ }
  return false;
}

export function processSpeaker(
  segment: TranscriptSegment,
  isInPerson: boolean = currentIsInPerson()
): TranscriptSegment | null {
  const speakerStore = useSpeakerStore.getState();

  // In in-person mode, discard "User" segments — the room mic captures everyone,
  // so mic/Web Speech transcription is redundant and confusing.
  if (isInPerson && segment.speaker === "User") {
    return null;
  }

  let speakerId: string;

  if (!isInPerson) {
    // Online: the parties are fixed You / Them. A diarized remote line keeps
    // "them" (stats, filters, question detection) and is told apart by its
    // speaker_tag, tracked as the remote speaker `them:<tag>`; the raw
    // diarized speaker_id ("speaker_0") is not used here.
    speakerId = segment.speaker === "User" ? "you" : "them";
    if (speakerId === "them" && segment.speaker_tag) {
      speakerStore.ensureRemoteSpeaker(segment.speaker_tag);
    }
  } else if (segment.speaker_id) {
    // Diarized segment from Deepgram — use the speaker_id directly
    speakerId = segment.speaker_id;
  } else {
    // In-person mode interim without diarization data
    const diarizationEnabled = useConfigStore.getState().diarizationEnabled;
    if (diarizationEnabled) {
      // Pending: diarization will resolve speaker on the final result
      speakerId = "__pending";
    } else {
      // No diarization: everything is "room"
      speakerId = "room";
    }
  }

  // Debug: log speaker assignment for final segments
  if (segment.is_final) {
    devLog(
      `[speaker] "${segment.text.slice(0, 40)}" | raw_speaker=${segment.speaker ?? "?"} raw_speaker_id=${segment.speaker_id ?? "none"} mode=${isInPerson ? "in_person" : "online"} → speakerId=${speakerId}`
    );
  }

  // Skip registration and stats for pending segments
  if (speakerId !== "__pending") {
    if (!speakerStore.getSpeaker(speakerId)) {
      speakerStore.addSpeaker(speakerId);
    }
    if (segment.is_final) {
      // A line that grows is re-sent as a final under the same id: count
      // only its new words, and the line once.
      const wordCount = segment.text.split(/\s+/).filter(Boolean).length;
      const counted = countedWords.get(segment.id);
      countedWords.set(segment.id, wordCount);
      if (counted === undefined) {
        speakerStore.updateStats(speakerId, wordCount, 0);
      } else if (wordCount > counted) {
        speakerStore.updateStats(speakerId, wordCount - counted, 0, false);
      }
    }
  }

  return { ...segment, speaker_id: speakerId };
}

/**
 * Hook that subscribes to transcript IPC events and routes them
 * to the transcript store.
 *
 * - "transcript_update" events (interim results) -> updateInterimSegment
 * - "transcript_final" events (final results) -> appendSegment
 *
 * All segments are processed through the speaker store for enrichment.
 * In in-person mode, "User" segments from mic are discarded.
 */
export function useTranscript() {
  const appendSegment = useTranscriptStore((s) => s.appendSegment);
  const updateInterimSegment = useTranscriptStore(
    (s) => s.updateInterimSegment
  );

  // Lazy-load meetingStore reference for mode-aware speaker processing
  if (!_meetingStoreRef) {
    import("../stores/meetingStore").then((mod) => { _meetingStoreRef = mod; });
  }

  // Use refs to avoid re-subscribing when store actions change reference
  const appendRef = useRef(appendSegment);
  const updateRef = useRef(updateInterimSegment);

  useEffect(() => {
    appendRef.current = appendSegment;
    updateRef.current = updateInterimSegment;
  }, [appendSegment, updateInterimSegment]);

  // Runs in each window: the launcher and the overlay keep their own transcript.
  useEffect(() => {
    const timer = setInterval(
      () => useTranscriptStore.getState().dropStaleInterim(),
      STALE_INTERIM_CHECK_MS
    );
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let unlistenUpdate: UnlistenFn | null = null;
    let unlistenFinal: UnlistenFn | null = null;
    let mounted = true;

    const setup = async () => {
      // Subscribe to interim transcript updates — upsert by id
      const unlisten1 = await onTranscriptUpdate(
        (event: TranscriptUpdateEvent) => {
          if (!mounted) return;
          const enriched = processSpeaker(event.segment);
          if (!enriched) return; // Discarded (e.g., "User" in in-person mode)
          updateRef.current(enriched);
        }
      );

      // Subscribe to final transcript results — replace interim in-place (same id)
      const unlisten2 = await onTranscriptFinal(
        (event: TranscriptUpdateEvent) => {
          if (!mounted) return;
          const enriched = processSpeaker(event.segment);
          if (!enriched) return; // Discarded
          // Use updateInterimSegment so it replaces the interim with same id,
          // or appends if no interim existed (e.g., very short utterance)
          updateRef.current(enriched);
        }
      );

      if (mounted) {
        unlistenUpdate = unlisten1;
        unlistenFinal = unlisten2;
      } else {
        unlisten1();
        unlisten2();
      }
    };

    setup();

    return () => {
      mounted = false;
      if (unlistenUpdate) unlistenUpdate();
      if (unlistenFinal) unlistenFinal();
    };
  }, []);
}
