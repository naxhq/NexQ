import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import * as pmView from "@tiptap/pm/view";
import { Fragment, Slice } from "@tiptap/pm/model";
import { createExtensions } from "./extensions";
import { outsideTextProps, stripHiddenSlice } from "./pasteFilter";
import RichEditorSource from "./RichEditor.tsx?raw";
import { stripHidden } from "../../workspace/chat/instructionText";

const ZWNJ = "‌";
const ZWJ = "‍";
let editor: Editor | null = null;

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.DataTransfer ??= class {
    private d = new Map<string, string>();
    get types() {
      return [...this.d.keys()];
    }
    setData(t: string, v: string) {
      this.d.set(t, v);
    }
    getData(t: string) {
      return this.d.get(t) ?? "";
    }
  };
  g.ClipboardEvent ??= class extends Event {
    clipboardData: unknown;
    constructor(type: string, init?: { clipboardData?: unknown }) {
      super(type, { bubbles: true, cancelable: true });
      this.clipboardData = init?.clipboardData;
    }
  };
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  document.elementFromPoint = () => null;
});
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const make = (html = "<p>start</p>") => {
  editor = new Editor({ element: document.createElement("div"), extensions: createExtensions(), content: html, editorProps: { ...outsideTextProps } });
  return editor;
};
const text = () => editor!.state.doc.textContent;
const parseFromClipboard = (pmView as unknown as { __parseFromClipboard: (v: unknown, t: string, h: string | null, plain: boolean, $c: unknown) => Slice | null }).__parseFromClipboard;

/** What both paste and drop run: the clipboard parser with the editor's own transforms. */
function parsed(view: Editor["view"], html: string | null, plain: string) {
  const $ = view.state.doc.resolve(1);
  return parseFromClipboard(view, plain, html, false, $)!;
}

describe("the shared rule, on pasted slices", () => {
  it("entities are decoded by the parser first, then removed by the rule", () => {
    const e = make();
    const slice = parsed(e.view, "<p>a&#8203;b&#x200B;c&#x202E;d&ZeroWidthSpace;e&shy;f&#xFEFF;g&#8204;h</p>", "");
    expect(slice.content.textBetween(0, slice.content.size, "\n")).toBe("abcdefgh");
  });

  it("every hidden range goes: bidi controls, isolates, word joiner and invisible operators, BOM, tags, soft hyphen, marks", () => {
    const e = make();
    const hidden = ["­", "‎", "‏", "‪", "‫", "‬", "‭", "‮", "⁠", "⁡", "⁢", "⁣", "⁤", "⁦", "⁧", "⁨", "⁩", "﻿", "\u{e0041}", "\u{e007f}"];
    for (const h of hidden) {
      const slice = parsed(e.view, `<p>x${h}y</p>`, "");
      expect(slice.content.textBetween(0, slice.content.size, "\n"), `U+${h.codePointAt(0)!.toString(16)}`).toBe("xy");
    }
  });

  it("writing survives: Persian half spaces, Malayalam and Devanagari conjuncts, emoji sequences", () => {
    const e = make();
    const samples = [
      `می${ZWNJ}خواهم`,
      `ക്${ZWJ}ഷ`, // Malayalam chillu
      `क्${ZWJ}ष`, // Devanagari
      `👩${ZWJ}💻 and 🏳️${ZWJ}🌈`,
      `نامه${ZWNJ}ها`,
    ];
    for (const s of samples) {
      const slice = parsed(e.view, `<p>${s}</p>`, "");
      expect(slice.content.textBetween(0, slice.content.size, "\n"), s).toBe(stripHidden(s));
      expect(stripHidden(s)).toBe(s);
    }
  });

  it("a joiner at a mark boundary is judged by the whole line, not by the half it sits in", () => {
    const e = make();
    const slice = parsed(e.view, `<p>می<strong>${ZWNJ}خواهم</strong> x​y</p>`, "");
    const t = slice.content.textBetween(0, slice.content.size, "\n");
    expect(t).toBe(`می${ZWNJ}خواهم xy`);
    // the bold part is still bold
    let bold = "";
    slice.content.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "bold")) bold += n.text;
    });
    expect(bold).toContain("خواهم");
  });

  it("plain text paste goes through the same rule", () => {
    const e = make();
    const slice = parsed(e.view, null, `line one​\nline‮ two ${ZWNJ.repeat(1)}x`);
    expect(slice.content.textBetween(0, slice.content.size, "\n")).not.toMatch(/[​‮]/);
    expect(slice.content.textBetween(0, slice.content.size, "\n")).toContain("line one");
  });

  it("Markdown pasted as plain text is cleaned and still becomes formatted blocks", () => {
    const e = make("<p></p>");
    const dt = new (globalThis as unknown as { DataTransfer: new () => { setData(t: string, v: string): void } }).DataTransfer();
    dt.setData("text/plain", "# Plan​\n\n- first‮ item\n- second می‌خواهم");
    const ev = new (globalThis as unknown as { ClipboardEvent: new (t: string, i: unknown) => Event }).ClipboardEvent("paste", { clipboardData: dt });
    e.view.someProp("handlePaste", (f) => f(e.view, ev as ClipboardEvent, Slice.empty));
    const json = JSON.stringify(e.getJSON());
    expect(json).toContain('"heading"');
    expect(json).toContain('"bulletList"');
    expect(json).not.toMatch(/​|‮/);
    expect(json).toContain(`می${ZWNJ}خواهم`);
  });

  it("dropped content takes the same path as paste (the editor sets the one transform)", () => {
    const e = make();
    expect(e.view.props.transformPasted).toBe(stripHiddenSlice);
    expect(RichEditorSource).toContain("...outsideTextProps"); // and the editor uses exactly these props
    // the parser that drop uses is the one exercised above; a dropped HTML fragment is cleaned the same way
    const slice = parsed(e.view, `<p>dropped​ text‮</p>`, "");
    expect(slice.content.textBetween(0, slice.content.size, "\n")).toBe("dropped text");
  });

  it("typed text is never touched, whatever it contains", () => {
    const e = make("<p></p>");
    e.commands.insertContent(`typed​ and ${ZWNJ} kept`);
    expect(text()).toContain("​");
    expect(text()).toContain(ZWNJ);
  });

  it("the slice function keeps structure and empties nothing it should not", () => {
    const e = make();
    const schema = e.schema;
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "a​b" }, { type: "hardBreak" }, { type: "text", text: "c" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "​" }] }] }] },
      ],
    });
    const out = stripHiddenSlice(new Slice(doc.content, 0, 0));
    expect(out.content.child(0).textContent).toBe("abc");
    expect(out.content.child(0).childCount).toBe(3); // text, break, text: the hard break stayed
    expect(out.content.child(1).type.name).toBe("bulletList");
    expect(Fragment.empty.size).toBe(0);
  });
});
