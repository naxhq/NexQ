import type { SourceChip } from "./types";

/** One chip per source: keyed on kind, label and path, in first-seen order. */
export function dedupeChips(chips: SourceChip[]): SourceChip[] {
  const seen = new Set<string>();
  const out: SourceChip[] = [];
  for (const chip of chips) {
    const key = `${chip.kind}\u0000${chip.label}\u0000${chip.path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chip);
  }
  return out;
}
