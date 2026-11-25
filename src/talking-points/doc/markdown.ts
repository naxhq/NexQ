/**
 * Markdown in and out, written by hand so nothing but our own schema can come out.
 *
 * In: headings (1-3, deeper ones become 3), paragraphs, bullet and numbered lists
 * (nested), bold, italic. Links become their text, images are dropped, raw HTML is
 * stripped (script and style bodies with it), code and strikethrough become plain
 * text. Out: the same subset; underline, colour and size have no Markdown form.
 */
import {
  MAX_DOC_CHARS,
  newBlockId,
  newParagraph,
  sanitizeDoc,
  type TpBlock,
  type TpBulletList,
  type TpDoc,
  type TpInline,
  type TpListItem,
  type TpMark,
  type TpOrderedList,
  type TpParagraph,
} from "./model";

// -- HTML and entities ------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n < 32 || n > 0x10ffff || (n >= 0xd800 && n < 0xe000)) return "";
      return String.fromCodePoint(n);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Removes comments, script/style/iframe bodies and every other tag; keeps their text. */
export function stripHtml(src: string): string {
  let s = src.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  s = s.replace(/<(https?:\/\/[^>\s]+)>/gi, "$1");
  s = s.replace(/<\/?[a-zA-Z!?][^>]*>/g, "");
  return s;
}

// -- inline -----------------------------------------------------------------------------------

type Flags = { bold: boolean; italic: boolean };

function push(out: TpInline[], text: string, f: Flags): void {
  if (!text) return;
  const marks: TpMark[] = [];
  if (f.bold) marks.push({ type: "bold" });
  if (f.italic) marks.push({ type: "italic" });
  out.push(marks.length ? { type: "text", text, marks } : { type: "text", text });
}

/** Index of the closing delimiter for a run opened at `from`, or -1. Skips escapes and code. */
function findClose(s: string, from: number, delim: string): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > 0) i = j;
      continue;
    }
    if (s.startsWith(delim, i)) {
      // `*` closing must not be followed by the same char when delim is a single char (part of **)
      if (delim.length === 1 && s[i + 1] === delim) {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Matching `]` for a `[` at `open` (nesting and escapes respected). */
function matchBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function inlineInto(s: string, f: Flags, out: TpInline[], depth = 0): void {
  let buf = "";
  const flush = () => {
    push(out, buf, f);
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      if (s[i + 1] === "\n") {
        flush();
        out.push({ type: "hardBreak" });
      } else buf += s[i + 1];
      i++;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ type: "hardBreak" });
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const j = s.indexOf(fence, i + n);
      if (j > 0) {
        buf += s.slice(i + n, j).replace(/^ (.*) $/, "$1");
        i = j + n - 1;
        continue;
      }
      buf += fence;
      i += n - 1;
      continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      const close = matchBracket(s, i + 1);
      if (close > 0 && s[close + 1] === "(") {
        const end = matchParen(s, close + 1);
        if (end > 0) {
          i = end;
          continue;
        }
      }
    }
    if (c === "[") {
      const close = matchBracket(s, i);
      if (close > 0 && depth < 4) {
        const next = s[close + 1];
        let end = close;
        if (next === "(") {
          const p = matchParen(s, close + 1);
          if (p > 0) end = p;
        } else if (next === "[") {
          const p = s.indexOf("]", close + 2);
          if (p > 0) end = p;
        }
        flush();
        inlineInto(s.slice(i + 1, close), f, out, depth + 1);
        i = end;
        continue;
      }
    }
    if ((c === "*" || c === "_") && depth < 6) {
      const strong = s[i + 1] === c;
      const delim = strong ? c + c : c;
      const prev = i > 0 ? s[i - 1] : " ";
      const after = s[i + delim.length] ?? " ";
      const intraWordUnderscore = c === "_" && /[\p{L}\p{N}]/u.test(prev);
      if (!/\s/.test(after) && !intraWordUnderscore) {
        const close = findClose(s, i + delim.length, delim);
        if (close > i + delim.length && !/\s/.test(s[close - 1])) {
          flush();
          const inner = strong ? { ...f, bold: true } : { ...f, italic: true };
          inlineInto(s.slice(i + delim.length, close), inner, out, depth + 1);
          i = close + delim.length - 1;
          continue;
        }
      }
    }
    if (c === "~" && s[i + 1] === "~") {
      const close = s.indexOf("~~", i + 2);
      if (close > 0) {
        flush();
        inlineInto(s.slice(i + 2, close), f, out, depth + 1);
        i = close + 1;
        continue;
      }
    }
    buf += c;
  }
  flush();
}

