// Per-side transcription language, shared by Settings > Audio & Devices and the
// meeting overlay: one way to store a side's language and one way to judge it.

import type { MeetingAudioConfig, PartyAudioConfig } from "./types";
import {
  AUTO_STT_LANGUAGE,
  STT_LANGUAGES,
  autoDetectProblem,
  sideLanguageHint,
  type AutoDetectModels,
  type SideLanguageHint,
} from "./sttLanguages";

/**
 * The config with `updates` applied to one side. A cleared language ("Default")
 * is stored as no language at all, so the config keeps the shape older versions
 * saved. Any edit leaves the preset it came from.
 */
export function updatePartyConfig(
  config: MeetingAudioConfig,
  party: "you" | "them",
  updates: Partial<PartyAudioConfig>,
): MeetingAudioConfig {
  const merged = { ...config[party], ...updates };
  if (!merged.language) delete merged.language;
  return { ...config, [party]: merged, preset_name: null };
}

export interface SideProblems {
  /** Why Auto-detect won't work for this side's provider, when the side is on Auto-detect. */
  auto: string | null;
  /** What to know about this side's provider and its language (not Auto-detect). */
  hint: SideLanguageHint | null;
}

/** What is wrong, or worth knowing, about a side's provider with `language`. `label` is "You", "Them" or "Room". */
export function sideLanguageProblems(
  party: PartyAudioConfig,
  language: string,
  models: AutoDetectModels,
  label: string,
): SideProblems {
  const side = { provider: party.stt_provider, localModel: party.local_model_id };
  return {
    auto: language === AUTO_STT_LANGUAGE ? autoDetectProblem(side, models, label) : null,
    hint: sideLanguageHint(side, language, models),
  };
}

/** The single notice to show for a side: the Auto-detect problem first, else the provider hint. */
export function sideNotice(problems: SideProblems): SideLanguageHint | null {
  return problems.auto ? { tone: "warning", text: problems.auto } : problems.hint;
}

/** "English (US)" for "en-US"; an unknown value is shown as it is. */
export function languageLabel(value: string): string {
  return STT_LANGUAGES.find((l) => l.value === value)?.label ?? value;
}

/** A few characters for a chip: "Auto", "EN-US". */
export function languageShortLabel(value: string): string {
  return value === AUTO_STT_LANGUAGE ? "Auto" : value.toUpperCase();
}
