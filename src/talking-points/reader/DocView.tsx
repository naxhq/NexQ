/**
 * Our own renderer for a talking-point document. No editor, no HTML strings: the
 * JSON is sanitised first and then drawn as React elements, so nothing in a note
 * can become markup. Each paragraph or heading is a block with its stable id;
 * blocks carry the state the prompter draws (current, ahead, said).
 */
import { Fragment, memo, useMemo, type ReactNode } from "react";
import { Check } from "lucide-react";
import { sanitizeDoc, type TpBlock, type TpDoc, type TpHeading, type TpInline, type TpListItem, type TpParagraph } from "../doc/model";
import { cn } from "../../lib/utils";
import type { TextStyleId } from "../../stores/talkingPointsStore";
import "../talkingPoints.css";

/** "autosaid": ticked by voice (softer, easy to spot and untick); "said": ticked by hand. */
export type BlockState = "current" | "ahead" | "past" | "said" | "autosaid";

export interface DocViewProps {
  doc: TpDoc;
  /** Per block id. Missing = ahead. */
  states?: ReadonlyMap<string, BlockState>;
  /** Draws the "said it" tick in the gutter. */
  ticks?: boolean;
  /** Current line full, ahead and behind dimmed (Auto and My voice). Manual reads at full contrast. */
  focusDim?: boolean;
  /** Style preset for the line states (see talkingPoints.css); Classic when missing. */
  textStyle?: TextStyleId;
  /** The spoken part of the current block (from the prompter). Only the "Checked off" style draws it, as a strike. */
  spoken?: { blockId: string; endChar: number } | null;
  onToggleSaid?: (blockId: string) => void;
  className?: string;
}

/**
 * Text as one span per word, each marked struck once its first sound has been heard (offsets are
 * characters of the block text, the same ones the follower's word index maps to). Spaces stay plain text.
 */
function wordNodes(text: string, base: number, struckEnd: number): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\S+|\s+/g)) {
    const w = m[0];
    if (/^\s/.test(w)) out.push(w);
    else out.push(<span key={at} className="tp-w" data-struck={base + at < struckEnd ? "" : undefined}>{w}</span>);
    at += w.length;
  }
  return out;
}

function inlineNodes(content: TpInline[] | undefined, struckEnd?: number): ReactNode[] {
  if (!content) return [];
  let off = 0;
  return content.map((n, i) => {
    if (n.type === "hardBreak") {
      off += 1;
      return <br key={i} />;
    }
    let el: ReactNode = struckEnd === undefined ? n.text : wordNodes(n.text, off, struckEnd);
    off += n.text.length;
    for (const m of n.marks ?? []) {
      if (m.type === "bold") el = <strong>{el}</strong>;
      else if (m.type === "italic") el = <em>{el}</em>;
      else if (m.type === "underline") el = <u>{el}</u>;
      else if (m.type === "tpColor") el = <span className={`tp-c-${m.attrs.name}`}>{el}</span>;
      else if (m.type === "tpSize") el = <span className={`tp-s-${m.attrs.step}`}>{el}</span>;
    }
    return <Fragment key={i}>{el}</Fragment>;
  });
}

function firstWords(content: TpInline[] | undefined): string {
  const t = (content ?? []).map((n) => (n.type === "text" ? n.text : " ")).join("").trim().split(/\s+/).slice(0, 6).join(" ");
  return t || "empty line";
}

interface BlockProps {
  block: TpParagraph | TpHeading;
  depth: number;
  state: BlockState;
  ticks: boolean;
  /** Which kind of list the paragraph is in (a bullet's tick replaces its dot). */
  list?: "bullet" | "ordered";
  /** Characters of this block already spoken, to strike them word by word ("Checked off" while following). */
  struckEnd?: number;
  onToggleSaid?: (id: string) => void;
}

const Block = memo(function Block({ block, depth, state, ticks, list, struckEnd, onToggleSaid }: BlockProps) {
  const id = block.attrs.id;
  const auto = state === "autosaid";
  const said = state === "said" || auto;
  const common = {
    "data-block-id": id,
    "data-state": state,
    "data-list": list,
    style: { "--d": depth } as React.CSSProperties,
  };
  const body = (
    <>
      {ticks && block.type !== "heading" && (
        <button
          type="button"
          data-tp-skip=""
          tabIndex={-1}
          aria-pressed={said}
          data-auto={auto ? "" : undefined}
          aria-label={`Said it: ${firstWords(block.content)}${auto ? ", heard by voice" : ""}`}
          onClick={() => onToggleSaid?.(id)}
          className="tp-tick"
        >
          <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
        </button>
      )}
      {inlineNodes(block.content, said ? undefined : struckEnd)}
    </>
  );
  if (block.type === "heading") {
    const Tag = (`h${block.attrs.level}` as "h1" | "h2" | "h3");
    return <Tag {...common}>{body}</Tag>;
  }
  return <p {...common}>{body}</p>;
});

function renderList(
  list: Extract<TpBlock, { type: "bulletList" | "orderedList" }>,
  depth: number,
  p: Omit<BlockProps, "block" | "depth" | "state"> & { states?: ReadonlyMap<string, BlockState>; struckFor: (id: string) => number | undefined },
): ReactNode {
  const items = list.content.map((li: TpListItem, i: number) => (
    <li key={i}>
      {li.content.map((c, k) =>
        c.type === "paragraph" ? (
          <Block key={c.attrs.id} block={c} depth={depth} list={list.type === "bulletList" ? "bullet" : "ordered"} state={p.states?.get(c.attrs.id) ?? "ahead"} ticks={p.ticks} struckEnd={p.struckFor(c.attrs.id)} onToggleSaid={p.onToggleSaid} />
        ) : (
          <Fragment key={k}>{renderList(c, depth + 1, p)}</Fragment>
        ),
      )}
    </li>
  ));
  return list.type === "bulletList" ? (
    <ul>{items}</ul>
  ) : (
    <ol start={list.attrs?.start && list.attrs.start > 1 ? list.attrs.start : undefined}>{items}</ol>
  );
}

export const DocView = memo(function DocView({ doc, states, ticks = false, focusDim = true, textStyle = "classic", spoken = null, onToggleSaid, className }: DocViewProps) {
  // A document that did not come through the sanitiser is cleaned here, never trusted.
  const safe = useMemo(() => sanitizeDoc(doc, undefined), [doc]);
  const struckFor = (id: string) => (textStyle === "checked" && spoken && spoken.blockId === id ? spoken.endChar : undefined);
  return (
    <div className={cn("tp-doc tp-read", ticks && "tp-ticks", className)} data-dim={focusDim ? "on" : "off"} data-style={textStyle}>
      {safe.content.map((b) =>
        b.type === "paragraph" || b.type === "heading" ? (
          <Block key={b.attrs.id} block={b} depth={0} state={states?.get(b.attrs.id) ?? "ahead"} ticks={ticks} struckEnd={struckFor(b.attrs.id)} onToggleSaid={onToggleSaid} />
        ) : (
          <Fragment key={`${b.type}-${(b.content[0]?.content[0] as TpParagraph | undefined)?.attrs.id}`}>
            {renderList(b, 1, { ticks, onToggleSaid, states, struckFor })}
          </Fragment>
        ),
      )}
    </div>
  );
});
