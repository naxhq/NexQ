import type { STTProviderType } from "./types";

export const AUTO_STT_LANGUAGE = "auto";

export const STT_LANGUAGES = [
  { value: AUTO_STT_LANGUAGE, label: "Auto-detect" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "it-IT", label: "Italian" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "ja-JP", label: "Japanese" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "ko-KR", label: "Korean" },
  { value: "nl-NL", label: "Dutch" },
  { value: "hi-IN", label: "Hindi" },
  { value: "ru-RU", label: "Russian" },
  { value: "uk-UA", label: "Ukrainian" },
  { value: "ar-SA", label: "Arabic" },
  { value: "tr-TR", label: "Turkish" },
  { value: "pl-PL", label: "Polish" },
  { value: "cs-CZ", label: "Czech" },
  { value: "sv-SE", label: "Swedish" },
  { value: "vi-VN", label: "Vietnamese" },
];

/** The per-side picker's value for "use the shared transcription language". */
export const SAME_AS_SHARED_LANGUAGE = "";

/**
 * The language one side (You / Them / Room) is transcribed in: its own when it
 * has one, otherwise the shared transcription language. Mirrors
 * `PartyAudioConfig::effective_language` in src-tauri/src/audio/mod.rs.
 */
export function sideLanguage(
  side: { language?: string | null } | null | undefined,
  sharedLanguage: string,
): string {
  const own = side?.language?.trim();
  return own || sharedLanguage;
}

export function isDeepgramNova3(model?: string | null): boolean {
  return model === "nova-3" || model === "nova-3-general";
}

const MULTILINGUAL_WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3-turbo"];

/** "ggml-small.bin" and "small" are the same Whisper model. */
function whisperModelId(model: string): string {
  return model.replace(/^ggml-/, "").replace(/\.bin$/, "");
}

/**
 * Whether a provider (and its model) can detect the spoken language itself.
 * Mirrors `supports_auto_language` in src-tauri/src/commands/audio_commands.rs,
 * which refuses a meeting start for the same cases; AUTO_DETECT_CASES in the
 * tests is the table both sides are checked against.
 */
export function supportsSTTAutoDetection(
  provider: STTProviderType,
  model?: string | null,
): boolean {
  switch (provider) {
    case "deepgram":
      return isDeepgramNova3(model) || model === "flux-general-multi";
    case "whisper_cpp":
      return model == null || MULTILINGUAL_WHISPER_MODELS.includes(whisperModelId(model));
    case "parakeet_tdt":
      return !model || (!model.includes("parakeet") && !model.includes("nemo"))
        || model.startsWith("parakeet-tdt-0.6b-v3");
    case "whisper_api":
    case "groq_whisper":
    case "cartesia":
      return true;
    default:
      return false;
  }
}

/** The models a side falls back to when its own config doesn't name one. */
export interface AutoDetectModels {
  deepgram?: string | null;
  whisperCpp?: string | null;
  parakeet?: string | null;
}

export interface AutoDetectSide {
  provider: STTProviderType;
  localModel?: string | null;
}

/** The model that will actually run for a side, as far as the settings know. */
export function autoDetectModelFor(side: AutoDetectSide, models: AutoDetectModels): string | null | undefined {
  switch (side.provider) {
    case "deepgram":
      return models.deepgram;
    case "whisper_cpp":
      return side.localModel ?? models.whisperCpp;
    case "parakeet_tdt":
      return side.localModel ?? models.parakeet;
    default:
      return undefined;
  }
}

const PROVIDER_NAMES: Partial<Record<STTProviderType, string>> = {
  web_speech: "Web Speech",
  windows_native: "Windows Speech",
  azure_speech: "Azure Speech",
  sherpa_onnx: "Sherpa-ONNX",
  ort_streaming: "ORT Streaming",
};

/** Whisper.cpp models as people know them; other models show their id. */
export const WHISPER_MODEL_LABELS: Record<string, string> = { "distil-large-v3": "Distil Large v3" };
const whisperLabel = (id: string): string => WHISPER_MODEL_LABELS[id] ?? id;

/** Deepgram models as the STT Providers picker names them. */
export const DEEPGRAM_MODEL_LABELS: Record<string, string> = {
  "nova-3": "Nova 3",
  "nova-3-general": "Nova 3",
  "flux-general-en": "Flux",
  "flux-general-multi": "Flux Multilingual",
  "nova-2": "Nova 2",
  nova: "Nova",
  enhanced: "Enhanced",
  base: "Base",
};

/**
 * How Rust starts every message that refuses Auto-detect for a side
 * (AUTO_DETECT_REFUSAL in src-tauri/src/commands/audio_commands.rs).
 */
export const AUTO_DETECT_REFUSAL_PREFIX = "Auto-detect doesn't work with";

export const AUTO_DETECT_ADVICE =
  "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language.";
