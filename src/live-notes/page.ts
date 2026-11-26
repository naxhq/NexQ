// The notes document as a page: topic sections, windowing, diffs, Markdown.
import type { NoteBlock, NoteBlockType, NoteDoc } from "../lib/types";
import { plainText } from "./entities";

export interface Section {
  /** null for lines written before any topic (or whose topic is gone). */
  topic: NoteBlock | null;
  lead: NoteBlock[];
  items: NoteBlock[];
}

/** Summary lines lead the section; everything else keeps document order. */
export function buildSections(blocks: NoteBlock[]): Section[] {
  const sections: Section[] = [];
  const byTopic = new Map<string, Section>();
  const orphans: Section = { topic: null, lead: [], items: [] };
  for (const b of blocks) {
    if (b.type === "topic") {
      const s: Section = { topic: b, lead: [], items: [] };
      byTopic.set(b.id, s);
      sections.push(s);
    }
  }
  for (const b of blocks) {
    if (b.type === "topic") continue;
    const s = (b.parent && byTopic.get(b.parent)) || orphans;
    (b.type === "summary" ? s.lead : s.items).push(b);
  }
  const hasOrphans = orphans.lead.length + orphans.items.length > 0;
  return hasOrphans ? [orphans, ...sections] : sections;
}

export const WINDOW_STEP = 300;

export function sectionSize(s: Section): number {
  return (s.topic ? 1 : 0) + s.lead.length + s.items.length;
}

/**
 * Long meetings: keep the newest sections whose total reaches `limit` lines
 * (always whole sections, at least one). `hidden` is how many lines are folded.
 */
export function windowSections(sections: Section[], limit: number): { shown: Section[]; hidden: number } {
  let count = 0;
  let from = sections.length;
  while (from > 0 && count < limit) {
    from -= 1;
    count += sectionSize(sections[from]);
  }
  let hidden = 0;
  for (let i = 0; i < from; i++) hidden += sectionSize(sections[i]);
  return { shown: sections.slice(from), hidden };
}

export function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** The moment a topic starts: its own time, else the earliest line under it. */
export function topicTime(s: Section): number | null {
  if (s.topic?.t != null) return s.topic.t;
  const times = [...s.lead, ...s.items].map((b) => b.t).filter((t): t is number => t != null);
  return times.length ? Math.min(...times) : null;
}

export interface DocDiff {
  added: string[];
  changed: string[];
}

/** Which lines are new or have new words since the last version. */
export function diffDocs(prev: NoteDoc | null, next: NoteDoc): DocDiff {
  const before = new Map((prev?.blocks ?? []).map((b) => [b.id, b]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const b of next.blocks) {
    const old = before.get(b.id);
    if (!old) added.push(b.id);
    else if (old.text !== b.text || old.type !== b.type) changed.push(b.id);
  }
  return { added, changed };
}

export const TYPE_LABEL: Record<NoteBlockType, string> = {
  topic: "Topic",
  summary: "Summary",
  bullet: "Note",
  decision: "Decision",
  task: "Task",
  question: "Question",
};

/** Clean Markdown: no entity tags, no checkboxes (items are not ticked). */
export function docToMarkdown(doc: NoteDoc | null, title?: string): string {
  if (!doc || doc.blocks.length === 0) return "";
  const one = (s: string) => plainText(s).replace(/\s*\n\s*/g, " ").trim();
  const lines: string[] = [];
  if (title) lines.push(`# ${one(title)}`, "");
  for (const s of buildSections(doc.blocks)) {
    if (s.topic) {
      const t = formatClock(topicTime(s));
      lines.push(`## ${one(s.topic.text)}${t ? ` (${t})` : ""}`, "");
    }
    for (const b of s.lead) lines.push(one(b.text), "");
    for (const b of s.items) {
      const text = one(b.text);
      lines.push(b.type === "bullet" ? `- ${text}` : `- **${TYPE_LABEL[b.type]}:** ${text}`);
    }
    if (s.items.length) lines.push("");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

export function blockToMarkdown(b: NoteBlock): string {
  const text = plainText(b.text).replace(/\s*\n\s*/g, " ").trim();
  if (b.type === "topic") return `## ${text}`;
  if (b.type === "summary") return text;
  return b.type === "bullet" ? `- ${text}` : `- **${TYPE_LABEL[b.type]}:** ${text}`;
}
