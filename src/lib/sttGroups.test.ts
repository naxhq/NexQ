import { describe, expect, it } from "vitest";
import { STT_GROUPS, sttGroup } from "./sttGroups";
import { BUILT_IN_PRESETS } from "../settings/presets";

describe("speech engine groups", () => {
  it("never list an engine that sends audio online as on this computer", () => {
    expect(sttGroup("web_speech")).toBe("builtin");
    expect(sttGroup("windows_native")).toBe("builtin");
    expect(sttGroup("deepgram")).toBe("cloud");
    expect(sttGroup("whisper_api")).toBe("cloud");
  });

  it("keep the local engines on this computer", () => {
    for (const p of ["sherpa_onnx", "ort_streaming", "whisper_cpp", "parakeet_tdt"] as const) {
      expect(sttGroup(p), p).toBe("device");
    }
  });

  it("say that built-in audio goes online", () => {
    expect(STT_GROUPS.find((g) => g.id === "builtin")?.note).toMatch(/online/i);
  });

  it("let presets claim private, offline or local only when both sides run on this computer", () => {
    for (const p of BUILT_IN_PRESETS) {
      if (sttGroup(p.you.stt) === "device" && sttGroup(p.them.stt) === "device") continue;
      expect(`${p.name} ${p.description}`, p.name).not.toMatch(/private|offline|local/i);
    }
  });
});
