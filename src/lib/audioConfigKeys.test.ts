import { expect, it } from "vitest";
import { languageOnlyChange, type AppliedAudioConfig } from "./audioConfigKeys";
import type { MeetingAudioConfig } from "./types";

const cfg: MeetingAudioConfig = {
  you: { role: "You", device_id: "default", is_input_device: true, stt_provider: "deepgram" },
  them: { role: "Them", device_id: "default", is_input_device: false, stt_provider: "deepgram" },
  recording_enabled: true,
  preset_name: null,
};
const running: AppliedAudioConfig = { cfg, shared: "en-US" };

it("names the one side whose language changed", () => {
  const them = { cfg: { ...cfg, them: { ...cfg.them, language: "es-ES" } }, shared: "en-US" };
  expect(languageOnlyChange(running, them)).toBe("them");
  const you = { cfg: { ...cfg, you: { ...cfg.you, language: "auto" } }, shared: "en-US" };
  expect(languageOnlyChange(running, you)).toBe("you");
});

it("counts each side's effective language, own or shared", () => {
  // The shared language moves only the side without its own language.
  const own = { cfg: { ...cfg, you: { ...cfg.you, language: "fr-FR" } }, shared: "en-US" };
  expect(languageOnlyChange(own, { cfg: own.cfg, shared: "auto" })).toBe("them");
  // Both sides follow the shared language: both change.
  expect(languageOnlyChange(running, { cfg, shared: "auto" })).toBeNull();
  // An own language equal to the shared one is no change.
  const same = { cfg: { ...cfg, them: { ...cfg.them, language: "en-US" } }, shared: "en-US" };
  expect(languageOnlyChange(running, same)).toBeNull();
});

it("is null when anything but a language differs", () => {
  const provider = {
    cfg: { ...cfg, them: { ...cfg.them, language: "es-ES", stt_provider: "groq_whisper" as const } },
    shared: "en-US",
  };
  expect(languageOnlyChange(running, provider)).toBeNull();
  const device = {
    cfg: { ...cfg, you: { ...cfg.you, language: "es-ES", device_id: "mic-2" } },
    shared: "en-US",
  };
  expect(languageOnlyChange(running, device)).toBeNull();
  const recording = { cfg: { ...cfg, recording_enabled: false, them: { ...cfg.them, language: "es-ES" } }, shared: "en-US" };
  expect(languageOnlyChange(running, recording)).toBeNull();
});

it("is null when both sides' languages change", () => {
  const both = {
    cfg: { ...cfg, you: { ...cfg.you, language: "fr-FR" }, them: { ...cfg.them, language: "es-ES" } },
    shared: "en-US",
  };
  expect(languageOnlyChange(running, both)).toBeNull();
});
