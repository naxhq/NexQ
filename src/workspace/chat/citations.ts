import type { WorkspaceCitation } from "../../lib/types";
import { displayTitle } from "./titles";

/** Markdown links with this scheme are citations; the answer renderer turns them into chips. */
export const CITE_SCHEME = "nexq-cite:";

const CITE = /\[(S\d+(?:\s*,\s*S\d+)*)\]/g;
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

/** `[S1]` and `[S1, S2]` become links, except inside code. Unknown tags are left as text by the renderer. */
export function linkCitations(markdown: string): string {
  return markdown
    .split(CODE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(CITE, (_all, tags: string) =>
            tags
              .split(",")
              .map((t) => t.trim())
              .map((t) => `[${t}](${CITE_SCHEME}${t})`)
              .join(""),
          ),
    )
    .join("");
}

/** 75_000 -> "1:15", 3_725_000 -> "1:02:05". */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Where a citation points, in words: "Weekly sync at 12:41", "Pricing.pdf". */
export function citationWhere(c: WorkspaceCitation): string {
  const title = displayTitle(c.title, c.ref_id);
  if (c.kind === "transcript") return c.start_ms != null ? `${title} at ${formatMs(c.start_ms)}` : title;
  return title;
}

export function citationKindName(c: WorkspaceCitation): string {
  switch (c.kind) {
    case "transcript":
      return "Meeting";
    case "document":
      return "Document";
    case "folder":
      return "Folder file";
    default:
      return "Talking point";
  }
}

/** A citation tag that is in the saved list, else null. */
export function findCitation(list: WorkspaceCitation[], tag: string): WorkspaceCitation | null {
  return list.find((c) => c.tag === tag) ?? null;
}
