import { describe, expect, it } from "vitest";
import type { STTProviderType } from "./types";
import cases from "./autoDetectCases.json";
import {
  AUTO_DETECT_ADVICE,
  AUTO_DETECT_REFUSAL_PREFIX,
  AUTO_DETECT_WHISPER_ADVICE,
  DEEPGRAM_MODEL_LABELS,
  WHISPER_MODEL_LABELS,
  autoDetectRefusalSentences,
  STT_LANGUAGES,
  autoDetectProblem,
  cartesiaSupportsLanguage,
  sideLanguage,
  sideLanguageHint,
  supportsSTTAutoDetection,
} from "./sttLanguages";

/**
 * autoDetectCases.json is the provider/model table the Rust side checks too
 * (`supports_auto_language`, in src-tauri/src/commands/audio_commands.rs).
 */
const AUTO_DETECT_CASES = cases.cases as { provider: STTProviderType; model: string; supported: boolean; name?: string }[];

describe("autoDetectCases.json (shared with Rust)", () => {
  it.each(AUTO_DETECT_CASES)("$provider / $model", ({ provider, model, supported, name }) => {
    expect(supportsSTTAutoDetection(provider, model)).toBe(supported);
    const problem = autoDetectProblem({ provider, localModel: model || undefined }, { deepgram: model }, "You");
    if (supported) {
      expect(problem).toBeNull();
    } else {
      expect(problem).not.toBeNull();
      expect(problem!.startsWith(`${AUTO_DETECT_REFUSAL_PREFIX} ${name}, used for You. `)).toBe(true);
    }
  });
});

describe("refusal wording (shared with Rust)", () => {
  it("uses the wording in autoDetectCases.json", () => {
    expect(AUTO_DETECT_REFUSAL_PREFIX).toBe(cases.refusalPrefix);
    expect(AUTO_DETECT_ADVICE).toBe(cases.advice);
    expect(AUTO_DETECT_WHISPER_ADVICE).toBe(cases.whisperAdvice);
    expect(DEEPGRAM_MODEL_LABELS).toEqual(cases.deepgramLabels);
    expect(WHISPER_MODEL_LABELS).toEqual(cases.whisperLabels);
  });

  it("picks the sentences naming each refused side out of a joined refusal", () => {
    const joined = `${autoDetectProblem({ provider: "web_speech" }, {}, "You")} ${autoDetectProblem({ provider: "whisper_cpp", localModel: "ggml-base.en.bin" }, {}, "Room")}`;
    expect(autoDetectRefusalSentences(joined)).toEqual([
      "Auto-detect doesn't work with Web Speech, used for You.",
      "Auto-detect doesn't work with the base.en Whisper model, used for Room.",
    ]);
  });
});

describe("autoDetectProblem", () => {
  it("names the side, the provider and what to change", () => {
    expect(autoDetectProblem({ provider: "web_speech" }, {}, "You")).toBe(
      "Auto-detect doesn't work with Web Speech, used for You. " +
      "Choose Deepgram Nova-3, Parakeet TDT 0.6B v3, Groq Whisper or Whisper API for that side, or pick a language."
    );
    expect(autoDetectProblem({ provider: "deepgram" }, { deepgram: "nova-2" }, "Room")).toContain(
      "Deepgram Nova 2, used for Room"
    );
  });

  it("sends a failing Whisper model to a multilingual Whisper model, not to Whisper in general", () => {
    const problem = autoDetectProblem({ provider: "whisper_cpp", localModel: "ggml-distil-large-v3.bin" }, {}, "Them");
    expect(problem).toBe(
      "Auto-detect doesn't work with the Distil Large v3 Whisper model, used for Them. " +
      "Choose a multilingual Whisper model (Tiny, Base, Small, Medium or Large v3 Turbo), or pick a language."
    );
  });

  it("uses the model a side falls back to", () => {
    expect(autoDetectProblem({ provider: "whisper_cpp" }, { whisperCpp: "small" }, "You")).toBeNull();
    expect(autoDetectProblem({ provider: "parakeet_tdt" }, { parakeet: "parakeet-tdt-ctc-110m-int8" }, "You"))
      .toContain("Parakeet CTC 110M");
    // A Parakeet model name never leaks into another provider's check.
    expect(autoDetectProblem({ provider: "web_speech" }, { parakeet: "parakeet-tdt-0.6b-v3-int8" }, "You"))
      .toContain("Web Speech");
  });
});

describe("supportsSTTAutoDetection", () => {
  it("checks the selected model for model-dependent engines", () => {
    expect(supportsSTTAutoDetection("deepgram", "nova-3")).toBe(true);
    expect(supportsSTTAutoDetection("deepgram", "flux-general-multi")).toBe(true);
    expect(supportsSTTAutoDetection("deepgram", "flux-general-en")).toBe(false);
    expect(supportsSTTAutoDetection("whisper_cpp", "small")).toBe(true);
    expect(supportsSTTAutoDetection("whisper_cpp", "distil-large-v3")).toBe(false);
    expect(supportsSTTAutoDetection("parakeet_tdt", "parakeet-tdt-0.6b-v3-int8")).toBe(true);
    expect(supportsSTTAutoDetection("parakeet_tdt", "parakeet-tdt-ctc-110m-int8")).toBe(false);
    expect(supportsSTTAutoDetection("web_speech")).toBe(false);
  });
});

