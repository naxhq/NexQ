// `strip_hidden` is written twice (Rust in prompt_data.rs, TypeScript in instructionText.ts). This
// test runs the TypeScript one over every code point (0..10FFFF, surrogates apart) in nine contexts,
// hashes what comes out and compares it with the committed hash that the Rust test checks too.
import { describe, expect, it } from "vitest";
import table from "./vectors/strip_hidden_table.json";
import { stripHidden } from "../workspace/chat/instructionText";

const PREFIX_SUFFIX: Array<[number[], number[]]> = [
  [[], []],
  [[0x61], [0x61]],
  [[0x6cc], [0x62e]],
  [[0x8fbb], []],
  [[0x2764], [0x1f525]],
  [[0x31], [0x20e3]],
  [[0xe2a], [0xe14]],
  [[0x647], [0x20]],
  [[0xd28, 0xd4d], [0x20]],
];

function tableHash(): string {
  let h = 2166136261;
  const mix = (v: number) => {
    h = Math.imul(h ^ v, 16777619) >>> 0;
  };
  for (const [pre, post] of PREFIX_SUFFIX) {
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const text = String.fromCodePoint(...pre, cp, ...post);
      mix(cp);
      for (const ch of stripHidden(text)) mix(ch.codePointAt(0)! + 1);
      mix(0x7fffffff);
    }
  }
  return h.toString(16).padStart(8, "0");
}

describe("strip_hidden", () => {
  it("answers the same for every code point as the Rust function (committed hash)", () => {
    expect(tableHash()).toBe(table.hash);
  }, 180_000);

  it("removes an unpaired surrogate, keeps private-use and the Arabic number signs, and turns U+2028 into a newline", () => {
    expect(stripHidden("a\ud800b")).toBe("ab");
    expect(stripHidden("ab")).toBe("ab");
    expect(stripHidden("؀123")).toBe("؀123");
    expect(stripHidden("a b c")).toBe("a\nb\nc");
    expect(stripHidden("a￾b\u{1ffff}c﷐d")).toBe("abcd");
  });
});
