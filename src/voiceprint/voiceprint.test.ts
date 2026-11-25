import { describe, expect, it } from "vitest";
import { voiceprint, VOICEPRINT_BARS } from "./voiceprint";

describe("voiceprint", () => {
  it("is seven bars between 0.12 and 1, and always the same for the same id", () => {
    const a = voiceprint("general");
    expect(a).toHaveLength(VOICEPRINT_BARS);
    expect(a.every((h) => h >= 0.12 && h <= 1)).toBe(true);
    expect(voiceprint("general")).toEqual(a);
  });

  it("uses the whole range, so no mark is a flat row", () => {
    for (let i = 0; i < 100; i++) {
      const bars = voiceprint(`ws-${i}`);
      expect(Math.max(...bars) - Math.min(...bars)).toBeGreaterThan(0.6);
    }
  });

  it("gives 500 different ids 500 different shapes", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (let i = 0; i < 500; i++) {
      const id = `${i.toString(16).padStart(8, "0")}-${(i * 2654435761 >>> 0).toString(16)}-4f2a-9c1d`;
      const key = voiceprint(id).join(",");
      if (seen.has(key)) collisions.push(`${seen.get(key)} = ${id}`);
      seen.set(key, id);
    }
    expect(collisions).toEqual([]);
  });

  it("handles the empty id", () => {
    expect(voiceprint("")).toHaveLength(VOICEPRINT_BARS);
  });
});