describe("cartesiaSupportsLanguage", () => {
  it("accepts the five languages ink-2 detects", () => {
    for (const lang of ["en-US", "en-GB", "fr-FR", "hi-IN", "ja-JP", "es-ES"]) {
      expect(cartesiaSupportsLanguage(lang)).toBe(true);
    }
  });

  it("rejects the other app languages", () => {
    const unsupported = STT_LANGUAGES.map((l) => l.value).filter(
      (v) => !["en", "fr", "hi", "ja", "es"].includes(v.split("-")[0])
    );
    expect(unsupported).toContain("ru-RU");
    expect(unsupported).toContain("uk-UA");
    expect(unsupported).toContain("vi-VN");
    for (const lang of unsupported) {
      expect(cartesiaSupportsLanguage(lang)).toBe(false);
    }
  });
});

describe("sideLanguage", () => {
  it("is the side's own language, else the shared one", () => {
    expect(sideLanguage({ language: "es-ES" }, "en-US")).toBe("es-ES");
    expect(sideLanguage({ language: "auto" }, "en-US")).toBe("auto");
    // A config saved before this setting has no language.
    expect(sideLanguage({}, "en-US")).toBe("en-US");
    expect(sideLanguage({ language: "" }, "fr-FR")).toBe("fr-FR");
    expect(sideLanguage({ language: "  " }, "fr-FR")).toBe("fr-FR");
    expect(sideLanguage(null, "de-DE")).toBe("de-DE");
    expect(sideLanguage({}, "auto")).toBe("auto");
  });
});

describe("sideLanguageHint", () => {
  const none = {};
  it("warns about Flux and Ukrainian, Cartesia languages, Parakeet CTC and Vietnamese", () => {
    expect(sideLanguageHint({ provider: "deepgram" }, "uk-UA", { deepgram: "flux-general-multi" })).toEqual({
      tone: "warning",
      text: "Switch from Flux to Nova-3 for Ukrainian transcription.",
    });
    expect(sideLanguageHint({ provider: "deepgram" }, "uk-UA", { deepgram: "nova-3" })).toBeNull();
    expect(sideLanguageHint({ provider: "cartesia" }, "de-DE", none)?.tone).toBe("warning");
    expect(sideLanguageHint({ provider: "cartesia" }, "es-ES", none)).toBeNull();
    expect(
      sideLanguageHint({ provider: "parakeet_tdt", localModel: "parakeet-tdt-ctc-110m-int8" }, "es-ES", none)?.text,
    ).toMatch(/English-only/);
    expect(
      sideLanguageHint({ provider: "parakeet_tdt", localModel: "parakeet-tdt-ctc-110m-int8" }, "en-GB", none),
    ).toBeNull();
    expect(sideLanguageHint({ provider: "parakeet_tdt" }, "vi-VN", none)?.text).toMatch(/Vietnamese/);
    expect(sideLanguageHint({ provider: "deepgram" }, "vi-VN", { deepgram: "nova-3" })?.tone).toBe("info");
  });

  it("warns when Parakeet TDT v3 isn't given one of the 25 languages on NVIDIA's model card", () => {
    const parakeet = { provider: "parakeet_tdt" as const };
    // In the app's list: English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Ukrainian, Polish, Czech, Swedish.
    for (const language of ["en-US", "en-GB", "es-ES", "fr-FR", "de-DE", "it-IT", "pt-BR", "nl-NL", "ru-RU", "uk-UA", "pl-PL", "cs-CZ", "sv-SE"]) {
      expect(sideLanguageHint(parakeet, language, none), language).toBeNull();
    }
    // Not on the card: Japanese, Chinese, Korean, Hindi, Arabic, Turkish.
    for (const language of ["ja-JP", "zh-CN", "ko-KR", "hi-IN", "ar-SA", "tr-TR"]) {
      expect(sideLanguageHint(parakeet, language, none)?.text, language).toMatch(/25 European languages/);
    }
    // The model the side runs decides; Vietnamese keeps its own wording.
    expect(sideLanguageHint(parakeet, "ja-JP", { parakeet: "parakeet-tdt-0.6b-v3-int8" })?.tone).toBe("warning");
    expect(sideLanguageHint(parakeet, "vi-VN", none)?.text).toMatch(/Vietnamese/);
    expect(
      sideLanguageHint({ ...parakeet, localModel: "parakeet-tdt-ctc-110m-int8" }, "ja-JP", none)?.text,
    ).toMatch(/English-only/);
  });

  it("warns when Flux (English) is given another language, and Flux Multilingual isn't", () => {
    expect(sideLanguageHint({ provider: "deepgram" }, "es-ES", { deepgram: "flux-general-en" })?.text).toMatch(
      /English only/,
    );
    expect(sideLanguageHint({ provider: "deepgram" }, "uk-UA", { deepgram: "flux-general-en" })?.text).toMatch(
      /English only/,
    );
    expect(sideLanguageHint({ provider: "deepgram" }, "en-GB", { deepgram: "flux-general-en" })).toBeNull();
    expect(sideLanguageHint({ provider: "deepgram" }, "es-ES", { deepgram: "flux-general-multi" })).toBeNull();
    expect(sideLanguageHint({ provider: "deepgram" }, "es-ES", { deepgram: "nova-3" })).toBeNull();
    // Auto-detect on Flux (English) is the Auto-detect refusal's business.
    expect(sideLanguageHint({ provider: "deepgram" }, "auto", { deepgram: "flux-general-en" })).toBeNull();
  });

  it("leaves Auto-detect to autoDetectProblem and fine pairs alone", () => {
    expect(sideLanguageHint({ provider: "cartesia" }, "auto", none)).toBeNull();
    expect(sideLanguageHint({ provider: "web_speech" }, "uk-UA", none)).toBeNull();
    expect(sideLanguageHint({ provider: "groq_whisper" }, "es-ES", none)).toBeNull();
  });
});
