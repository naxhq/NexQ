// Watches meetingAudioConfig changes during an active meeting
// and restarts the Rust audio capture pipeline with the new config.
// This enables "hot-swap" of STT provider and audio source mid-meeting.
//
// Key design: debounce (300ms) + sequential restart. Two separate refs:
// - appliedConfigRef: what Rust currently has running (only set after successful restart)
// - pendingConfigRef: set immediately to prevent duplicate debounce scheduling

import { useEffect, useRef, useState } from "react";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useDevLogStore } from "../stores/devLogStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { setPartyLanguage, startCapturePerParty } from "../lib/ipc";
import { skipYouStt } from "../lib/audioMode";
import { AUTO_DETECT_REFUSAL_PREFIX, autoDetectRefusalSentences } from "../lib/sttLanguages";
import { captureKey, languageOnlyChange, overrideKey, type AppliedAudioConfig } from "../lib/audioConfigKeys";
import { useCaptureSyncStore } from "../stores/captureSyncStore";

export function useAudioConfigSync() {
  const isRecording = useMeetingStore((s) => s.isRecording);
  const meetingAudioConfig = useConfigStore((s) => s.meetingAudioConfig);
  // The shared language decides which sides are on Auto-detect, so it can call for a restart too.
  const sttLanguage = useConfigStore((s) => s.sttLanguage);

  // null starts a new session, undefined means the last restart failed.
  const appliedConfigRef = useRef<string | null | undefined>(null);
  // The config and shared language behind appliedConfigRef, to tell a one-side language change
  // (restarts only that side's speech-to-text) from anything else (restarts the capture).
  const appliedSnapshotRef = useRef<AppliedAudioConfig | null>(null);
  // What we've already scheduled a restart for — prevents duplicate debounces
  const pendingConfigRef = useRef<string | null>(null);
  // Guard against concurrent restart attempts
  const restartingRef = useRef(false);
  // A change arrived while a swap was running: look at the config again once it ends
  const retryQueuedRef = useRef(false);
  const [retryTick, setRetryTick] = useState(0);
  // Debounce timer to batch rapid config changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isRecording || !meetingAudioConfig) return;

    const configKey = captureKey(meetingAudioConfig, sttLanguage);
    const settle = (cfg: typeof meetingAudioConfig, shared: string) =>
      useCaptureSyncStore.getState().setSettledOverrideKey(
        overrideKey(cfg, shared, skipYouStt(useMeetingStore.getState().audioMode)),
      );

    // On first run (meeting just started), record the applied config
    if (appliedConfigRef.current === null) {
      appliedConfigRef.current = configKey;
      appliedSnapshotRef.current = { cfg: meetingAudioConfig, shared: sttLanguage };
      pendingConfigRef.current = configKey;
      settle(meetingAudioConfig, sttLanguage);
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
      (meetingAudioConfig.you.language ? ` [${meetingAudioConfig.you.language}]` : "") +
      `, them=${meetingAudioConfig.them.stt_provider}` +
      (meetingAudioConfig.them.local_model_id ? `(${meetingAudioConfig.them.local_model_id})` : "") +
      (meetingAudioConfig.them.language ? ` [${meetingAudioConfig.them.language}]` : "");
    log("info", "config", `STT config changed → ${desc}`);

    // Cancel any existing debounce — the new config supersedes it
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;

      // If already restarting, clear pending and retry as soon as the current swap ends
      // (the effect only re-runs when the config changes, so it has to be nudged).
      if (restartingRef.current) {
        log("warn", "config", "Hot-swap already in progress — queued for retry");
        pendingConfigRef.current = null;
        retryQueuedRef.current = true;
        return;
      }

      restartingRef.current = true;

      // Read the latest config (may have changed during debounce wait)
      const latestConfig = useConfigStore.getState().meetingAudioConfig;
      if (!latestConfig) {
        restartingRef.current = false;
        return;
      }

      const latestShared = useConfigStore.getState().sttLanguage;
      const latestKey = captureKey(latestConfig, latestShared);

      // If the latest config matches what's already running, skip
      if (appliedConfigRef.current === latestKey) {
        pendingConfigRef.current = latestKey;
        restartingRef.current = false;
        settle(latestConfig, latestShared);
        return;
      }

      try {
        const youSkipped = skipYouStt(useMeetingStore.getState().audioMode);
        // Only one side's language changed: restart just that side's speech-to-text, so the
        // other side and the recording keep going. Anything else, or a side Rust can't
        // restart on its own, takes the full swap below.
        const applied = appliedSnapshotRef.current;
        const side = applied ? languageOnlyChange(applied, { cfg: latestConfig, shared: latestShared }) : null;
        let swapped = false;
        if (side) {
          try {
            log("info", "config", `Language change: restarting only the ${side} side's STT...`);
            swapped = await setPartyLanguage(side, latestConfig[side], { skipYouStt: youSkipped });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // A refusal would be the same for a full swap, and nothing was stopped.
            if (msg.startsWith(AUTO_DETECT_REFUSAL_PREFIX)) throw err;
            log("warn", "config", `One-side restart failed (${msg}) — restarting the whole capture`);
          }
        }
        if (!swapped) {
          // Rust checks the new STT configuration before replacing the active capture.
          // MAI reports a real final (or withdraws the hypothesis) while the
          // old capture drains. Do not turn either side's MAI guesses into
          // persistent text during a full pipeline swap.
          useTranscriptStore.getState().finalizeAllInterim((segment) =>
            applied?.cfg[segment.speaker === "User" ? "you" : "them"].stt_provider !== "azure_mai_streaming",
          );
          log("info", "config", "Hot-swap: starting new capture pipeline...");
          await startCapturePerParty(latestConfig.you, latestConfig.them, { skipYouStt: youSkipped });
        }
        appliedConfigRef.current = latestKey;
        appliedSnapshotRef.current = { cfg: latestConfig, shared: latestShared };
        pendingConfigRef.current = latestKey;
        log("info", "config", swapped
          ? `Language change complete — ${side} STT restarted`
          : "Hot-swap complete — new STT pipeline active");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", "config", `Hot-swap FAILED: ${msg}`);
        // Rust says "Auto-detect doesn't work with ..." before it stops anything, so the
        // old capture is still running: keep appliedConfigRef on it, and switching back
        // to that config won't restart capture. Any other failure may have stopped the
        // capture, so mark it unknown (undefined) and let the next change retry.
        const refused = msg.startsWith(AUTO_DETECT_REFUSAL_PREFIX);
        if (!refused) {
          appliedConfigRef.current = undefined;
          appliedSnapshotRef.current = null;
        }
        pendingConfigRef.current = null;
        const warning = refused
          ? `${autoDetectRefusalSentences(msg).join(" ") || msg} Your meeting keeps its current setup.`
          : `Couldn't switch speech-to-text: ${msg}`;
        import("@tauri-apps/api/event")
          .then(({ emit }) => emit("capture_warning", warning))
          .catch(() => {});
      } finally {
        // Web Speech may start again now, whether or not the swap went through.
        settle(latestConfig, latestShared);
        restartingRef.current = false;
        if (retryQueuedRef.current) {
          retryQueuedRef.current = false;
          setRetryTick((tick) => tick + 1);
        }
      }
    }, 300);
  }, [isRecording, meetingAudioConfig, sttLanguage, retryTick]);

  // Reset when meeting ends
  useEffect(() => {
    if (!isRecording) {
      appliedConfigRef.current = null;
      appliedSnapshotRef.current = null;
      pendingConfigRef.current = null;
      useCaptureSyncStore.getState().setSettledOverrideKey(null);
      restartingRef.current = false;
      retryQueuedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }
  }, [isRecording]);
}
