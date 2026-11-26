// Inline entity tags in note text: {{p:Name}} {{l:Place}} {{o:Org}} {{d:Date}} {{n:Number}}.
// Text is only ever rendered as React text nodes (never as HTML), so a tag or a
// string like "<img onerror=...>" can't inject markup; this file only splits it.

export type EntityKind = "person" | "place" | "org" | "date" | "number";

export type Inline = { text: string } | { entity: EntityKind; text: string };

const KIND_OF: Record<string, EntityKind> = {
  p: "person",
  l: "place",
  o: "org",
  d: "date",
  n: "number",
};
const TAG_OF: Record<EntityKind, string> = { person: "p", place: "l", org: "o", date: "d", number: "n" };

const TAG = /\{\{\s*([a-zA-Z])\s*:\s*([^{}]*?)\s*\}\}/g;
// A tag cut off by a token limit, or a stray bracket pair.
const STRAY_OPEN = /\{\{\s*[a-zA-Z]\s*:\s*/g;
const STRAY = /\{\{|\}\}/g;

function cleanStray(s: string): string {
  return s.replace(STRAY_OPEN, "").replace(STRAY, "");
}

/** Split text into plain runs and tagged entities. Unknown tag letters become plain text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (t: string) => {
    const c = cleanStray(t);
    if (c) out.push({ text: c });
  };
  for (const m of text.matchAll(TAG)) {
    const at = m.index ?? 0;
    push(text.slice(last, at));
    const kind = KIND_OF[m[1].toLowerCase()];
    const value = m[2];
    if (value) out.push(kind ? { entity: kind, text: value } : { text: value });
    last = at + m[0].length;
  }
  push(text.slice(last));
  return out;
}

/** The words only: no tags. What the editor shows, what Markdown and copy use. */
export function plainText(text: string): string {
  return parseInline(text)
    .map((p) => p.text)
    .join("");
}

/** Entities in a text, in order. */
export function entitiesOf(text: string): Array<{ kind: EntityKind; value: string }> {
  const list: Array<{ kind: EntityKind; value: string }> = [];
  for (const p of parseInline(text)) if ("entity" in p) list.push({ kind: p.entity, value: p.text });
  return list;
}

/**
 * After the user edits the plain words, put back the tags of every entity that is
 * still there (first untagged whole-word occurrence), so colours survive an edit.
 */
export function retag(edited: string, original: string): string {
  let result = edited.replace(/\{\{|\}\}/g, "");
  for (const e of entitiesOf(original)) {
    const esc = e.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc})(?![\\p{L}\\p{N}])`, "u");
    const tagged = `{{${TAG_OF[e.kind]}:${e.value}}}`;
    if (result.includes(tagged)) continue;
    // Skip text that is already inside a tag we just wrote.
    const m = re.exec(result);
    if (m) result = result.slice(0, m.index + m[1].length) + tagged + result.slice(m.index + m[1].length + e.value.length);
  }
  return result;
}
