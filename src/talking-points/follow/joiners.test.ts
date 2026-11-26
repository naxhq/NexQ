import { describe, expect, it } from "vitest";
import { buildNoteIndex, spokenWords, tokenizeText, VoiceFollower } from "./index";

const ZWNJ = "‌";

describe("joiners in notes (Persian half spaces, ZWJ)", () => {
  it("a word with a half space matches the same word spoken without one", () => {
    const written = `من می${ZWNJ}خواهم گزارش را امروز بفرستم`;
    const spoken = "من میخواهم گزارش را امروز بفرستم";
    expect(spokenWords(written)).toEqual(spokenWords(spoken));
    expect(spokenWords(`می${ZWNJ}خواهم`)).toHaveLength(1);
  });

  it("token offsets still point at the original characters, joiner included", () => {
    const text = `برنامه می${ZWNJ}خواهم`;
    const toks = tokenizeText(text);
    const last = toks[toks.length - 1];
    expect(text.slice(last.start, last.end)).toBe(`می${ZWNJ}خواهم`);
  });

  it("a lone joiner is not a word", () => {
    expect(tokenizeText(`alpha ${ZWNJ} beta`).map((t) => t.t)).toEqual(["alpha", "beta"]);
    expect(tokenizeText(ZWNJ)).toEqual([]);
  });

  it("the follower follows speech spelled without the half spaces", () => {
    const blocks = [
      { id: "a", text: `سلام به همه می${ZWNJ}خواهم امروز درباره فروش فصل گذشته صحبت کنم` },
      { id: "b", text: `درآمد ما دوازده درصد نسبت به سال گذشته رشد کرده است` },
      { id: "c", text: `استخدام چهارده مهندس جدید در سه تیم محصول انجام شد` },
    ];
    const f = new VoiceFollower(buildNoteIndex(blocks), { clock: () => 1000 });
    f.onFinal("سلام به همه میخواهم امروز درباره فروش فصل گذشته صحبت کنم", "1");
    f.onFinal("درآمد ما دوازده درصد نسبت به سال گذشته رشد کرده است", "2");
    expect(f.snapshot().position).toBeGreaterThan(14);
  });
});
