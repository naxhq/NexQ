// Pure helpers for the user's own changes to the notes: apply an edit locally
// (so the page answers at once), and work out the edit that undoes it.
import type { NoteBlock, NoteDoc, NoteEdit } from "../lib/types";

let counter = 0;
/** A fresh id for a line the user adds (the engine's own ids are `b<N>`). */
export function newUserId(): string {
  counter += 1;
  return `u${Date.now().toString(36)}${counter.toString(36)}`;
}

export function applyEdit(doc: NoteDoc, edit: NoteEdit): NoteDoc {
  switch (edit.op) {
    case "update":
      return {
        ...doc,
        blocks: doc.blocks.map((b) => {
          if (b.id !== edit.id) return b;
          const next: NoteBlock = { ...b };
          if (edit.text !== undefined) next.text = edit.text;
          if (edit.type !== undefined) next.type = edit.type;
          if (edit.text !== undefined || edit.type !== undefined) next.edited = true;
          if (edit.pinned !== undefined) next.pinned = edit.pinned;
          return next;
        }),
      };
    case "delete":
      return { ...doc, blocks: doc.blocks.filter((b) => b.id !== edit.id) };
    case "add": {
      if (doc.blocks.some((b) => b.id === edit.id)) return doc;
      const added: NoteBlock = {
        id: edit.id,
        type: edit.type,
        parent: edit.parent,
        text: edit.text,
        t: null,
        edited: true,
        pinned: false,
      };
      const blocks = doc.blocks.slice();
      let at = -1;
      if (edit.after) at = blocks.findIndex((b) => b.id === edit.after);
      if (at < 0 && edit.parent) {
        for (let i = 0; i < blocks.length; i++) if (blocks[i].id === edit.parent || blocks[i].parent === edit.parent) at = i;
      }
      if (at < 0) blocks.push(added);
      else blocks.splice(at + 1, 0, added);
      return { ...doc, blocks };
    }
  }
}

/** The edits that put things back, in the order to run them. */
export function invertEdit(doc: NoteDoc, edit: NoteEdit): NoteEdit[] {
  switch (edit.op) {
    case "add":
      return [{ op: "delete", id: edit.id }];
    case "update": {
      const b = doc.blocks.find((x) => x.id === edit.id);
      if (!b) return [];
      const back: NoteEdit = { op: "update", id: edit.id };
      if (edit.text !== undefined) back.text = b.text;
      if (edit.type !== undefined) back.type = b.type;
      if (edit.pinned !== undefined) back.pinned = b.pinned;
      return [back];
    }
    case "delete": {
      const i = doc.blocks.findIndex((x) => x.id === edit.id);
      if (i < 0) return [];
      const b = doc.blocks[i];
      return [{ op: "add", id: newUserId(), type: b.type, parent: b.parent, text: b.text, after: i > 0 ? doc.blocks[i - 1].id : null }];
    }
  }
}

/** Delete a line; deleting a topic takes its lines with it. Returns the edits and how to undo them. */
export function planDelete(doc: NoteDoc, id: string): { edits: NoteEdit[]; undo: NoteEdit[] } {
  const b = doc.blocks.find((x) => x.id === id);
  if (!b) return { edits: [], undo: [] };
  if (b.type !== "topic") {
    return { edits: [{ op: "delete", id }], undo: invertEdit(doc, { op: "delete", id }) };
  }
  const kids = doc.blocks.filter((x) => x.parent === id);
  const edits: NoteEdit[] = [...kids.map((k) => ({ op: "delete", id: k.id }) as NoteEdit), { op: "delete", id }];
  const topicIndex = doc.blocks.findIndex((x) => x.id === id);
  const topicId = newUserId();
  const undo: NoteEdit[] = [
    { op: "add", id: topicId, type: "topic", parent: null, text: b.text, after: topicIndex > 0 ? doc.blocks[topicIndex - 1].id : null },
  ];
  let prev = topicId;
  for (const k of kids) {
    const kid = newUserId();
    undo.push({ op: "add", id: kid, type: k.type, parent: topicId, text: k.text, after: prev });
    prev = kid;
  }
  return { edits, undo };
}
