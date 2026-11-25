import { afterEach, describe, expect, it } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import { DOMParser as PMParser } from "@tiptap/pm/model";
import { createExtensions } from "./extensions";
import { docBlocks, sanitizeDoc } from "../doc/model";

const schema = getSchema(createExtensions());

/** What the editor would build from pasted HTML (ProseMirror's own clipboard parser). */
function paste(html: string) {
  const dom = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  return sanitizeDoc(PMParser.fromSchema(schema).parse(dom).toJSON());
}

describe("paste and drop go through the schema", () => {
  it("links become their text", () => {
    const d = paste('<p>See <a href="https://evil.test" onclick="x()">the plan</a>.</p>');
    expect(JSON.stringify(d)).not.toMatch(/href|evil|onclick|link/);
    expect(docBlocks(d).map((b) => b.text)).toEqual(["See the plan."]);
  });

  it("images, iframes, scripts, forms and embeds vanish", () => {
    const d = paste(
      '<p>a<img src="x" onerror="alert(1)">b</p><iframe src="https://evil.test"></iframe><script>alert(1)</script><form><input value="z"></form><object data="x"></object><video src="v"></video><p>c</p>',
    );
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/img|src|onerror|iframe|alert|form|object|video|evil/);
    expect(docBlocks(d).map((b) => b.text).join("|")).toContain("ab");
  });

  it("styles and classes are never read, so no colours or sizes come from outside", () => {
    const d = paste('<p style="color:red;font-size:40px" class="tp-c-red"><span style="color:#f00;font-size:3em">x</span></p>');
    expect(JSON.stringify(d)).not.toMatch(/tpColor|tpSize|red|f00|font/);
  });

  it("only named colours and sizes from our own markup are accepted", () => {
    const ok = paste('<p><span data-tp-color="red">r</span><span data-tp-size="large">L</span></p>');
    expect(JSON.stringify(ok)).toMatch(/tpColor/);
    expect(JSON.stringify(ok)).toMatch(/tpSize/);
    const bad = paste('<p><span data-tp-color="url(javascript:x)">r</span><span data-tp-size="999px">L</span></p>');
    expect(JSON.stringify(bad)).not.toMatch(/tpColor|tpSize|javascript|999/);
  });

  it("deep headings become paragraphs or level 3 at most; tables and quotes flatten", () => {
    const d = paste("<h1>a</h1><h4>d</h4><blockquote><p>q</p></blockquote><table><tr><td>t</td></tr></table>");
    const levels = docBlocks(d).filter((b) => b.kind === "heading").map((b) => b.level ?? 0);
    expect(Math.max(...levels, 0)).toBeLessThanOrEqual(3);
    expect(docBlocks(d).map((b) => b.text)).toEqual(expect.arrayContaining(["a", "d", "q", "t"]));
  });

  it("ids in pasted markup are not trusted", () => {
    const d = paste('<p data-block-id="victim">x</p><p data-block-id="victim">y</p>');
    const ids = docBlocks(d).map((b) => b.id);
    expect(ids).not.toContain("victim");
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps bold, italic, underline and lists", () => {
    const d = paste("<ul><li><strong>a</strong></li><li><em>b</em><ul><li><u>c</u></li></ul></li></ul><ol><li>d</li></ol>");
    expect(docBlocks(d).map((b) => `${b.kind}:${b.text}`)).toEqual(["bullet:a", "bullet:b", "bullet:c", "ordered:d"]);
  });
});

describe("block ids in the editor", () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  const make = (doc: unknown) => {
    editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: doc as never });
    return editor;
  };
  const ids = (e: Editor) => docBlocks(sanitizeDoc(e.getJSON())).map((b) => b.id);

  it("typing keeps the id", () => {
    const e = make({ type: "doc", content: [{ type: "paragraph", attrs: { id: "A" }, content: [{ type: "text", text: "hello" }] }] });
    e.commands.insertContentAt(6, " world");
    expect(ids(e)).toEqual(["A"]);
  });

  it("a split keeps the id on the first half and gives the second a new one", () => {
    const e = make({ type: "doc", content: [{ type: "paragraph", attrs: { id: "A" }, content: [{ type: "text", text: "hello world" }] }] });
    e.commands.setTextSelection(6);
    e.commands.splitBlock();
    const got = ids(e);
    expect(got).toHaveLength(2);
    expect(got[0]).toBe("A");
    expect(got[1]).not.toBe("A");
    expect(got[1]).toBeTruthy();
  });

  it("content with duplicate or missing ids is repaired on the next change", () => {
    const e = make({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "A" }, content: [{ type: "text", text: "a" }] },
        { type: "paragraph", attrs: { id: "A" }, content: [{ type: "text", text: "b" }] },
        { type: "paragraph", content: [{ type: "text", text: "c" }] },
      ],
    });
    e.commands.insertContentAt(2, "!");
    const got = ids(e);
    expect(new Set(got).size).toBe(3);
    expect(got[0]).toBe("A");
  });

  it("inserted HTML gets its own ids", () => {
    const e = make({ type: "doc", content: [{ type: "paragraph", attrs: { id: "A" }, content: [{ type: "text", text: "x" }] }] });
    e.commands.insertContentAt(e.state.doc.content.size, '<p data-block-id="A">pasted</p>');
    const got = ids(e);
    expect(got).toHaveLength(2);
    expect(new Set(got).size).toBe(2);
  });

  it("the schema allows nothing outside our nodes and marks", () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(["bulletList", "doc", "hardBreak", "heading", "listItem", "orderedList", "paragraph", "text"]);
    expect(Object.keys(schema.marks).sort()).toEqual(["bold", "italic", "tpColor", "tpSize", "underline"]);
  });
});
