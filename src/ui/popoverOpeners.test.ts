import { describe, expect, it } from "vitest";
import { keepInWindow } from "./portal";

const files = import.meta.glob(
  [
    "../overlay/dock/LayoutMenu.tsx",
    "../overlay/ContextScopePicker.tsx",
    "../overlay/SideLanguagePicker.tsx",
    "../calllog/CallLogPanel.tsx",
    "../components/ServiceStatusBar.tsx",
    "../components/AgentStatusChip.tsx",
    "../live-notes/LiveNotesPanel.tsx",
    "../live-brief/BriefPanel.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Every opener in the meeting window places its popover with the one shared helper. */
describe("popover openers use the shared placement", () => {
  const uses: Record<string, RegExp> = {
    "../overlay/dock/LayoutMenu.tsx": /<Popover\b/,
    "../calllog/CallLogPanel.tsx": /<Popover\b/,
    "../overlay/ContextScopePicker.tsx": /placeBox\(/,
    "../overlay/SideLanguagePicker.tsx": /placeBox\(/,
    "../components/ServiceStatusBar.tsx": /useKeepInWindow\(/,
    "../components/AgentStatusChip.tsx": /useKeepInWindow\(/,
    // notes and brief options are ui Menu, which places with placeBox
    "../live-notes/LiveNotesPanel.tsx": /<Menu\b/,
    "../live-brief/BriefPanel.tsx": /<Menu\b/,
  };
  for (const [file, re] of Object.entries(uses)) {
    it(file, () => {
      expect(files[file]).toMatch(re);
    });
  }
  it("none of them hand-places with a fixed right-0/left-0 offset any more", () => {
    expect(files["../overlay/dock/LayoutMenu.tsx"]).not.toMatch(/absolute right-0 top-full/);
    expect(files["../calllog/CallLogPanel.tsx"]).not.toMatch(/absolute right-0 top-full/);
  });
});

describe("keepInWindow", () => {
  const rectOf = (l: number, t: number, w: number, h: number) =>
    ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t, toJSON: () => ({}) }) as DOMRect;

  it("shifts a popover that hangs off the right edge back in", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 420 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });
    const el = document.createElement("div");
    el.getBoundingClientRect = () => rectOf(300, 100, 288, 200);
    keepInWindow(el);
    expect(el.style.translate).toBe("-176px");
  });

  it("lifts one that hangs off the bottom and caps one taller than the window", () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => rectOf(20, 300, 200, 500);
    keepInWindow(el);
    expect(el.style.maxHeight).toBe("404px");
    expect(el.style.translate).toMatch(/-\d+px$/);
  });
});
