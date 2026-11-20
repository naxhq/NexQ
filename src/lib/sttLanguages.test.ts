import { describe, expect, it } from "vitest";
import type { STTProviderType } from "./types";
import cases from "./autoDetectCases.json";
import {
  AUTO_DETECT_REFUSAL_PREFIX,
  STT_LANGUAGES,
  autoDetectProblem,
  cartesiaSupportsLanguage,
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
      "Auto-detect doesn't work with the distil-large-v3 Whisper model, used for Them. " +
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
