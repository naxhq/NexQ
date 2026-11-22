// Release data, built at build time from the repo itself so the site cannot go stale:
//   - RELEASES    : parsed from the root CHANGELOG.md with the app's own parser
//   - CURRENT_VERSION : the root package.json version
//   - waveFor()   : the app's own release waveform (src/lib/releaseWave.mjs, imported, not copied)
// This module reads files, so only import it from .astro frontmatter or other build-time code,
// never from a client <script>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog, formatReleaseDate } from '../../../src/lib/releaseNotes.mjs';
import { releaseWave } from '../../../src/lib/releaseWave.mjs';
import { RELEASE_ONELINERS } from './site';

export interface ReleaseEntry {
  /** Full version, e.g. "2.41.0". Also the key into RELEASE_ONELINERS. */
  version: string;
  /** ISO date, e.g. "2026-11-20", or null if the changelog has none. */
  date: string | null;
  /** Readable date, e.g. "Nov 20, 2026". */
  dateLabel: string | null;
  /** The feature lines for this release, cleaned for readers (no scope, links or hashes). */
  items: string[];
  /** Hand-written one-liner from RELEASE_ONELINERS, if there is one. */
  oneLiner?: string;
}

/** Oldest version the timeline shows. */
const FIRST_VERSION = [2, 22, 0];
/** Changelog scopes that are about the site or housekeeping, not the product. */
const HIDDEN_SCOPE = /^\*\s+\*\*(website|deps|release)(\([^)]*\))?:\*\*/;

/**
 * Find the repo root. Astro bundles page code into dist/, so import.meta.url is not a
 * reliable anchor; try the working directory first (`npx astro build` runs in website/),
 * then the source location.
 */
function findRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(process.cwd(), '..'), process.cwd(), path.resolve(here, '../../..')];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'CHANGELOG.md')) && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
  }
  throw new Error(`NexQ repo root not found (looked in: ${candidates.join(', ')})`);
}

const ROOT = findRepoRoot();

function atLeastFirst(version: string): boolean {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) !== FIRST_VERSION[i]) return (parts[i] ?? 0) > FIRST_VERSION[i];
  }
  return true;
}

function loadReleases(): ReleaseEntry[] {
  const markdown = fs
    .readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !HIDDEN_SCOPE.test(line))
    .join('\n');

  const out: ReleaseEntry[] = [];
  for (const release of parseChangelog(markdown)) {
    if (!atLeastFirst(release.version)) continue;
    const items: string[] = release.sections.find((s: { title: string }) => s.title === 'New')?.items ?? [];
    if (items.length === 0) continue;
    out.push({
      version: release.version,
      date: release.date,
      dateLabel: formatReleaseDate(release.date),
      items,
      oneLiner: RELEASE_ONELINERS[release.version],
    });
  }
  return out; // the changelog is already newest first
}

/** Releases with new features since 2.22.0, newest first. */
export const RELEASES: ReleaseEntry[] = loadReleases();

/** Version of the app today (root package.json), e.g. "2.41.2". */
export const CURRENT_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
).version;

// Build-time checks: a stale or mistyped data file should fail the build, not ship a wrong page.
const minor = (v: string) => v.split('.').slice(0, 2).join('.');
if (RELEASES.length === 0) {
  throw new Error('releases.ts: no releases parsed from CHANGELOG.md (is the format still "## [x.y.z]" with a "New" section?)');
}
for (const key of Object.keys(RELEASE_ONELINERS)) {
  if (!RELEASES.some((r) => r.version === key)) {
    throw new Error(`releases.ts: RELEASE_ONELINERS has "${key}" but CHANGELOG.md has no such release with new features. Fix or remove it in data/site.ts.`);
  }
}
if (minor(RELEASES[0].version) !== minor(CURRENT_VERSION)) {
  throw new Error(
    `releases.ts: the newest release with features is v${RELEASES[0].version}, but package.json is v${CURRENT_VERSION}. The timeline would not show the current minor release.`,
  );
}

/**
 * The release's waveform: bar heights 0..1, the same shape the app's update dialog and
 * installer show for that version. Seed with the full version string ("2.41.2").
 */
export function waveFor(version: string, count = 72): number[] {
  return releaseWave(version, count);
}
