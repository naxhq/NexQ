/**
 * The strict TipTap schema. Only what `doc/model.ts` allows exists here, so anything
 * pasted or dropped is reduced to it by ProseMirror's own parser: links become their
 * text, images and embeds vanish, styles and classes are never read, HTML never
 * passes through. Loaded only with the editor chunk.
 */
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Heading } from "@tiptap/extension-heading";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Underline } from "@tiptap/extension-underline";
import { HardBreak } from "@tiptap/extension-hard-break";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { COLOR_NAMES, SIZE_STEPS, newBlockId } from "../doc/model";

function allowed(list: readonly string[], v: string | null): boolean {
  return !!v && list.includes(v);
}

const blockIdKey = new PluginKey("tpBlockId");

/**
 * Every paragraph and heading carries a stable `id`. Ids are never read from pasted
 * or dropped HTML (a copy is a new block); a split keeps the id on the first half and
 * gives the second a new one; duplicates and gaps are repaired after every change.
 */
export const BlockId = Extension.create({
  name: "tpBlockId",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          id: {
            default: null,
            parseHTML: () => null,
            renderHTML: (attrs: { id?: string | null }) => (attrs.id ? { "data-block-id": attrs.id } : {}),
            keepOnSplit: false,
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdKey,
        appendTransaction(trs, _old, state) {
          if (!trs.some((t) => t.docChanged)) return null;
          const seen = new Set<string>();
          const fixes: Array<{ pos: number; node: PMNode }> = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
            const id = node.attrs.id as string | null;
            if (!id || seen.has(id)) fixes.push({ pos, node });
            else seen.add(id);
          });
          if (fixes.length === 0) return null;
          const tr = state.tr;
          for (const { pos, node } of fixes) {
            let id = newBlockId();
            while (seen.has(id)) id = newBlockId();
            seen.add(id);
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
          }
          tr.setMeta("addToHistory", false);
          return tr;
        },
      }),
    ];
  },
});

export const TpColor = Mark.create({
  name: "tpColor",
  priority: 90,
  addAttributes() {
    return {
      name: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const n = el.getAttribute("data-tp-color");
          return allowed(COLOR_NAMES, n) ? n : null;
        },
        renderHTML: (a: { name?: string | null }) => (a.name ? { "data-tp-color": a.name } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-tp-color]", getAttrs: (el) => (allowed(COLOR_NAMES, (el as HTMLElement).getAttribute("data-tp-color")) ? null : false) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: `tp-c-${HTMLAttributes["data-tp-color"]}` }), 0];
  },
});

export const TpSize = Mark.create({
  name: "tpSize",
  priority: 90,
  addAttributes() {
    return {
      step: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const n = el.getAttribute("data-tp-size");
          return allowed(SIZE_STEPS, n) ? n : null;
        },
        renderHTML: (a: { step?: string | null }) => (a.step ? { "data-tp-size": a.step } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-tp-size]", getAttrs: (el) => (allowed(SIZE_STEPS, (el as HTMLElement).getAttribute("data-tp-size")) ? null : false) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: `tp-s-${HTMLAttributes["data-tp-size"]}` }), 0];
  },
});

const StrictDocument = Document.extend({ content: "(paragraph | heading | bulletList | orderedList)+" });
const StrictListItem = ListItem.extend({ content: "paragraph (paragraph | bulletList | orderedList)*" });
const StrictHeading = Heading.configure({ levels: [1, 2, 3] });

export function createExtensions() {
  return [
    StrictDocument,
    Paragraph,
    Text,
    StrictHeading,
    Bold,
    Italic,
    Underline,
    HardBreak,
    BulletList,
    OrderedList,
    StrictListItem,
    UndoRedo,
    Placeholder.configure({ placeholder: "Write what you want to say" }),
    TpColor,
    TpSize,
    BlockId,
  ];
}