function inline(text: string): TpInline[] {
  const out: TpInline[] = [];
  inlineInto(text, { bold: false, italic: false }, out);
  // merge neighbours with equal marks, drop edge breaks
  const merged: TpInline[] = [];
  for (const n of out) {
    const last = merged[merged.length - 1];
    if (n.type === "text" && last?.type === "text" && JSON.stringify(last.marks) === JSON.stringify(n.marks)) last.text += n.text;
    else merged.push(n);
  }
  while (merged[0]?.type === "hardBreak") merged.shift();
  while (merged[merged.length - 1]?.type === "hardBreak") merged.pop();
  return merged;
}

// -- blocks -----------------------------------------------------------------------------------

interface Item {
  indent: number;
  ordered: boolean;
  start: number;
  text: string;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

/** Soft-wrapped lines join with a space; a line ending in a backslash is a hard break. */
function joinLines(lines: string[]): string {
  let s = "";
  lines.forEach((l, i) => {
    s += i === 0 ? l : s.endsWith("\\") ? "\n" + l : " " + l;
  });
  return s;
}

function paragraphOf(text: string): TpParagraph {
  const p = newParagraph();
  const c = inline(text);
  if (c.length) p.content = c;
  return p;
}

function buildList(items: Item[], at: { i: number }): TpBulletList | TpOrderedList {
  const first = items[at.i];
  const base = first.indent;
  const ordered = first.ordered;
  const list: TpListItem[] = [];
  while (at.i < items.length) {
    const it = items[at.i];
    if (it.indent < base) break;
    if (it.indent === base) {
      if (it.ordered !== ordered) break;
      const li: TpListItem = { type: "listItem", content: [paragraphOf(it.text)] };
      at.i++;
      while (at.i < items.length && items[at.i].indent > base) li.content.push(buildList(items, at));
      list.push(li);
    } else {
      // deeper than expected without a parent: treat as a child of the previous item or a new item
      if (list.length) list[list.length - 1].content.push(buildList(items, at));
      else {
        list.push({ type: "listItem", content: [paragraphOf(it.text)] });
        at.i++;
      }
    }
  }
  return ordered
    ? first.start > 1
      ? { type: "orderedList", attrs: { start: first.start }, content: list }
      : { type: "orderedList", content: list }
    : { type: "bulletList", content: list };
}

/** Markdown text to a document. Never throws; untrusted input is safe. */
export function markdownToDoc(markdown: string): TpDoc {
  let src = String(markdown ?? "")
    .slice(0, MAX_DOC_CHARS)
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n");
  src = stripHtml(src);
  src = decodeEntities(src);
  const lines = src.split("\n");
  const blocks: TpBlock[] = [];
  let para: string[] = [];
  let items: Item[] = [];
  let fence: string | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push(paragraphOf(joinLines(para)));
      para = [];
    }
  };
  const flushList = () => {
    if (items.length) {
      const at = { i: 0 };
      while (at.i < items.length) blocks.push(buildList(items, at));
      items = [];
    }
  };

  for (const raw of lines) {
    if (fence) {
      if (raw.trim().startsWith(fence)) fence = null;
      else if (raw.trim()) blocks.push(newParagraph(raw.trim()));
      continue;
    }
    const f = FENCE_RE.exec(raw);
    if (f) {
      flushPara();
      flushList();
      fence = f[1];
      continue;
    }
    if (!raw.trim()) {
      flushPara();
      flushList();
      continue;
    }
    let line = raw;
    // block quotes: keep the text
    line = line.replace(/^ {0,3}(?:>[ \t]?)+/, "");
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = Math.min(3, h[1].length) as 1 | 2 | 3;
      const c = inline(h[2]);
      blocks.push({ type: "heading", attrs: { id: newBlockId(), level }, ...(c.length ? { content: c } : {}) });
      continue;
    }
    if (RULE_RE.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // table: drop the separator row, keep each row's cells as one line
      flushPara();
      flushList();
      if (/^[\s|:-]+$/.test(line)) continue;
      const cells = line.split("|").map((x) => x.trim()).filter(Boolean);
      blocks.push(paragraphOf(cells.join(", ")));
      continue;
    }
    const m = LIST_RE.exec(line);
    if (m) {
      flushPara();
      const indent = m[1].replace(/\t/g, "    ").length;
      const marker = m[2];
      const ordered = /\d/.test(marker);
      const text = m[3].replace(/^\[[ xX]\]\s+/, "");
      items.push({ indent, ordered, start: ordered ? parseInt(marker, 10) : 1, text });
      continue;
    }
    if (items.length && /^\s+/.test(line)) {
      // continuation of the last item
      items[items.length - 1].text += "\n" + line.trim();
      continue;
    }
    flushList();
    para.push(line.replace(/[ \t]+$/, (sp) => (sp.length >= 2 ? "\\" : "")).trim());
  }
  flushPara();
  flushList();
  return sanitizeDoc({ type: "doc", content: blocks });
}

