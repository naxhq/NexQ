import { describe, expect, it } from "vitest";
import { applyEdit, invertEdit, planDelete } from "./edits";
import { bigDoc, block, sampleDoc } from "./fixtures";
import { WINDOW_STEP, buildSections, diffDocs, docToMarkdown, formatClock, sectionSize, topicTime, windowSections } from "./page";

describe("page structure", () => {
  it("groups lines under their topic, summary first, and keeps lines with no topic up front", () => {
    const doc = {
      version: 1,
      blocks: [
        block({ id: "o1", text: "loose" }),
        block({ id: "t1", type: "topic", text: "A" }),
        block({ id: "x", parent: "t1", text: "bullet" }),
        block({ id: "s", type: "summary", parent: "t1", text: "lead" }),
      ],
    };
    const sections = buildSections(doc.blocks);
    expect(sections.map((s) => s.topic?.id ?? null)).toEqual([null, "t1"]);
    expect(sections[1].lead.map((b) => b.id)).toEqual(["s"]);
    expect(sections[1].items.map((b) => b.id)).toEqual(["x"]);
  });

  it("formats times and finds a topic's time", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(null)).toBe("");
    const s = buildSections(sampleDoc.blocks)[0];
    expect(topicTime(s)).toBe(65_000);
    expect(topicTime({ ...s, topic: block({ id: "t", type: "topic" }) })).toBe(80_000);
  });

  it("windows a long meeting by whole sections from the newest", () => {
    const sections = buildSections(bigDoc(400, 4).blocks); // 2,400 blocks
    const { shown, hidden } = windowSections(sections, WINDOW_STEP);
    const shownLines = shown.reduce((n, s) => n + sectionSize(s), 0);
    expect(shownLines).toBeLessThanOrEqual(WINDOW_STEP + 6);
    expect(shown[shown.length - 1].topic?.text).toBe("Topic 399");
    expect(hidden + shownLines).toBe(2400);
    expect(windowSections(sections, 100000).hidden).toBe(0);
  });

  it("tells new lines from changed ones", () => {
    const a = { version: 1, blocks: [block({ id: "1", text: "a" }), block({ id: "2", text: "b" })] };
    const b = { version: 1, blocks: [block({ id: "1", text: "a" }), block({ id: "2", text: "b2" }), block({ id: "3", text: "c" })] };
    expect(diffDocs(a, b)).toEqual({ added: ["3"], changed: ["2"] });
    expect(diffDocs(null, a).added).toEqual(["1", "2"]);
  });
});

describe("Markdown", () => {
  it("is clean: no tags, no checkboxes, kinds named in words", () => {
    const md = docToMarkdown(sampleDoc, "Weekly sync");
    expect(md).toContain("# Weekly sync");
    expect(md).toContain("## Launch plan (1:05)");
    expect(md).toContain("Ana wants to ship in Berlin by March 3.");
    expect(md).toContain("- Budget is $40k for Acme");
    expect(md).toContain("- **Decision:** Ship the beta first");
    expect(md).toContain("- **Task:** Omar drafts the invite");
    expect(md).toContain("- **Question:** Who owns support?");
    expect(md).not.toMatch(/\{\{|\}\}|\[ \]|\[x\]/);
  });
  it("is empty for no notes", () => {
    expect(docToMarkdown(null)).toBe("");
    expect(docToMarkdown({ version: 1, blocks: [] })).toBe("");
  });
});

describe("user edits", () => {
  it("locks an edited line and keeps pin separate", () => {
    const next = applyEdit(sampleDoc, { op: "update", id: "b3", text: "New words" });
    expect(next.blocks.find((b) => b.id === "b3")).toMatchObject({ text: "New words", edited: true, pinned: false });
    const pinned = applyEdit(sampleDoc, { op: "update", id: "b3", pinned: true });
    expect(pinned.blocks.find((b) => b.id === "b3")).toMatchObject({ edited: false, pinned: true });
  });

  it("adds after a line, or at the end of a topic", () => {
    const after = applyEdit(sampleDoc, { op: "add", id: "u1", type: "bullet", parent: "b1", text: "x", after: "b3" });
    expect(after.blocks.map((b) => b.id).slice(0, 5)).toEqual(["b1", "b2", "b3", "u1", "b4"]);
    const end = applyEdit(sampleDoc, { op: "add", id: "u2", type: "task", parent: "b1", text: "y" });
    expect(end.blocks[end.blocks.length - 1].id).toBe("u2");
    expect(applyEdit(end, { op: "add", id: "u2", type: "task", parent: "b1", text: "y" })).toBe(end);
  });

  it("undoes each kind of edit", () => {
    const edit = { op: "update", id: "b4", text: "Changed", type: "task" } as const;
    const [back] = invertEdit(sampleDoc, edit);
    expect(applyEdit(applyEdit(sampleDoc, edit), back).blocks.find((b) => b.id === "b4")).toMatchObject({ text: "Ship the beta first", type: "decision" });

    const add = { op: "add", id: "u9", type: "bullet", parent: "b1", text: "z" } as const;
    const added = applyEdit(sampleDoc, add);
    expect(applyEdit(added, invertEdit(sampleDoc, add)[0]).blocks).toHaveLength(sampleDoc.blocks.length);
  });

  it("deleting a topic takes its lines, and undo brings them back in order", () => {
    const { edits, undo } = planDelete(sampleDoc, "b1");
    let gone = sampleDoc;
    for (const e of edits) gone = applyEdit(gone, e);
    expect(gone.blocks).toHaveLength(0);
    let back = gone;
    for (const e of undo) back = applyEdit(back, e);
    expect(back.blocks.map((b) => b.text)).toEqual(sampleDoc.blocks.map((b) => b.text));
    expect(back.blocks[1].parent).toBe(back.blocks[0].id);
  });

  it("deleting one line undoes to the same place", () => {
    const { edits, undo } = planDelete(sampleDoc, "b4");
    let doc = applyEdit(sampleDoc, edits[0]);
    expect(doc.blocks.some((b) => b.id === "b4")).toBe(false);
    doc = applyEdit(doc, undo[0]);
    expect(doc.blocks.map((b) => b.text)).toEqual(sampleDoc.blocks.map((b) => b.text));
  });
});
