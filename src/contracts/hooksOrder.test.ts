// A hook below an early return breaks React the first time the early branch is taken.
// No linter runs in this repo, so this reads the panels and checks the rule they broke once.
import { describe, expect, it } from "vitest";
import notes from "../live-notes/LiveNotesPanel.tsx?raw";
import brief from "../live-brief/BriefPanel.tsx?raw";

function hooksAfterEarlyReturn(raw: string, component: string): string[] {
  const source = raw.split(String.fromCharCode(13)).join("");
  const start = source.indexOf(`export function ${component}(`);
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^ {2}if \(.*\) \{?$/.test(l) && /return/.test(lines[lines.indexOf(l) + 1] ?? l));
  if (at < 0) return ["no early return found: update this test"];
  return lines
    .slice(at)
    .filter((l) => /^ {2}(const .* = |)(use[A-Z]\w*|\w+\.use\w*|store)\(/.test(l) && !/store\.getState/.test(l))
    .map((l) => l.trim());
}

describe("hook order", () => {
  it.each([
    ["NotesPanel", notes],
    ["BriefPanel", brief],
  ])("%s calls no hook after its early return", (name, source) => {
    expect(hooksAfterEarlyReturn(source, name)).toEqual([]);
  });
});
