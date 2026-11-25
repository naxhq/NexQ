/**
 * The talking-point document: a small, strict subset of TipTap's JSON.
 *
 * This module has no TipTap in it. The reader, the store, Markdown import and the
 * "said it" blocks all work on this model, so the editor chunk loads only when
 * someone edits. Everything that enters (saved text, paste results, imports) is
 * passed through `sanitizeDoc`, which keeps only what the schema allows.
 */
import type { NoteBlock } from "../follow";

export const COLOR_NAMES = ["blue", "green", "amber", "red", "violet", "quiet"] as const;
export type TpColorName = (typeof COLOR_NAMES)[number];

/** Normal size has no mark. */
export const SIZE_STEPS = ["small", "large", "xlarge"] as const;
export type TpSizeStep = (typeof SIZE_STEPS)[number];

export const COLOR_LABELS: Record<TpColorName, string> = {
  blue: "Blue",
  green: "Green",
  amber: "Amber",
  red: "Red",
  violet: "Violet",
  quiet: "Quiet",
};

export const SIZE_LABELS: Record<TpSizeStep | "normal", string> = {
  small: "Small",
  normal: "Normal",
  large: "Large",
  xlarge: "Extra large",
};

export type TpMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "tpColor"; attrs: { name: TpColorName } }
  | { type: "tpSize"; attrs: { step: TpSizeStep } };

export type TpInline = { type: "text"; text: string; marks?: TpMark[] } | { type: "hardBreak" };

export interface TpParagraph {
  type: "paragraph";
  attrs: { id: string };
  content?: TpInline[];
}
export interface TpHeading {
  type: "heading";
  attrs: { id: string; level: 1 | 2 | 3 };
  content?: TpInline[];
}
export interface TpListItem {
  type: "listItem";
  content: Array<TpParagraph | TpBulletList | TpOrderedList>;
}
export interface TpBulletList {
  type: "bulletList";
  content: TpListItem[];
}
export interface TpOrderedList {
  type: "orderedList";
  attrs?: { start: number };
  content: TpListItem[];
}
export type TpBlock = TpParagraph | TpHeading | TpBulletList | TpOrderedList;

export interface TpDoc {
  type: "doc";
  content: TpBlock[];
}

export const MAX_DOC_CHARS = 400_000;
const MAX_DEPTH = 6;
const MAX_NODES = 40_000;
const MAX_TITLE = 160;

// -- ids ------------------------------------------------------------------------------------

/** A short stable id for a block. Not a secret; only has to be unique within a note. */
export function newBlockId(): string {
  const bytes = new Uint8Array(6);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = "b";
  for (const b of bytes) s += b.toString(36).padStart(2, "0");
  return s;
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function newParagraph(text = "", id = newBlockId()): TpParagraph {
  const p: TpParagraph = { type: "paragraph", attrs: { id } };
  if (text) p.content = [{ type: "text", text }];
  return p;
}

export function emptyDoc(): TpDoc {
  return { type: "doc", content: [newParagraph()] };
}

export function docFromText(text: string): TpDoc {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const content = lines.map((l) => newParagraph(l.trim() ? l : ""));
  return { type: "doc", content: content.length ? content : [newParagraph()] };
}

// -- sanitising -------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Ctx {
  seen: Set<string>;
  nodes: number;
  gen: () => string;
}

function takeId(raw: unknown, ctx: Ctx): string {
  let id = typeof raw === "string" && ID_RE.test(raw) && !ctx.seen.has(raw) ? raw : "";
  while (!id || ctx.seen.has(id)) id = ctx.gen();
  ctx.seen.add(id);
  return id;
}

function cleanMarks(raw: unknown): TpMark[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TpMark[] = [];
  const has = new Set<string>();
  for (const m of raw) {
    if (!isObj(m) || typeof m.type !== "string") continue;
    if (has.has(m.type)) continue;
    if (m.type === "bold" || m.type === "italic" || m.type === "underline") {
      out.push({ type: m.type });
      has.add(m.type);
    } else if (m.type === "tpColor" && isObj(m.attrs)) {
      const name = m.attrs.name;
      if (typeof name === "string" && (COLOR_NAMES as readonly string[]).includes(name)) {
        out.push({ type: "tpColor", attrs: { name: name as TpColorName } });
        has.add(m.type);
      }
    } else if (m.type === "tpSize" && isObj(m.attrs)) {
      const step = m.attrs.step;
      if (typeof step === "string" && (SIZE_STEPS as readonly string[]).includes(step)) {
        out.push({ type: "tpSize", attrs: { step: step as TpSizeStep } });
        has.add(m.type);
      }
    }
  }
  return out.length ? out : undefined;
}

