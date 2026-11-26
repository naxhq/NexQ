import { stripHidden } from "./instructionText";

interface HastNode {
  type: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const ATTRIBUTES = ["alt", "title", "href", "src", "ariaLabel"];

function walk(node: HastNode) {
  if (typeof node.value === "string" && node.type !== "comment") node.value = stripHidden(node.value);
  if (node.properties) {
    for (const key of ATTRIBUTES) {
      const v = node.properties[key];
      if (typeof v === "string") node.properties[key] = stripHidden(v);
    }
  }
  node.children?.forEach(walk);
}

/**
 * After Markdown is parsed, HTML entities have become characters (`&#x202e;` is a right-to-left override
 * by now), and inline code, code blocks, alt text and titles are only text. This pass cleans every text
 * node and the attributes that are shown or followed, so nothing hidden is drawn whatever it was written as.
 * (`Prose` also cleans the source before parsing, so a character split across streamed tokens is judged whole.)
 */
export function rehypeStripHidden() {
  return (tree: HastNode) => walk(tree);
}
