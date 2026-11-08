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

export function parseChangelog(markdown: string): ChangelogRelease[];
export function formatReleaseDate(date: string | null | undefined): string | null;
