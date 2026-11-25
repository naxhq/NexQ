import { describe, expect, it } from "vitest";
import {
  COLOR_NAMES,
  countWords,
  docBlocks,
  docPlainText,
  docFromText,
  emptyDoc,
  isDocEmpty,
  parseDoc,
  reidDoc,
  sanitizeDoc,
  speakingTime,
  suggestTitle,
  type TpDoc,
} from "./model";
import { docToMarkdown, markdownTitle, markdownToDoc, stripHtml } from "./markdown";

let n = 0;
const gen = () => `g${++n}`;

describe("sanitizeDoc", () => {
  it("keeps the allowed schema and gives every block an id", () => {
    const doc = sanitizeDoc(
      {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hello" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "bold", marks: [{ type: "bold" }] },
              { type: "text", text: " red", marks: [{ type: "tpColor", attrs: { name: "red" } }, { type: "tpSize", attrs: { step: "large" } }] },
            ],
          },
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] },
        ],
      },
      gen,
    );
    const blocks = docBlocks(doc);
    expect(blocks.map((b) => b.text)).toEqual(["Hello", "bold red", "a"]);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(3);
    expect(blocks.every((b) => b.id)).toBe(true);
  });

  it("keeps valid ids and repairs repeated or missing ones", () => {
    const p = (id?: string) => ({ type: "paragraph", ...(id ? { attrs: { id } } : {}), content: [{ type: "text", text: "x" }] });
    const doc = sanitizeDoc({ type: "doc", content: [p("keep"), p("keep"), p()] }, gen);
    const ids = docBlocks(doc).map((b) => b.id);
    expect(ids[0]).toBe("keep");
    expect(new Set(ids).size).toBe(3);
  });

  it("drops unknown nodes, marks, attributes and out-of-range values", () => {
    const doc = sanitizeDoc({
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://evil.example/x.png" } },
        { type: "heading", attrs: { level: 6, onclick: "x()" }, content: [{ type: "text", text: "H", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
        { type: "paragraph", content: [{ type: "text", text: "c", marks: [{ type: "tpColor", attrs: { name: "#ff0000" } }, { type: "tpSize", attrs: { step: "huge" } }] }] },
        { type: "script", content: [{ type: "text", text: "alert(1)" }] },
      ],
    });
    const json = JSON.stringify(doc);
    expect(json).not.toMatch(/image|link|href|javascript|onclick|#ff0000|huge|script/);
    expect(doc.content[0].type).toBe("heading");
    expect((doc.content[0] as { attrs: { level: number } }).attrs.level).toBe(3);
  });

  it("returns an empty note for junk, bad JSON and oversized depth", () => {
    for (const bad of [null, 5, "nope", "{", { type: "x" }, [], { type: "doc", content: "no" }]) {
      const d = sanitizeDoc(bad);
      expect(d.type).toBe("doc");
      expect(d.content.length).toBe(1);
      expect(isDocEmpty(d)).toBe(true);
    }
  });

  it("limits list nesting and survives hostile depth", () => {
    let node: unknown = { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "leaf" }] }] };
    for (let i = 0; i < 400; i++) node = { type: "listItem", content: [{ type: "paragraph" }, { type: "bulletList", content: [node] }] };
    const doc = sanitizeDoc({ type: "doc", content: [{ type: "bulletList", content: [node] }] });
    expect(JSON.stringify(doc).length).toBeLessThan(20_000);
  });

  it("is idempotent", () => {
    const once = sanitizeDoc(markdownToDoc("# T\n\n- a\n- b\n\n1. one\n2. two\n\n**x** *y*"));
    expect(sanitizeDoc(once)).toEqual(once);
  });

  it("only names, not hex values, are stored for colour", () => {
    expect(COLOR_NAMES.every((c) => /^[a-z]+$/.test(c))).toBe(true);
  });

  it("copies get new block ids", () => {
    const d = markdownToDoc("a\n\nb");
    const c = reidDoc(d);
    const a = docBlocks(d).map((b) => b.id);
    const b = docBlocks(c).map((x) => x.id);
    expect(b.some((id) => a.includes(id))).toBe(false);
    expect(docPlainText(c)).toBe(docPlainText(d));
  });
});