export const AUTO_DETECT_WHISPER_ADVICE =
  "Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo), or pick a language.";

/**
 * Plain-language reason Auto-detect won't work for one side, or null when it
 * will. `label` is what the person calls that side: "You", "Them" or "Room".
 */
export function autoDetectProblem(
  side: AutoDetectSide,
  models: AutoDetectModels,
  label: string,
): string | null {
  const model = autoDetectModelFor(side, models);
  if (supportsSTTAutoDetection(side.provider, model)) return null;
  let name = PROVIDER_NAMES[side.provider] ?? "this speech-to-text provider";
  if (side.provider === "deepgram") name = `Deepgram ${(model && DEEPGRAM_MODEL_LABELS[model]) || model || "(this model)"}`;
  if (side.provider === "whisper_cpp") name = `the ${model ? whisperLabel(whisperModelId(model)) : "selected"} Whisper model`;
  if (side.provider === "parakeet_tdt") name = "Parakeet CTC 110M";
  const advice = side.provider === "whisper_cpp" ? AUTO_DETECT_WHISPER_ADVICE : AUTO_DETECT_ADVICE;
  return `${AUTO_DETECT_REFUSAL_PREFIX} ${name}, used for ${label}. ${advice}`;
}

/**
 * The 25 languages NVIDIA's model card lists for parakeet-tdt-0.6b-v3
 * (huggingface.co/nvidia/parakeet-tdt-0.6b-v3): bg hr cs da nl en et fi fr de el
 * hu it lv lt mt pl pt ro sk sl es sv ru uk.
 */
const PARAKEET_V3_LANGUAGES = [
  "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
  "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
];

export interface SideLanguageHint {
  /** "warning": the side won't transcribe well. "info": a tip. */
  tone: "warning" | "info";
  text: string;
}

/**
 * What to tell the person about a side's provider and language together
 * (the same hints the STT Providers page shows for the shared language), or
 * null. Auto-detect has its own message, `autoDetectProblem`.
 */
export function sideLanguageHint(
  side: AutoDetectSide,
  language: string,
  models: AutoDetectModels,
): SideLanguageHint | null {
  if (language === AUTO_STT_LANGUAGE) return null;
  const model = autoDetectModelFor(side, models);
  switch (side.provider) {
    case "parakeet_tdt":
      if (language === "vi-VN") {
        return {
          tone: "warning",
          text: "The included Parakeet models do not support Vietnamese. Choose a multilingual Whisper model, Deepgram Nova-3, or Azure Speech.",
        };
      }
      if ((model ?? "parakeet-tdt-0.6b-v3-int8").includes("ctc-110m") && !language.toLowerCase().startsWith("en")) {
        return {
          tone: "warning",
          text: "Parakeet CTC 110M is English-only. Choose Parakeet TDT 0.6B v3 for multilingual transcription.",
        };
      }
      if (!PARAKEET_V3_LANGUAGES.includes(language.split("-")[0].toLowerCase())) {
        return {
          tone: "warning",
          text: "Parakeet TDT 0.6B v3 transcribes 25 European languages only. Choose a multilingual Whisper model, Deepgram Nova-3, or Azure Speech for this language.",
        };
      }
      return null;
    case "deepgram":
      if (language === "vi-VN") {
        return { tone: "info", text: "Select a Deepgram model that supports Vietnamese, such as Nova-3." };
      }
      if (model === "flux-general-en" && !language.toLowerCase().startsWith("en")) {
        return {
          tone: "warning",
          text: "Flux transcribes English only. Switch to Flux Multilingual or Nova-3 for this language.",
        };
      }
      if (language === "uk-UA" && model?.startsWith("flux-")) {
        return { tone: "warning", text: "Switch from Flux to Nova-3 for Ukrainian transcription." };
      }
      return null;
    case "cartesia":
      return cartesiaSupportsLanguage(language)
        ? null
        : {
            tone: "warning",
            text: "Cartesia transcribes only English, French, Hindi, Japanese and Spanish. Choose another provider for this language.",
          };
    default:
      return null;
  }
}

const REFUSAL_SENTENCE = new RegExp(
  `${AUTO_DETECT_REFUSAL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .+?, used for (?:You|Them|Room)\\.`,
  "g",
);

/** The "Auto-detect doesn't work with X, used for Y." sentences of a refusal (without the advice). */
export function autoDetectRefusalSentences(message: string): string[] {
  return message.match(REFUSAL_SENTENCE) ?? [];
}

/** Languages Cartesia ink-2 detects on its own (it has no language setting). */
const CARTESIA_LANGUAGES = ["en", "fr", "hi", "ja", "es"];

/** Whether Cartesia ink-2 transcribes `language`, an STT_LANGUAGES value such as "fr-FR". */
export function cartesiaSupportsLanguage(language: string): boolean {
  return CARTESIA_LANGUAGES.includes(language.split("-")[0].toLowerCase());
}
