/**
 * Text that comes from outside (paste, drop) loses what nobody can see: zero-width spaces, bidi
 * overrides, tag characters and so on. It uses the one shared rule (`stripHidden`), which keeps the joiners
 * that real writing needs (Persian half spaces, Indic conjuncts, emoji sequences). It runs on the parsed
 * slice, so entities and markup are already decoded; typed text never goes through it.
 */
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { stripHidden } from "../../workspace/chat/instructionText";
import { markdownToDoc } from "../doc/markdown";

/** A stand-in for a non-text inline node (a hard break) while the text around it is judged. */
const OBJECT = "A";

function cleanTextblock(node: PMNode): PMNode {
  const kids: PMNode[] = [];
  node.forEach((c) => kids.push(c));
  const full = kids.map((k) => (k.isText ? k.text! : OBJECT)).join("");
  const cleaned = stripHidden(full);
  if (cleaned === full) return node;
  // Which input characters survived: the output is the input minus what was removed (line and paragraph
  // separators become a newline), so a walk with two pointers finds them.
  const input = Array.from(full);
  const output = Array.from(cleaned);
  const keep: boolean[] = [];
  let j = 0;
  for (const c of input) {
    const ok = j < output.length && (output[j] === c || (output[j] === "\n" && (c === " " || c === " ")));
    keep.push(ok);
    if (ok) j++;
  }
  const out: PMNode[] = [];
  let at = 0;
  for (const k of kids) {
    if (!k.isText) {
      if (keep[at]) out.push(k);
      at += 1;
      continue;
    }
    const cps = Array.from(k.text!);
    const text = cps.map((c, i) => (keep[at + i] ? (c === " " || c === " " ? "\n" : c) : "")).join("");
    at += cps.length;
    if (text) out.push(k.type.schema.text(text, k.marks));
  }
  return node.copy(Fragment.fromArray(out));
}

function cleanFragment(fragment: Fragment): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isTextblock) out.push(cleanTextblock(node));
    else if (node.isText) {
      const t = stripHidden(node.text!);
      if (t) out.push(node.type.schema.text(t, node.marks));
    } else if (node.content.size > 0) out.push(node.copy(cleanFragment(node.content)));
    else out.push(node);
  });
  return Fragment.fromArray(out);
}

/** ProseMirror's `transformPasted`: used for paste and for dropped content from outside. */
export function stripHiddenSlice(slice: Slice): Slice {
  return new Slice(cleanFragment(slice.content), slice.openStart, slice.openEnd);
}

const MD_HINT = /^(#{1,3}\s|[-*+]\s|\d+[.)]\s)|\*\*[^*\n]+\*\*/m;

function looksLikeMarkdown(text: string): boolean {
  return text.includes("\n") ? MD_HINT.test(text) : /^(#{1,3}\s|[-*+]\s\S|\d+[.)]\s\S)/.test(text);
}

/** Plain text that is Markdown becomes formatted blocks; it is cleaned by the same rule first. HTML goes through the schema. */
function handleMarkdownPaste(view: EditorView, event: ClipboardEvent): boolean {
  const cd = event.clipboardData;
  if (!cd || cd.types.includes("text/html")) return false;
  const text = stripHidden(cd.getData("text/plain"));
  if (!text || !looksLikeMarkdown(text)) return false;
  const doc = markdownToDoc(text);
  const { state } = view;
  const node = state.schema.nodeFromJSON({ type: "doc", content: doc.content });
  view.dispatch(state.tr.replaceSelection(node.slice(0, node.content.size, true)).scrollIntoView());
  return true;
}

/** The editor props for everything that comes in from outside (paste, drop). Typed text never goes through them. */
export const outsideTextProps = {
  transformPasted: stripHiddenSlice,
  handlePaste: handleMarkdownPaste,
};