describe("counting", () => {
  it("counts words with apostrophes and numbers, CJK by characters", () => {
    expect(countWords("It's 3 o'clock, we're late")).toBe(5);
    expect(countWords("")).toBe(0);
    expect(countWords("你好世界")).toBe(2);
  });
  it("formats speaking time", () => {
    expect(speakingTime(0)).toBe("0 s");
    expect(speakingTime(70, 140)).toBe("30 s");
    expect(speakingTime(700, 140)).toBe("5 min");
    expect(speakingTime(140 * 70, 140)).toBe("1 h 10 min");
  });
  it("suggests a title from the first heading or words", () => {
    expect(suggestTitle(markdownToDoc("intro line\n\n# Big talk"))).toBe("Big talk");
    expect(suggestTitle(docFromText("one two three four five six seven eight nine ten eleven"))).toBe("one two three four five six seven eight nine");
    expect(suggestTitle(emptyDoc())).toBe("Untitled note");
  });
  it("parseDoc handles null and text", () => {
    expect(isDocEmpty(parseDoc(null))).toBe(true);
    expect(docPlainText(parseDoc(JSON.stringify(docFromText("a\nb"))))).toBe("a\nb");
  });
});

describe("Markdown import", () => {
  const text = (md: string) => docBlocks(markdownToDoc(md)).map((b) => b.text);

  it("reads headings, paragraphs, lists and emphasis", () => {
    const d = markdownToDoc("# One\n## Two\n#### Four\n\nA *soft*\nwrapped **line**.\n\n- a\n  - nested\n- b\n\n3. c\n4. d");
    expect(docBlocks(d).map((b) => `${b.kind}${b.level ?? ""}:${b.text}`)).toEqual([
      "heading1:One",
      "heading2:Two",
      "heading3:Four",
      "paragraph:A soft wrapped line.",
      "bullet:a",
      "bullet:nested",
      "bullet:b",
      "ordered:c",
      "ordered:d",
    ]);
    const list = d.content.find((b) => b.type === "orderedList") as { attrs?: { start: number } };
    expect(list.attrs?.start).toBe(3);
    const para = d.content[3] as { content: Array<{ text?: string; marks?: Array<{ type: string }> }> };
    expect(para.content.some((c) => c.text === "soft" && c.marks?.[0].type === "italic")).toBe(true);
    expect(para.content.some((c) => c.text === "line" && c.marks?.[0].type === "bold")).toBe(true);
  });

  it("turns links into text and drops images", () => {
    expect(text("See [the plan](https://example.com/plan) and ![chart](https://x.test/c.png) now <https://example.org>")).toEqual([
      "See the plan and  now https://example.org",
    ]);
    expect(text("[click](javascript:alert(1))")).toEqual(["click"]);
    expect(text("[a][ref]\n\n[ref]: https://x.test")).toContain("a");
  });

  it("strips HTML, scripts and styles but keeps harmless text", () => {
    const md = [
      "<script>alert('x')</script>Hello",
      "",
      "<img src=x onerror=alert(1)>after image",
      "",
      "<iframe src='https://evil.test'></iframe>text<style>body{display:none}</style>",
      "",
      "<b onmouseover=alert(1)>bold</b> <a href='javascript:alert(1)'>link</a>",
      "",
      "<!-- hidden --> visible",
    ].join("\n");
    const out = JSON.stringify(markdownToDoc(md));
    expect(out).not.toMatch(/alert|onerror|onmouseover|javascript|iframe|display:none|hidden|<|evil/);
    expect(text(md)).toEqual(["Hello", "after image", "text", "bold link", "visible"]);
  });

  it("is safe with entities, unterminated tags and odd input", () => {
    const nasty = [
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "<scr<script>ipt>alert(1)</script>",
      "<<img src=x onerror=alert(1)//",
      "&#x3C;img src=x&#x3E;",
      "\u0000\u0007 control",
      "[x](<javascript:alert(1)>)",
      "`<script>`",
    ].join("\n\n");
    const doc = markdownToDoc(nasty);
    // whatever text remains, it is only ever text nodes in our schema
    const walk = (nd: { type: string; content?: unknown[]; attrs?: Record<string, unknown> }) => {
      expect(["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "text", "hardBreak"]).toContain(nd.type);
      for (const k of Object.keys(nd.attrs ?? {})) expect(["id", "level", "start"]).toContain(k);
      (nd.content ?? []).forEach((c) => walk(c as never));
    };
    walk(doc);
    expect(JSON.stringify(doc)).not.toMatch(/"href"|"src"|"onerror"/);
  });

  it("handles huge and degenerate input without hanging", () => {
    const t0 = performance.now();
    markdownToDoc("*".repeat(5000));
    markdownToDoc("[".repeat(3000) + "x" + "]".repeat(3000));
    markdownToDoc("- ".repeat(2000));
    markdownToDoc("# ".repeat(5000));
    markdownToDoc(("_a ").repeat(4000));
    markdownToDoc("a".repeat(500_000));
    expect(performance.now() - t0).toBeLessThan(4000);
  });

  it("flattens code blocks, quotes, tables and rules to plain text", () => {
    expect(text("```js\nconst a = 1;\n```\n\n> quoted\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |")).toEqual(["const a = 1;", "quoted", "a, b", "1, 2"]);
  });

  it("stripHtml removes tags and keeps text", () => {
    expect(stripHtml("a<b>b</b>c<!-- x -->d")).toBe("abcd");
  });

  it("finds a title", () => {
    expect(markdownTitle("intro\n\n## **Kick off** plan", "x")).toBe("Kick off plan");
    expect(markdownTitle("no heading", "fallback")).toBe("fallback");
  });
});

describe("Markdown export", () => {
  it("round trips the supported subset", () => {
    const md = "# Title\n\nA **bold** and *italic* line.\n\n- one\n- two\n  - deep\n\n1. first\n2. second\n";
    const d1 = markdownToDoc(md);
    const out = docToMarkdown(d1);
    const d2 = markdownToDoc(out);
    expect(docBlocks(d2).map((b) => `${b.kind}:${b.text}`)).toEqual(docBlocks(d1).map((b) => `${b.kind}:${b.text}`));
    expect(out).toContain("**bold**");
    expect(out).toContain("*italic*");
  });

  it("escapes text that would read as Markdown and keeps it as text", () => {
    const d: TpDoc = sanitizeDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "# not a heading" }] }, { type: "paragraph", content: [{ type: "text", text: "a * b _ c [d]" }] }] });
    const back = markdownToDoc(docToMarkdown(d));
    expect(docBlocks(back).map((b) => `${b.kind}:${b.text}`)).toEqual(["paragraph:# not a heading", "paragraph:a * b _ c [d]"]);
  });

  it("drops underline, colour and size, keeps the words", () => {
    const d = sanitizeDoc({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "word", marks: [{ type: "underline" }, { type: "tpColor", attrs: { name: "red" } }] }] }],
    });
    expect(docToMarkdown(d).trim()).toBe("word");
  });
});

import { stripHiddenHtml, stripHiddenText } from "./model";

describe("hidden characters from outside", () => {
  it("takes out what nobody can see and keeps the joiners", () => {
    const hidden = "a​b­c‮d⁦e﻿\u{e0041}f";
    expect(stripHiddenText(hidden)).toBe("abcdef");
    expect(stripHiddenText("می‌خواهم ‍")).toBe("می‌خواهم ‍");
    expect(stripHiddenText("ordinary text, emoji 👩‍💻")).toBe("ordinary text, emoji 👩‍💻");
  });
  it("also when pasted HTML spells them as entities", () => {
    expect(stripHiddenHtml("a&#8203;b&#x200B;c&#x202E;d&ZeroWidthSpace;e&shy;f&#8204;g")).toBe("abcdef&#8204;g");
  });
});
