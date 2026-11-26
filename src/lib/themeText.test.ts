import { describe, expect, it } from "vitest";
import { contrastRatio, readableOn, readingTextColor } from "./themeText";

describe("readingTextColor", () => {
  it("gives the theme's text colour to the untouched dark-theme defaults", () => {
    expect(readingTextColor("#e4e4e7")).toBe("hsl(var(--foreground))");
    expect(readingTextColor("#D4D4D8")).toBe("hsl(var(--foreground))");
  });
  it("keeps a colour the user chose", () => {
    expect(readingTextColor("#ff0000")).toBe("#ff0000");
  });
});

describe("readableOn", () => {
  it("darkens the green and orange speaker tags on the light theme to at least 4.5:1", () => {
    for (const c of ["#22c55e", "#f97316", "#fbbf24", "#3b82f6"]) {
      const r = readableOn(c, "light");
      const v = parseInt(r.slice(1), 16);
      expect(contrastRatio([(v >> 16) & 255, (v >> 8) & 255, v & 255], [250, 251, 252])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("lightens a dark colour on the dark theme", () => {
    const r = readableOn("#1d4ed8", "dark");
    const v = parseInt(r.slice(1), 16);
    expect(contrastRatio([(v >> 16) & 255, (v >> 8) & 255, v & 255], [16, 20, 32])).toBeGreaterThanOrEqual(4.5);
  });
  it("leaves a colour that already reads, and a non-hex value, alone", () => {
    expect(readableOn("#14532d", "light")).toBe("#14532d");
    expect(readableOn("hsl(var(--foreground))", "light")).toBe("hsl(var(--foreground))");
  });
});
