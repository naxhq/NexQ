import { describe, expect, it } from "vitest";
import { readingTextColor } from "./themeText";

describe("readingTextColor", () => {
  it("gives the theme's text colour to the untouched dark-theme defaults", () => {
    expect(readingTextColor("#e4e4e7")).toBe("hsl(var(--foreground))");
    expect(readingTextColor("#D4D4D8")).toBe("hsl(var(--foreground))");
  });
  it("keeps a colour the user chose", () => {
    expect(readingTextColor("#ff0000")).toBe("#ff0000");
  });
});
