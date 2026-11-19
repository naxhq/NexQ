// Watches meetingAudioConfig changes during an active meeting
// and restarts the Rust audio capture pipeline with the new config.
// This enables "hot-swap" of STT provider and audio source mid-meeting.
//
// Key design: debounce (300ms) + sequential restart. Two separate refs:
// - appliedConfigRef: what Rust currently has running (only set after successful restart)
// - pendingConfigRef: set immediately to prevent duplicate debounce scheduling

import { useEffect, useRef } from "react";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useDevLogStore } from "../stores/devLogStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { startCapturePerParty } from "../lib/ipc";
import { skipYouStt } from "../lib/audioMode";

export function useAudioConfigSync() {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);

  // null starts a new session, undefined means the last restart failed.
  const appliedConfigRef = useRef<string | null | undefined>(null);
  // What we've already scheduled a restart for — prevents duplicate debounces
  const pendingConfigRef = useRef<string | null>(null);
  // Guard against concurrent restart attempts
  const restartingRef = useRef(false);
  // Debounce timer to batch rapid config changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isRecording || !meetingAudioConfig) return;

    const configKey = JSON.stringify(meetingAudioConfig);

    // On first run (meeting just started), record the applied config
    if (appliedConfigRef.current === null) {
      appliedConfigRef.current = configKey;
      pendingConfigRef.current = configKey;
      return;
    }

    // Already applied — nothing to do
    if (appliedConfigRef.current === configKey) return;

    // Already scheduled a restart for this exact config
    if (pendingConfigRef.current === configKey) return;

    // Mark this config as pending (prevents duplicate debounce scheduling)
    pendingConfigRef.current = configKey;

    const log = useDevLogStore.getState().addEntry;
    const desc = `you=${meetingAudioConfig.you.stt_provider}` +
      (meetingAudioConfig.you.local_model_id ? `(${meetingAudioConfig.you.local_model_id})` : "") +
      `, them=${meetingAudioConfig.them.stt_provider}` +
      (meetingAudioConfig.them.local_model_id ? `(${meetingAudioConfig.them.local_model_id})` : "");
    log("info", "config", `STT config changed → ${desc}`);

    // Cancel any existing debounce — the new config supersedes it
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;

      // If already restarting, clear pending so next effect re-schedules
      if (restartingRef.current) {
        log("warn", "config", "Hot-swap already in progress — queued for retry");
        pendingConfigRef.current = null;
        return;
      }

      restartingRef.current = true;

      // Read the latest config (may have changed during debounce wait)
      const latestConfig = useConfigStore.getState().meetingAudioConfig;
      if (!latestConfig) {
        restartingRef.current = false;
        return;
      }

      const latestKey = JSON.stringify(latestConfig);

      // If the latest config matches what's already running, skip
      if (appliedConfigRef.current === latestKey) {
        pendingConfigRef.current = latestKey;
        restartingRef.current = false;
        return;
      }

      try {
        // Rust checks the new STT configuration before replacing the active capture.
        useTranscriptStore.getState().finalizeAllInterim();
        log("info", "config", "Hot-swap: starting new capture pipeline...");
        await startCapturePerParty(latestConfig.you, latestConfig.them, {
          skipYouStt: skipYouStt(useMeetingStore.getState().audioMode),
        });
        appliedConfigRef.current = latestKey;
        pendingConfigRef.current = latestKey;
        log("info", "config", "Hot-swap complete — new STT pipeline active");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", "config", `Hot-swap FAILED: ${msg}`);
        // Allow the next config change to retry, including a return to the prior config.
        appliedConfigRef.current = undefined;
        pendingConfigRef.current = null;
      } finally {
        restartingRef.current = false;
      }
    }, 300);
  }, [isRecording, meetingAudioConfig]);

  // Reset when meeting ends
  useEffect(() => {
    if (!isRecording) {
      appliedConfigRef.current = null;
      pendingConfigRef.current = null;
      restartingRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }
  }, [isRecording]);
}
