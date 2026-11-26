/**
 * Which language the user speaks, and how far the local matching can be trusted in
 * it. Said plainly in the settings and the panel: nothing for English and French,
 * a caution for the languages the matcher handles less well.
 */
export type NoteLang = "en" | "fr" | "es" | "pt" | "de" | "ar" | "ja" | "zh" | "ko" | "other";

export const LANG_NAMES: Record<NoteLang, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  de: "German",
  ar: "Arabic",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  other: "this language",
};

const STOP: Partial<Record<NoteLang, string[]>> = {
  en: ["the", "and", "of", "to", "is", "that", "with", "for", "we", "you"],
  fr: ["le", "la", "les", "des", "est", "et", "un", "une", "pour", "que", "nous", "vous"],
  es: ["el", "los", "las", "de", "que", "y", "en", "una", "es", "por", "con", "para", "nosotros"],
  pt: ["os", "as", "de", "que", "em", "um", "uma", "para", "com", "não", "nós", "você"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "mit", "wir", "sie", "für"],
};

/** The language of a speech-language setting such as "ja-JP" or "fr"; null for auto or unknown. */
export function languageFromCode(code: string | null | undefined): NoteLang | null {
  const c = (code ?? "").trim().toLowerCase();
  if (!c || c === "auto") return null;
  const p = c.split(/[-_]/)[0];
  if (p === "en" || p === "fr" || p === "es" || p === "pt" || p === "de" || p === "ar" || p === "ja" || p === "ko") return p;
  if (p === "zh" || p === "yue" || p === "cmn") return "zh";
  return "other";
}

/** From the script (Japanese kana, Hangul, Han, Arabic) and, for Latin text, common words. */
export function detectLanguage(text: string): NoteLang | null {
  const sample = text.slice(0, 4000);
  if (/[぀-ヿ]/.test(sample)) return "ja";
  if (/[가-힯]/.test(sample)) return "ko";
  if (/[一-鿿]/.test(sample)) return "zh";
  if (/[؀-ۿ]/.test(sample)) return "ar";
  const words = sample.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 6) return null;
  let best: NoteLang | null = null;
  let bestN = 2; // at least three hits
  for (const [lang, list] of Object.entries(STOP) as Array<[NoteLang, string[]]>) {
    const set = new Set(list);
    const n = words.reduce((k, w) => k + (set.has(w) ? 1 : 0), 0);
    if (n > bestN) {
      best = lang;
      bestN = n;
    }
  }
  return best;
}

/** The meeting language of the You side wins; a note's own script and words are the fallback. */
export function resolveLanguage(code: string | null | undefined, noteText: string): NoteLang | null {
  return languageFromCode(code) ?? detectLanguage(noteText);
}

/** One plain sentence, or null when nothing needs saying. */
export function languageNote(lang: NoteLang | null): string | null {
  if (!lang || lang === "en" || lang === "fr" || lang === "other") return null;
  const name = LANG_NAMES[lang];
  if (lang === "ja" || lang === "zh" || lang === "ko") return `Ticks often miss rephrased lines in ${name}.`;
  return `Ticks may be missed in ${name}.`;
}
