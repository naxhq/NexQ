// Keys that say when the running audio capture has to be restarted, and what the
// Windows default-microphone override depends on.

import type { MeetingAudioConfig } from "./types";
import { AUTO_STT_LANGUAGE, sideLanguage } from "./sttLanguages";

/** Which sides are transcribed with Auto-detect (their own language, else the shared one). */
export function autoSides(cfg: MeetingAudioConfig, sharedLanguage: string): [boolean, boolean] {
  return [
    sideLanguage(cfg.you, sharedLanguage) === AUTO_STT_LANGUAGE,
    sideLanguage(cfg.them, sharedLanguage) === AUTO_STT_LANGUAGE,
  ];
}

/**
 * What the capture was started with: the config, plus which sides are on Auto-detect
 * (the shared language can switch that without touching the config, and Rust leaves
 * a side that can't detect the language without STT and without the mic override).
 */
export function captureKey(cfg: MeetingAudioConfig, sharedLanguage: string): string {
  return JSON.stringify(cfg) + "|" + autoSides(cfg, sharedLanguage).join(",");
}

/** What the running capture was started with: the config and the shared language. */
export interface AppliedAudioConfig {
  cfg: MeetingAudioConfig;
  shared: string;
}

/** The config with both sides' own languages left out. */
function withoutSideLanguages(cfg: MeetingAudioConfig): string {
  return JSON.stringify({
    ...cfg,
    you: { ...cfg.you, language: undefined },
    them: { ...cfg.them, language: undefined },
  });
}

/**
 * The one side whose transcription language is all that differs between the running
 * capture and `next`, so only that side's speech-to-text has to restart. Null when
 * anything else differs, when both sides' languages do, or when neither does (each
 * side's effective language counts: its own, else the shared one).
 */
export function languageOnlyChange(
  applied: AppliedAudioConfig,
  next: AppliedAudioConfig,
): "you" | "them" | null {
  if (withoutSideLanguages(applied.cfg) !== withoutSideLanguages(next.cfg)) return null;
  const youChanged = sideLanguage(applied.cfg.you, applied.shared) !== sideLanguage(next.cfg.you, next.shared);
  const themChanged = sideLanguage(applied.cfg.them, applied.shared) !== sideLanguage(next.cfg.them, next.shared);
  if (youChanged === themChanged) return null;
  return youChanged ? "you" : "them";
}

/**
 * What Rust's default-microphone override depends on, for Web Speech to wait for:
 * each side's provider and device, whether it is on Auto-detect, and whether
 * "You" is skipped (in-person). Other changes (a language, a model) leave it be.
 */
export function overrideKey(cfg: MeetingAudioConfig | null, sharedLanguage: string, youSkipped: boolean): string {
  if (!cfg) return "none";
  const side = (s: MeetingAudioConfig["you"]) => [s.stt_provider, s.device_id, s.is_input_device];
  return JSON.stringify([side(cfg.you), side(cfg.them), autoSides(cfg, sharedLanguage), youSkipped]);
}
