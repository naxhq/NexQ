import { describe, expect, it } from "vitest";
import type { MeetingAudioConfig } from "./types";
import { languageLabel, languageShortLabel, sideLanguageProblems, sideNotice, updatePartyConfig } from "./sideLanguage";

const config: MeetingAudioConfig = {
  you: { role: "You", device_id: "mic", is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: "out", is_input_device: false, stt_provider: "deepgram", language: "fr-FR" },
  recording_enabled: false,
  preset_name: "Interview",
};

describe("updatePartyConfig", () => {
  it("sets one side's language and leaves the other side and the rest alone", () => {
    const next = updatePartyConfig(config, "you", { language: "de-DE" });
    expect(next.you.language).toBe("de-DE");
    expect(next.them).toBe(config.them);
    expect(next.recording_enabled).toBe(false);
    expect(next.preset_name).toBeNull();
  });

  it("drops the language key for Default, so the saved shape matches older versions", () => {
    const next = updatePartyConfig(config, "them", { language: undefined });
    expect("language" in next.them).toBe(false);
    expect(updatePartyConfig(config, "them", { language: "" }).them).not.toHaveProperty("language");
  });

  it("does not change the config it was given", () => {
    updatePartyConfig(config, "them", { language: undefined });
    expect(config.them.language).toBe("fr-FR");
  });
});

describe("sideLanguageProblems / sideNotice", () => {
  const models = { deepgram: "flux-general-en" };
  const party = config.you;

  it("flags a language the provider can't do", () => {
    const problems = sideLanguageProblems(party, "fr-FR", models, "You");
    expect(problems.auto).toBeNull();
    expect(sideNotice(problems)).toMatchObject({ tone: "warning", text: expect.stringContaining("English only") });
  });

  it("flags Auto-detect the provider can't do, ahead of any hint", () => {
    const problems = sideLanguageProblems(party, "auto", models, "Room");
    expect(problems.auto).toContain("used for Room.");
    expect(sideNotice(problems)).toEqual({ tone: "warning", text: problems.auto });
  });

  it("has no notice when all is well", () => {
    expect(sideNotice(sideLanguageProblems(party, "en-US", { deepgram: "nova-3" }, "You"))).toBeNull();
  });
});

describe("labels", () => {
  it("names languages and shortens them for a chip", () => {
    expect(languageLabel("en-US")).toBe("English (US)");
    expect(languageLabel("xx-XX")).toBe("xx-XX");
    expect(languageShortLabel("auto")).toBe("Auto");
    expect(languageShortLabel("pt-BR")).toBe("PT-BR");
  });
});
