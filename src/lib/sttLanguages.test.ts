import { describe, expect, it } from "vitest";
import { STT_LANGUAGES, cartesiaSupportsLanguage, supportsSTTAutoDetection } from "./sttLanguages";

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
    expect(unsupported).toContain("vi-VN");
    for (const lang of unsupported) {
      expect(cartesiaSupportsLanguage(lang)).toBe(false);
    }
  });
});
