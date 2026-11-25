import { describe, expect, it } from "vitest";
import { OVERLAY_MOTION_CSS as css } from "./overlayMotion";
import conf from "../../src-tauri/tauri.conf.json";

describe("the transparent meeting window does not animate forever", () => {
  it("limits a pulse or ping inside it to a few cycles (an endless one cost 15 to 20% of a core)", () => {
    expect(css).toMatch(/\.overlay-bg \.animate-pulse\s*\{[^}]*animation-iteration-count:\s*3/);
    expect(css).toMatch(/\.overlay-bg \.animate-ping\s*\{[^}]*animation-iteration-count:\s*3/);
  });
});

describe("the meeting window's size matches the guide", () => {
  it("opens at 500x700, smallest 400x480", () => {
    const w = (conf as { app: { windows: Array<{ label: string; width: number; height: number; minWidth: number; minHeight: number }> } }).app.windows.find((x) => x.label === "overlay")!;
    expect([w.width, w.height, w.minWidth, w.minHeight]).toEqual([500, 700, 400, 480]);
  });
});
