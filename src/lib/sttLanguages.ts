export const STT_LANGUAGES = [
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

/** Languages Cartesia ink-2 detects on its own (it has no language setting). */
const CARTESIA_LANGUAGES = ["en", "fr", "hi", "ja", "es"];

/** Whether Cartesia ink-2 transcribes `language`, an STT_LANGUAGES value such as "fr-FR". */
export function cartesiaSupportsLanguage(language: string): boolean {
  return CARTESIA_LANGUAGES.includes(language.split("-")[0].toLowerCase());
}
