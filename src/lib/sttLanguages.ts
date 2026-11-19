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
  { value: "ar-SA", label: "Arabic" },
  { value: "tr-TR", label: "Turkish" },
  { value: "pl-PL", label: "Polish" },
  { value: "cs-CZ", label: "Czech" },
  { value: "sv-SE", label: "Swedish" },
  { value: "vi-VN", label: "Vietnamese" },
];

export function isDeepgramNova3(model?: string | null): boolean {
  return model === "nova-3" || model === "nova-3-general";
}

export function supportsSTTAutoDetection(
  provider: STTProviderType,
  model?: string | null,
): boolean {
  switch (provider) {
    case "deepgram":
      return isDeepgramNova3(model) || model === "flux-general-multi";
    case "whisper_cpp":
      return model == null || ["tiny", "base", "small", "medium", "large-v3-turbo"].includes(model);
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

/** Languages Cartesia ink-2 detects on its own (it has no language setting). */
const CARTESIA_LANGUAGES = ["en", "fr", "hi", "ja", "es"];

/** Whether Cartesia ink-2 transcribes `language`, an STT_LANGUAGES value such as "fr-FR". */
export function cartesiaSupportsLanguage(language: string): boolean {
  return CARTESIA_LANGUAGES.includes(language.split("-")[0].toLowerCase());
}
