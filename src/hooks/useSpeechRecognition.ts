/**
 * Real-time speech-to-text using the Web Speech API (SpeechRecognition).
 *
 * Works in Tauri's WebView2 (Chromium-based) on Windows.
 * Produces interim results that stream into the current segment,
 * and final results when the speaker pauses — creating a new block.
 *
 * Web Speech always uses the browser's default mic (overridden via
 * IPolicyConfig when needed). The speaker label is determined by which
 * party has web_speech selected — YOU and THEM are treated identically.
 */

import { useEffect, useRef } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranscriptStore } from "../stores/transcriptStore";
import { useConfigStore } from "../stores/configStore";
import { useSpeakerStore } from "../stores/speakerStore";
import { pushTranscript, ensureIpolicyOverride } from "../lib/ipc";

// Web Speech API types (not in all TS libs)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

/** Determine speaker label from config — whichever party has web_speech gets the label. */
function getSpeakerLabel(cfg: ReturnType<typeof useConfigStore.getState>["meetingAudioConfig"]): "User" | "Them" {
  if (!cfg) return "User";
  // If THEM has web_speech → label as "Them"
  if (cfg.them.stt_provider === "web_speech" && cfg.them.is_input_device) return "Them";
  // Default: label as "User" (You party)
  return "User";
}

/**
 * Hook that runs browser-native speech recognition while a meeting is active.
 * Speaker label is determined by which party has web_speech configured —
 * YOU and THEM are treated identically.
 */
