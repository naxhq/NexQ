// Reads the CHANGELOG.md that `npm run release` generates. Used by the update
// dialog (src/lib/changelog.ts) and by the installer's build step
// (scripts/nsis-release-info.mjs), so it's plain JavaScript.

const SECTION_TITLES = {
  Features: "New",
  "Bug Fixes": "Fixed",
  "Performance Improvements": "Faster",
  "BREAKING CHANGES": "Changed",
  Reverts: "Reverted",
};

const SECTION_ORDER = ["Changed", "New", "Faster", "Fixed", "Reverted"];

const RELEASE_HEADING = /^#{1,3}\s+\[?(\d+\.\d+\.\d+)\]?(?:\(.*?\))?\s*(?:\((\d{4}-\d{2}-\d{2})\))?/;

/** A changelog line as a reader wants it: no scope, links, hashes or issue numbers. */
function cleanItem(line) {
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

function sectionRank(title) {
  const rank = SECTION_ORDER.indexOf(title);
  return rank === -1 ? SECTION_ORDER.length : rank;
}

export function parseChangelog(markdown) {
  const releases = [];
  let release = null;
  let section = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      release = { version: heading[1], date: heading[2] ?? null, sections: [] };
      releases.push(release);
      section = null;
    } else if (release && line.startsWith("### ")) {
      // Some changelog presets decorate headings, as in "⚠ BREAKING CHANGES".
      const name = line.slice(4).replace(/^[^A-Za-z]+/, "").trim();
      section = { title: SECTION_TITLES[name] ?? name, items: [] };
      release.sections.push(section);
    } else if (section && line.startsWith("* ")) {
      const item = cleanItem(line);
      if (item) section.items.push(item);
    }
  }

  for (const r of releases) {
    r.sections = r.sections
      .filter((s) => s.items.length > 0)
      .sort((a, b) => sectionRank(a.title) - sectionRank(b.title));
  }
  return releases;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatReleaseDate(date) {
  if (!date) return null;
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}
