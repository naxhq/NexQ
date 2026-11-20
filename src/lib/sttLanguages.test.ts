import { describe, expect, it } from "vitest";
import type { STTProviderType } from "./types";
import { STT_LANGUAGES, autoDetectProblem, cartesiaSupportsLanguage, supportsSTTAutoDetection } from "./sttLanguages";

/**
 * The provider/model table Rust refuses a meeting start against
 * (`supports_auto_language`, tested in src-tauri/src/commands/audio_commands.rs
 * with the same rows). Change both together.
 */
const AUTO_DETECT_CASES: [STTProviderType, string, boolean][] = [
  ["deepgram", "nova-3", true],
  ["deepgram", "nova-3-general", true],
  ["deepgram", "flux-general-multi", true],
  ["deepgram", "flux-general-en", false],
  ["deepgram", "nova-2", false],
  ["whisper_cpp", "tiny", true],
  ["whisper_cpp", "base", true],
  ["whisper_cpp", "small", true],
  ["whisper_cpp", "medium", true],
  ["whisper_cpp", "large-v3-turbo", true],
  ["whisper_cpp", "distil-large-v3", false],
  ["parakeet_tdt", "parakeet-tdt-0.6b-v3-int8", true],
  ["parakeet_tdt", "parakeet-tdt-ctc-110m-int8", false],
  ["whisper_api", "", true],
  ["groq_whisper", "", true],
  ["cartesia", "", true],
  ["web_speech", "", false],
  ["windows_native", "", false],
  ["azure_speech", "", false],
  ["sherpa_onnx", "", false],
  ["ort_streaming", "", false],
  ["deepgram", "", false],
  ["whisper_cpp", "ggml-small.bin", true],
  ["whisper_cpp", "ggml-base.en.bin", false],
];

describe("AUTO_DETECT_CASES (shared with Rust)", () => {
  it.each(AUTO_DETECT_CASES)("%s / %s -> %s", (provider, model, expected) => {
    expect(supportsSTTAutoDetection(provider, model)).toBe(expected);
    const problem = autoDetectProblem({ provider, localModel: model || undefined }, { deepgram: model }, "You");
    expect(problem === null).toBe(expected);
  });
});

describe("autoDetectProblem", () => {
  it("names the side, the provider and what to change", () => {
    expect(autoDetectProblem({ provider: "web_speech" }, {}, "You")).toBe(
      "Auto-detect doesn't work with Web Speech, used for You. " +
      "Choose Deepgram Nova-3, Whisper or Parakeet TDT 0.6B v3 for that side, or pick a language."
    );
    expect(autoDetectProblem({ provider: "deepgram" }, { deepgram: "nova-2" }, "Room")).toContain(
      "Deepgram nova-2, used for Room"
    );
    expect(autoDetectProblem({ provider: "whisper_cpp", localModel: "distil-large-v3" }, {}, "Them")).toContain(
      "the distil-large-v3 Whisper model, used for Them"
    );
  });

  it("uses the model a side falls back to", () => {
    expect(autoDetectProblem({ provider: "whisper_cpp" }, { whisperCpp: "small" }, "You")).toBeNull();
    expect(autoDetectProblem({ provider: "parakeet_tdt" }, { parakeet: "parakeet-tdt-ctc-110m-int8" }, "You"))
      .toContain("Parakeet CTC 110M");
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
    expect(unsupported).toContain("vi-VN");
    for (const lang of unsupported) {
      expect(cartesiaSupportsLanguage(lang)).toBe(false);
    }
  });
});
