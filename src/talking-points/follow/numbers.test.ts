import { describe, it, expect } from "vitest";
import { tokenizeText } from "./tokenize";

const toks = (s: string) => tokenizeText(s).map((t) => t.t);

describe("number and phrase normalisation", () => {
  it("money, acronyms, quarters, dates", () => {
    expect(toks("$4.2M")).toEqual(["4.2", "million"]);
    expect(toks("four point two million")).toEqual(["4.2", "million"]);
    expect(toks("Q3")).toEqual(toks("third quarter"));
    expect(toks("Q3")).toEqual(toks("quarter three"));
    expect(toks("a r r")).toEqual(["arr"]);
    expect(toks("5th of March")).toEqual(toks("March fifth"));
    expect(toks("twenty first")).toEqual(["21"]);
  });
  it("number words in es, de, fr, pt", () => {
    expect(toks("treinta y cinco")).toEqual(["35"]);
    expect(toks("veintitres")).toEqual(["23"]);
    expect(toks("fünfundzwanzig")).toEqual(["25"]);
    expect(toks("dreizehn")).toEqual(["13"]);
    expect(toks("quatre-vingt-dix-sept")).toEqual(["97"]);
    expect(toks("soixante-douze")).toEqual(["72"]);
    expect(toks("vinte e cinco")).toEqual(["25"]);
    expect(toks("ciento veinte")).toEqual(["120"]);
  });
  it("kanji numerals only where they are numbers", () => {
    expect(toks("二十パーセント")).toContain("20");
    expect(toks("二〇二六年")).toContain("2026");
    expect(toks("十二名")).toContain("12");
    expect(toks("第一四半期")).not.toContain("14");
  });
  it("Hangul and Han bigrams carry weights", () => {
    expect(toks("매출은 성장했습니다")).toEqual(["매출", "성장"]); // particle and ending stripped
    expect(toks("百分之二十")).toEqual(["20", "pct"]);
    expect(tokenizeText("の").length).toBe(1);
  });
});
