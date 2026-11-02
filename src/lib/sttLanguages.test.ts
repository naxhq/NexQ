import { describe, expect, it } from "vitest";
import { STT_LANGUAGES, cartesiaSupportsLanguage } from "./sttLanguages";

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
