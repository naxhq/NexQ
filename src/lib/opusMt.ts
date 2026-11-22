import type { OpusMtModelStatus } from "./types";

/** Number of languages covered by the offered OPUS-MT models (both directions). */
export function countOpusMtLanguages(models: OpusMtModelStatus[]): number {
  const langs = new Set<string>();
  for (const m of models) {
    langs.add(m.definition.source_lang);
    langs.add(m.definition.target_lang);
  }
  return langs.size;
}

/**
 * Provider-card blurb for OPUS-MT, derived from the model list the backend
 * offers so it cannot drift from it. Before the list loads (or if it fails)
 * only the claims that never change are shown.
 */
export function opusMtDescription(models: OpusMtModelStatus[]): string {
  const suffix = "Fully offline · Private";
  if (models.length === 0) return suffix;
  return `${models.length} models · ${countOpusMtLanguages(models)} langs · ${suffix}`;
}
