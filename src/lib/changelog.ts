// Release notes for the update dialog. An update can jump several versions, so
// the dialog shows every release between the running version and the update.

import { parseChangelog, type ChangelogRelease } from "./releaseNotes.mjs";

export { formatReleaseDate, parseChangelog } from "./releaseNotes.mjs";
export type { ChangelogRelease, ChangelogSection } from "./releaseNotes.mjs";

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Releases after `from`, up to and including `to`, as listed in the changelog. */
export function releasesBetween(
  releases: ChangelogRelease[],
  from: string,
  to: string,
): ChangelogRelease[] {
  return releases.filter(
    (r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0,
  );
}

export function changelogUrl(version: string): string {
  return `https://raw.githubusercontent.com/naxhq/NexQ/v${version}/CHANGELOG.md`;
}

const FETCH_LIMIT_MS = 8_000;

/** What changed between the running version and the update. Throws if it can't be read. */
export async function fetchReleaseNotes(from: string, to: string): Promise<ChangelogRelease[]> {
  const response = await fetch(changelogUrl(to), { signal: AbortSignal.timeout(FETCH_LIMIT_MS) });
  if (!response.ok) throw new Error(`Changelog request failed: ${response.status}`);
  return releasesBetween(parseChangelog(await response.text()), from, to);
}
