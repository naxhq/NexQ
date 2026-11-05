// Release notes for the update dialog, read from the CHANGELOG.md that
// `npm run release` generates. An update can jump several versions, so the
// dialog shows every release between the running version and the update.

export interface ChangelogSection {
  /** "New", "Fixed", ... */
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  version: string;
  /** yyyy-mm-dd, as written in the heading. */
  date: string | null;
  sections: ChangelogSection[];
}

const SECTION_TITLES: Record<string, string> = {
  Features: "New",
  "Bug Fixes": "Fixed",
  "Performance Improvements": "Faster",
  "BREAKING CHANGES": "Changed",
  Reverts: "Reverted",
};

const SECTION_ORDER = ["Changed", "New", "Faster", "Fixed", "Reverted"];

const RELEASE_HEADING = /^#{1,3}\s+\[?(\d+\.\d+\.\d+)\]?(?:\(.*?\))?\s*(?:\((\d{4}-\d{2}-\d{2})\))?/;

/** A changelog line as a reader wants it: no scope, links, hashes or issue numbers. */
function cleanItem(line: string): string {
  const text = line
    .replace(/^\*\s+/, "")
    .replace(/^\*\*[^*]+:\*\*\s*/, "")
    .replace(/,?\s*closes\s+\[?#\d.*$/i, "")
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sectionRank(title: string): number {
  const rank = SECTION_ORDER.indexOf(title);
  return rank === -1 ? SECTION_ORDER.length : rank;
}

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      release = { version: heading[1], date: heading[2] ?? null, sections: [] };
      releases.push(release);
      section = null;
    } else if (release && line.startsWith("### ")) {
      const name = line.slice(4).trim();
      section = { title: SECTION_TITLES[name] ?? name, items: [] };
      release.sections.push(section);
    } else if (section && line.startsWith("* ")) {
      const item = cleanItem(line);
      if (item) section.items.push(item);
    }
  }

  for (const r of releases) {
    r.sections.sort((a, b) => sectionRank(a.title) - sectionRank(b.title));
  }
  return releases;
}

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatReleaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
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
