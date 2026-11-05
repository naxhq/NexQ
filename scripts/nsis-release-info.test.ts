import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript build script
import { nsisString, renderReleaseInfo } from "./nsis-release-info.mjs";

const CHANGELOG = `# [2.34.0](https://x/compare) (2026-11-05)


### Bug Fixes

* **llm:** a custom endpoint shows its real error ([#79](https://x/79)) ([010a632](https://x/c)), closes [#78](https://x/78)
* **a:** second fix ([1111111](https://x/c))
* **b:** third fix ([2222222](https://x/c))


### Features

* **stt:** Auto-Answer replies as soon as the speaker finished ([#77](https://x/77)) ([7127c1b](https://x/c))
# [2.33.0](https://x/compare) (2026-11-04)


### Features

* **overlay:** from an older release ([ddd4444](https://x/c))
`;

const render = (overrides = {}) =>
  renderReleaseInfo({
    version: "2.34.0",
    changelog: CHANGELOG,
    commit: "9927520",
    today: "2026-12-25",
    ...overrides,
  });

describe("nsisString", () => {
  it("escapes what NSIS would otherwise read as variables or string ends", () => {
    expect(nsisString('costs $5 and "more"')).toBe('costs $$5 and $\\"more$\\"');
  });

  it("keeps notes on one line", () => {
    expect(nsisString("one\r\ntwo\tthree")).toBe("one two three");
  });
});

describe("renderReleaseInfo", () => {
  it("describes the version being built", () => {
    const info = render();
    expect(info).toContain('!define NQ_INFO_VERSION "2.34.0"');
    expect(info).toContain('!define NQ_RELEASED "Nov 5, 2026"');
    expect(info).toContain('!define NQ_BUILD "9927520"');
  });

  it("lists what's new first, and counts what doesn't fit", () => {
    const info = render();
    const notes = info.split(/\r\n/).filter((line: string) => line.includes("NqNote"));
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain('"New" "Auto-Answer replies as soon as the speaker finished"');
    expect(notes[1]).toContain('"Fixed" "A custom endpoint shows its real error"');
    expect(info).toContain("!define NQ_NOTES_TOTAL 4");
    expect(info).toContain("!define NQ_NOTES_MORE 1");
    expect(info).not.toContain("from an older release");
  });

  it("gives a long note two lines and cuts it after that", () => {
    const long = "word ".repeat(60).trim();
    const info = render({
      changelog: `# [2.34.0](https://x) (2026-11-05)\n\n### Features\n\n* ${long} ([1111111](https://x))\n`,
    });
    const note = info.split(/\r\n/).find((line: string) => line.includes("NqNote"))!;
    expect(note).toMatch(/… *" 2$/);
    expect(note.length).toBeLessThan(160);
  });

  it("makes a changelog line safe to compile", () => {
    const info = render({
      changelog: `# [2.34.0](https://x) (2026-11-05)\n\n### Features\n\n* the "$HOME" path works ([1111111](https://x))\n`,
    });
    expect(info).toContain('The $\\"$$HOME$\\" path works');
  });

  it("still builds for a version the changelog doesn't have yet", () => {
    const info = render({ version: "9.9.9" });
    expect(info).toContain('!define NQ_RELEASED "Dec 25, 2026"');
    expect(info).toContain("!define NQ_NOTES_TOTAL 0");
  });

  it("draws the release's waveform, 72 bars from 1 to 100", () => {
    const bars = render()
      .split(/\r\n/)
      .filter((line: string) => line.includes("NqBar"))
      .map((line: string) => Number(line.trim().split(" ").pop()));
    expect(bars).toHaveLength(72);
    for (const bar of bars) {
      expect(bar).toBeGreaterThan(0);
      expect(bar).toBeLessThanOrEqual(100);
    }
  });
});
