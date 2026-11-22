import { describe, expect, it } from "vitest";
import { countOpusMtLanguages, opusMtDescription } from "./opusMt";
import type { OpusMtModelStatus } from "./types";

function model(source_lang: string, target_lang: string): OpusMtModelStatus {
  return { definition: { source_lang, target_lang } } as OpusMtModelStatus;
}

describe("opusMtDescription", () => {
  it("shows no count before the model list loads", () => {
    expect(opusMtDescription([])).toBe("Fully offline · Private");
  });

  it("counts models and distinct languages from the list", () => {
    const models = [model("en", "es"), model("en", "fr"), model("es", "en"), model("fr", "en")];
    expect(countOpusMtLanguages(models)).toBe(3);
    expect(opusMtDescription(models)).toBe("4 models · 3 langs · Fully offline · Private");
  });
});
