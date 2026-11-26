import type { NoteBlock, NoteDoc } from "../lib/types";

export function block(over: Partial<NoteBlock> & { id: string }): NoteBlock {
  return { type: "bullet", parent: null, text: "", t: null, edited: false, pinned: false, ...over };
}

/** `topics` topics, each with a summary and `per` mixed lines. */
export function bigDoc(topics: number, per: number): NoteDoc {
  const blocks: NoteBlock[] = [];
  let n = 0;
  const kinds = ["bullet", "decision", "task", "question"] as const;
  for (let i = 0; i < topics; i++) {
    const tid = `b${++n}`;
    blocks.push(block({ id: tid, type: "topic", text: `Topic ${i}`, t: i * 60_000 }));
    blocks.push(block({ id: `b${++n}`, type: "summary", parent: tid, text: `Summary of topic ${i}` }));
    for (let j = 0; j < per; j++) {
      blocks.push(block({ id: `b${++n}`, type: kinds[j % 4], parent: tid, text: `Line ${i}.${j} with {{p:Ana}}`, t: i * 60_000 + j * 1000 }));
    }
  }
  return { version: 1, blocks };
}

export const sampleDoc: NoteDoc = {
  version: 1,
  blocks: [
    block({ id: "b1", type: "topic", text: "Launch plan", t: 65_000 }),
    block({ id: "b2", type: "summary", parent: "b1", text: "{{p:Ana}} wants to ship in {{l:Berlin}} by {{d:March 3}}." }),
    block({ id: "b3", type: "bullet", parent: "b1", text: "Budget is {{n:$40k}} for {{o:Acme}}", t: 80_000 }),
    block({ id: "b4", type: "decision", parent: "b1", text: "Ship the beta first", t: 90_000 }),
    block({ id: "b5", type: "task", parent: "b1", text: "{{p:Omar}} drafts the invite", t: 95_000, pinned: true }),
    block({ id: "b6", type: "question", parent: "b1", text: "Who owns support?", t: 100_000, edited: true }),
  ],
};