export function useSpeechRecognition() {
  const isRecording = useMeetingStore((s) => s.isRecording);

  const audioMode = useMeetingStore((s) => s.audioMode);

  // Derive a stable boolean — only re-runs when web_speech status changes.
  // In in-person mode, SKIP web_speech for the "you" party — room mic captures everyone.
  // Only use web_speech if it's configured for the "them" (room) party in in-person mode.
  const usesWebSpeech = useConfigStore((s) => {
    const cfg = s.meetingAudioConfig;
    if (!cfg) return false;
    const youIsWebSpeech = cfg.you.stt_provider === "web_speech" && cfg.you.is_input_device;
    const themIsWebSpeech = cfg.them.stt_provider === "web_speech" && cfg.them.is_input_device;
    if (audioMode === "in_person") {
      // In-person: only use web_speech for the room source (them), not for mic (you)
      return themIsWebSpeech;
    }
    return youIsWebSpeech || themIsWebSpeech;
  });
  const sttLanguage = useConfigStore((s) => s.sttLanguage);

  // Ref for store action — always fresh without being a dep.
  const updateInterimRef = useRef(useTranscriptStore.getState().updateInterimSegment);
  useEffect(() => {
    return useTranscriptStore.subscribe((s) => {
      updateInterimRef.current = s.updateInterimSegment;
    });
  }, []);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const segmentCounterRef = useRef(0);
  const shouldRestartRef = useRef(false);
  const sessionPrefixRef = useRef("");
  const instanceIdRef = useRef(0);
  // Track consecutive restart failures for backoff
  const restartFailCountRef = useRef(0);

  useEffect(() => {
    // Always clean up any existing recognition first
    if (recognitionRef.current) {
      shouldRestartRef.current = false;
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }

    if (!isRecording || !usesWebSpeech) return;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("[STT] Web Speech API not supported in this WebView");
      return;
    }

    // Determine speaker label from config — symmetric for YOU and THEM
    const currentConfig = useConfigStore.getState().meetingAudioConfig;
    const currentLanguage = sttLanguage || "en-US";
    const speakerLabel = getSpeakerLabel(currentConfig);

    console.log(
      "[STT] Web Speech starting | speaker:", speakerLabel,
      "| Language:", currentLanguage,
      "| Config:",
      currentConfig
        ? `you=${currentConfig.you.stt_provider}, them=${currentConfig.them.stt_provider}`
        : "null"
    );

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = currentLanguage;

    recognitionRef.current = recognition;
    shouldRestartRef.current = true;
    sessionPrefixRef.current = Date.now().toString(36).slice(-4);
    restartFailCountRef.current = 0;
    const myInstanceId = ++instanceIdRef.current;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Reset fail count on successful result — recognition is healthy
      restartFailCountRef.current = 0;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript.trim();
        const confidence = result[0].confidence || 0.9;
        if (!transcript) continue;

        const segId = `web_${sessionPrefixRef.current}_${segmentCounterRef.current + 1}`;

        if (result.isFinal) {
          segmentCounterRef.current += 1;
          const now = Date.now();
          const speakerId = speakerLabel === "User" ? "you" : "them";
          const wordCount = transcript.split(/\s+/).filter(Boolean).length;
          useSpeakerStore.getState().updateStats(speakerId, wordCount, 0);
          updateInterimRef.current({
            id: segId,
            text: transcript,
            speaker: speakerLabel,
            speaker_id: speakerId,
            timestamp_ms: now,
            is_final: true,
            confidence,
          });
          pushTranscript(transcript, speakerLabel, now, true).catch(() => {});
        } else {
          const speakerId = speakerLabel === "User" ? "you" : "them";
          updateInterimRef.current({
            id: segId,
            text: transcript,
            speaker: speakerLabel,
            speaker_id: speakerId,
            timestamp_ms: Date.now(),
            is_final: false,
            confidence: 0,
          });
        }
      }
    };

    recognition.onerror = (event: Event & { error: string }) => {
      const error = event.error;
      // "no-speech" is normal — just silence, onend will fire and restart
      // "aborted" happens when we stop intentionally
      if (error === "no-speech" || error === "aborted") return;
      console.error("[STT] Speech recognition error:", error);
    };

    recognition.onend = () => {
      // Only restart if this is still the current instance
      if (instanceIdRef.current !== myInstanceId) return;
      if (!shouldRestartRef.current || !recognitionRef.current) return;

      // Backoff: 300ms, 600ms, 1200ms, capped at 2000ms
      const delay = Math.min(300 * Math.pow(2, restartFailCountRef.current), 2000);
      const restartNum = restartFailCountRef.current + 1;

      console.log(`[STT] Web Speech onend | restart #${restartNum}, delay ${delay}ms`);

      setTimeout(async () => {
        if (instanceIdRef.current !== myInstanceId) return;
        if (!shouldRestartRef.current || !recognitionRef.current) return;

        // Check fresh config
        const freshCfg = useConfigStore.getState().meetingAudioConfig;
        const stillActive =
          (freshCfg?.you.stt_provider === "web_speech" && freshCfg?.you.is_input_device) ||
          (freshCfg?.them.stt_provider === "web_speech" && freshCfg?.them.is_input_device);
        if (!stillActive) return;

        // Verify IPolicy before restarting — never block restart on failure
        try {
          const ipolicy = await ensureIpolicyOverride();
          if (ipolicy.was_drifted) {
            console.warn("[STT] IPolicy drift corrected before restart");
          } else if (ipolicy.active) {
            console.log("[STT] IPolicy verified (no drift)");
          }
        } catch (err) {
          console.warn("[STT] IPolicy verification failed, proceeding anyway:", err);
        }

        // Guard again after async — state may have changed during IPolicy check
        if (instanceIdRef.current !== myInstanceId) return;
        if (!shouldRestartRef.current || !recognitionRef.current) return;

        try {
          recognitionRef.current!.start();
          console.log("[STT] Web Speech auto-restarted (delay:", delay, "ms)");
        } catch (err) {
          restartFailCountRef.current += 1;
          console.warn("[STT] Web Speech restart failed, will retry:", err);
          // Force another onend to trigger retry with longer backoff
          // by creating a fresh instance
          if (restartFailCountRef.current <= 5) {
            try {
              // Re-verify IPolicy before fresh instance — device may have drifted
              try {
                await ensureIpolicyOverride();
              } catch {
                // proceed anyway
              }
              const fresh = new SpeechRecognition();
              fresh.continuous = true;
              fresh.interimResults = true;
              fresh.maxAlternatives = 1;
              fresh.lang = useConfigStore.getState().sttLanguage || currentLanguage;
              // Copy handlers from old instance
              fresh.onresult = recognitionRef.current!.onresult;
              fresh.onerror = recognitionRef.current!.onerror;
              fresh.onend = recognitionRef.current!.onend;
              recognitionRef.current = fresh;
              fresh.start();
              console.log("[STT] Web Speech creating fresh instance (restart failed)");
            } catch {
              console.error("[STT] Web Speech fresh instance creation also failed");
            }
          }
        }
      }, delay);
    };

    try {
      recognition.start();
      console.log("[STT] Web Speech recognition started");
    } catch (err) {
      console.warn("[STT] Recognition start deferred:", err);
    }

    return () => {
      shouldRestartRef.current = false;
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch {}
        recognitionRef.current = null;
      }
    };
  }, [isRecording, usesWebSpeech, sttLanguage]);
}