/** The first heading's text, or the first line, for naming an import. */
export function markdownTitle(markdown: string, fallback: string): string {
  for (const raw of String(markdown).slice(0, 4000).split(/\r?\n/)) {
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) return stripHtml(h[1]).replace(/[*_`[\]]/g, "").trim() || fallback;
  }
  return fallback;
}

// -- export -----------------------------------------------------------------------------------

function esc(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function inlineMd(content: TpInline[] | undefined): string {
  if (!content) return "";
  let out = "";
  for (const n of content) {
    if (n.type === "hardBreak") {
      out += "  \n";
      continue;
    }
    let t = esc(n.text);
    const marks = new Set((n.marks ?? []).map((m) => m.type));
    const lead = /^\s*/.exec(t)![0];
    const trail = /\s*$/.exec(t)![0];
    const core = t.slice(lead.length, t.length - trail.length);
    if (!core) {
      out += t;
      continue;
    }
    t = core;
    if (marks.has("italic")) t = `*${t}*`;
    if (marks.has("bold")) t = `**${t}**`;
    out += lead + t + trail;
  }
  return out;
}

function guardLine(text: string): string {
  // a paragraph that would read as a heading, list item or rule once exported
  return text.replace(/^(\s*)(#{1,6}\s|[-+*]\s|\d{1,9}[.)]\s|>)/, "$1\\$2");
}

function listMd(list: TpBulletList | TpOrderedList, depth: number, out: string[]): void {
  const pad = "   ".repeat(depth);
  let n = list.type === "orderedList" ? (list.attrs?.start ?? 1) : 0;
  for (const li of list.content) {
    const marker = list.type === "bulletList" ? "-" : `${n++}.`;
    let first = true;
    for (const c of li.content) {
      if (c.type === "paragraph") {
        const t = inlineMd(c.content).replace(/\n/g, "\n" + pad + "   ");
        out.push(first ? `${pad}${marker} ${t}` : `${pad}   ${t}`);
        first = false;
      } else listMd(c, depth + 1, out);
    }
  }
}

export function docToMarkdown(doc: TpDoc): string {
  const out: string[] = [];
  let prevList = false;
  for (const b of doc.content) {
    if (b.type === "paragraph") {
      const t = inlineMd(b.content);
      if (t.trim() === "") continue;
      if (out.length) out.push("");
      out.push(guardLine(t));
      prevList = false;
    } else if (b.type === "heading") {
      if (out.length) out.push("");
      out.push(`${"#".repeat(b.attrs.level)} ${inlineMd(b.content)}`);
      prevList = false;
    } else {
      if (out.length) out.push("");
      if (prevList) out.push("<!-- -->", "");
      listMd(b, 0, out);
      prevList = true;
    }
  }
  return out.join("\n").replace(/\n+$/, "") + (out.length ? "\n" : "");
}