function sameMarks(a?: TpMark[], b?: TpMark[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function cleanInline(raw: unknown, ctx: Ctx): TpInline[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TpInline[] = [];
  for (const n of raw) {
    if (!isObj(n) || ++ctx.nodes > MAX_NODES) continue;
    if (n.type === "text" && typeof n.text === "string" && n.text.length > 0) {
      const text = n.text.slice(0, 20_000);
      const marks = cleanMarks(n.marks);
      const last = out[out.length - 1];
      if (last && last.type === "text" && sameMarks(last.marks, marks)) last.text += text;
      else out.push(marks ? { type: "text", text, marks } : { type: "text", text });
    } else if (n.type === "hardBreak") {
      out.push({ type: "hardBreak" });
    }
  }
  while (out.length && out[out.length - 1].type === "hardBreak") out.pop();
  return out.length ? out : undefined;
}

function cleanParagraph(n: Json, ctx: Ctx): TpParagraph {
  const p: TpParagraph = { type: "paragraph", attrs: { id: takeId(isObj(n.attrs) ? n.attrs.id : undefined, ctx) } };
  const c = cleanInline(n.content, ctx);
  if (c) p.content = c;
  return p;
}

function cleanListItem(n: Json, ctx: Ctx, depth: number): TpListItem | null {
  const kids = Array.isArray(n.content) ? n.content : [];
  const content: TpListItem["content"] = [];
  for (const k of kids) {
    if (!isObj(k) || ++ctx.nodes > MAX_NODES) continue;
    if (k.type === "paragraph" || k.type === "heading") {
      content.push(cleanParagraph(k, ctx));
    } else if ((k.type === "bulletList" || k.type === "orderedList") && depth < MAX_DEPTH) {
      const l = cleanList(k, ctx, depth + 1);
      if (l) content.push(l);
    }
  }
  if (content.length === 0) return null;
  if (content[0].type !== "paragraph") content.unshift(newParagraph("", takeId(undefined, ctx)));
  return { type: "listItem", content };
}

function cleanList(n: Json, ctx: Ctx, depth: number): TpBulletList | TpOrderedList | null {
  const items: TpListItem[] = [];
  for (const it of Array.isArray(n.content) ? n.content : []) {
    if (!isObj(it) || it.type !== "listItem") continue;
    const li = cleanListItem(it, ctx, depth);
    if (li) items.push(li);
  }
  if (items.length === 0) return null;
  if (n.type === "orderedList") {
    const start = isObj(n.attrs) && Number.isInteger(n.attrs.start) ? Math.max(1, Math.min(9999, n.attrs.start as number)) : 1;
    return start === 1 ? { type: "orderedList", content: items } : { type: "orderedList", attrs: { start }, content: items };
  }
  return { type: "bulletList", content: items };
}

/**
 * Keeps only what the schema allows: paragraphs, headings 1-3, bullet and numbered
 * lists, bold, italic, underline, named colours and sizes, hard breaks. Anything
 * else (images, links, HTML, unknown nodes and attributes) is dropped; text is kept.
 * Every paragraph and heading gets a unique id (kept when valid and not repeated).
 */
export function sanitizeDoc(input: unknown, gen: () => string = newBlockId): TpDoc {
  let raw = input;
  if (typeof raw === "string") {
    if (raw.length > MAX_DOC_CHARS * 4) return emptyDoc();
    try {
      raw = JSON.parse(raw);
    } catch {
      return emptyDoc();
    }
  }
  if (!isObj(raw) || raw.type !== "doc" || !Array.isArray(raw.content)) return emptyDoc();
  const ctx: Ctx = { seen: new Set(), nodes: 0, gen };
  const content: TpBlock[] = [];
  for (const n of raw.content) {
    if (!isObj(n) || ++ctx.nodes > MAX_NODES) continue;
    if (n.type === "paragraph") {
      content.push(cleanParagraph(n, ctx));
    } else if (n.type === "heading") {
      const lv = isObj(n.attrs) ? Number(n.attrs.level) : 1;
      const level = (lv >= 3 ? 3 : lv <= 1 ? 1 : 2) as 1 | 2 | 3;
      const p = cleanParagraph(n, ctx);
      const h: TpHeading = { type: "heading", attrs: { id: p.attrs.id, level } };
      if (p.content) h.content = p.content;
      content.push(h);
    } else if (n.type === "bulletList" || n.type === "orderedList") {
      const l = cleanList(n, ctx, 1);
      if (l) content.push(l);
    }
  }
  if (content.length === 0) content.push(newParagraph("", takeId(undefined, ctx)));
  return { type: "doc", content };
}

export function parseDoc(json: string | null | undefined): TpDoc {
  return json ? sanitizeDoc(json) : emptyDoc();
}

export function serializeDoc(doc: TpDoc): string {
  return JSON.stringify(doc);
}

// -- reading the document -------------------------------------------------------------------

export function inlineText(content: TpInline[] | undefined): string {
  if (!content) return "";
  let s = "";
  for (const n of content) s += n.type === "text" ? n.text : " ";
  return s;
}

export interface DocBlock extends NoteBlock {
  kind: "paragraph" | "heading" | "bullet" | "ordered";
  level?: 1 | 2 | 3;
  depth: number;
}

/** Paragraphs and headings in reading order (a bullet's text is its own block). */
export function docBlocks(doc: TpDoc): DocBlock[] {
  const out: DocBlock[] = [];
  const walkList = (l: TpBulletList | TpOrderedList, depth: number) => {
    const kind = l.type === "bulletList" ? "bullet" : "ordered";
    for (const li of l.content) {
      for (const c of li.content) {
        if (c.type === "paragraph") out.push({ id: c.attrs.id, text: inlineText(c.content), kind, depth });
        else walkList(c, depth + 1);
      }
    }
  };
  for (const b of doc.content) {
    if (b.type === "paragraph") out.push({ id: b.attrs.id, text: inlineText(b.content), kind: "paragraph", depth: 0 });
    else if (b.type === "heading")
      out.push({ id: b.attrs.id, text: inlineText(b.content), kind: "heading", level: b.attrs.level, depth: 0 });
    else walkList(b, 1);
  }
  return out;
}

export function docPlainText(doc: TpDoc): string {
  return docBlocks(doc)
    .map((b) => b.text)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isDocEmpty(doc: TpDoc): boolean {
  return docBlocks(doc).every((b) => b.text.trim() === "");
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/gu;
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Words for the editor's count; CJK text counts about two characters to a word. */
export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = cjk ? text.replace(CJK, " ") : text;
  return (rest.match(WORD)?.length ?? 0) + Math.ceil(cjk / 2);
}

export const DEFAULT_WPM = 140;

/** "45 s", "3 min", "1 h 5 min". Under half a second of speech reads "0 s". */
export function speakingTime(words: number, wpm = DEFAULT_WPM): string {
  const seconds = Math.round((words / Math.max(20, wpm)) * 60);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function cleanTitle(title: string, fallback = "Untitled note"): string {
  const t = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  return t || fallback;
}

/** Title suggestion for a document: its first heading, else its first words. */
export function suggestTitle(doc: TpDoc, fallback = "Untitled note"): string {
  const blocks = docBlocks(doc).filter((b) => b.text.trim());
  const h = blocks.find((b) => b.kind === "heading");
  const first = h ?? blocks[0];
  if (!first) return fallback;
  const words = first.text.trim().split(/\s+/).slice(0, 9).join(" ");
  return cleanTitle(words, fallback);
}

/** The same document with new block ids (a copy must not share "said it" state with its source). */
export function reidDoc(doc: TpDoc, gen: () => string = newBlockId): TpDoc {
  const clone = JSON.parse(JSON.stringify(doc)) as TpDoc;
  const walk = (n: { type: string; attrs?: { id?: string }; content?: unknown[] }): void => {
    if ((n.type === "paragraph" || n.type === "heading") && n.attrs) n.attrs.id = gen();
    if (Array.isArray(n.content)) for (const c of n.content) walk(c as never);
  };
  for (const b of clone.content) walk(b as never);
  return sanitizeDoc(clone, gen);
}
