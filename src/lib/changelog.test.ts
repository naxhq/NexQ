import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changelogUrl,
  compareVersions,
  fetchReleaseNotes,
  formatReleaseDate,
  parseChangelog,
  releasesBetween,
} from "./changelog";

const SAMPLE = `# [2.34.0](https://github.com/naxhq/NexQ/compare/v2.33.0...v2.34.0) (2026-11-05)


### Bug Fixes

* **llm:** a custom endpoint shows its real error ([#79](https://github.com/naxhq/NexQ/issues/79)) ([010a632](https://github.com/naxhq/NexQ/commit/010a632)), closes [#78](https://github.com/naxhq/NexQ/issues/78)


### Features

* **stt:** Auto-Answer replies as soon as the speaker finished ([#77](https://github.com/naxhq/NexQ/issues/77)) ([7127c1b](https://github.com/naxhq/NexQ/commit/7127c1b))
# [2.33.0](https://github.com/naxhq/NexQ/compare/v2.32.0...v2.33.0) (2026-11-04)


### Performance Improvements

* remove a slow path ([24b4598](https://github.com/naxhq/NexQ/commit/24b4598))

## [2.29.1](https://github.com/naxhq/NexQ/compare/v2.29.0...v2.29.1) (2026-10-31)


### Bug Fixes

* **overlay:** \`Esc\` closes the panel ([abc1234](https://github.com/naxhq/NexQ/commit/abc1234))
`;

describe("parseChangelog", () => {
  const releases = parseChangelog(SAMPLE);

  it("finds every release, patch headings included", () => {
    expect(releases.map((r) => r.version)).toEqual(["2.34.0", "2.33.0", "2.29.1"]);
    expect(releases[0].date).toBe("2026-11-05");
  });

  it("puts what's new before what's fixed, in plain words", () => {
    expect(releases[0].sections.map((s) => s.title)).toEqual(["New", "Fixed"]);
    expect(releases[1].sections[0].title).toBe("Faster");
  });

  it("removes scopes, links, commit hashes and issue references", () => {
    expect(releases[0].sections[1].items).toEqual(["A custom endpoint shows its real error"]);
    expect(releases[0].sections[0].items).toEqual([
      "Auto-Answer replies as soon as the speaker finished",
    ]);
    expect(releases[2].sections[0].items).toEqual(["Esc closes the panel"]);
  });

  it("returns nothing for text that isn't a changelog", () => {
    expect(parseChangelog("404: Not Found")).toEqual([]);
  });

  it("leaves out a section with nothing in it", () => {
    const [release] = parseChangelog("# [1.0.0](x) (2026-01-01)\n\n### Features\n\n### Bug Fixes\n\n* a fix\n");
    expect(release.sections.map((s) => s.title)).toEqual(["Fixed"]);
  });

  it("understands breaking changes however the heading is decorated", () => {
    for (const heading of ["### BREAKING CHANGES", "### ⚠ BREAKING CHANGES"]) {
      const [release] = parseChangelog(`# [1.0.0](x) (2026-01-01)\n\n${heading}\n\n* a change\n`);
      expect(release.sections[0].title).toBe("Changed");
    }
  });

  it("handles Windows line endings", () => {
    expect(parseChangelog(SAMPLE.replace(/\n/g, "\r\n")).map((r) => r.version)).toEqual([
      "2.34.0",
      "2.33.0",
      "2.29.1",
    ]);
  });
});

describe("compareVersions", () => {
  it("compares numbers, not text", () => {
    expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareVersions("2.9.9", "2.10.0")).toBe(-1);
    expect(compareVersions("2.34.0", "2.34.0")).toBe(0);
  });
});

describe("releasesBetween", () => {
  const releases = parseChangelog(SAMPLE);

  it("includes everything after the running version, up to the update", () => {
    expect(releasesBetween(releases, "2.29.1", "2.34.0").map((r) => r.version)).toEqual([
      "2.34.0",
      "2.33.0",
    ]);
  });

  it("leaves out anything newer than the update being installed", () => {
    expect(releasesBetween(releases, "2.29.0", "2.33.0").map((r) => r.version)).toEqual([
      "2.33.0",
      "2.29.1",
    ]);
  });
});

describe("formatReleaseDate", () => {
  it("shows the date as written, whatever the time zone", () => {
    expect(formatReleaseDate("2026-11-05")).toBe("Nov 5, 2026");
  });

  it("copes with a missing date", () => {
    expect(formatReleaseDate(null)).toBeNull();
  });
});

describe("fetchReleaseNotes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the changelog of the exact release being installed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE });
    vi.stubGlobal("fetch", fetchMock);

    const notes = await fetchReleaseNotes("2.29.1", "2.34.0");

    expect(fetchMock.mock.calls[0][0]).toBe(changelogUrl("2.34.0"));
    expect(notes.map((r) => r.version)).toEqual(["2.34.0", "2.33.0"]);
  });

  it("fails on a bad response instead of showing no notes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "" }));
    await expect(fetchReleaseNotes("2.29.1", "9.9.9")).rejects.toThrow("404");
  });
});
