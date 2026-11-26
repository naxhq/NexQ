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
import { isSpokenAt, type CharRange, type SpokenRanges } from "../prompter/spoken";
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
  /**
   * The words actually spoken, per block (the prompter's record). Only the "Checked off" style draws it, a strike on
   * exactly those words, in the block you are on and in the ones you left. A block without an entry falls back to `spoken`.
   */
  struck?: SpokenRanges | null;
  onToggleSaid?: (blockId: string) => void;
  className?: string;
}

/** Words of a block and how many of them were spoken (words with a letter or digit; punctuation never counts). */
interface WordCount {
  words: number;
  struck: number;
}

/**
 * Text as one span per word, each marked struck when it lies in a spoken range (offsets are characters of the block
 * text, the same ones the follower's word index maps to). Spaces stay plain text.
 */
function wordNodes(text: string, base: number, struck: readonly CharRange[], count: WordCount): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\S+|\s+/g)) {
    const w = m[0];
    if (/^\s/.test(w)) out.push(w);
    else {
      const on = isSpokenAt(struck, base + at);
      if (/[\p{L}\p{N}]/u.test(w)) {
        count.words++;
        if (on) count.struck++;
      }
      out.push(<span key={at} className="tp-w" data-struck={on ? "" : undefined}>{w}</span>);
    }
    at += w.length;
  }
  return out;
}

function inlineNodes(content: TpInline[] | undefined, struck?: readonly CharRange[], count?: WordCount): ReactNode[] {
  if (!content) return [];
  let off = 0;
  return content.map((n, i) => {
    if (n.type === "hardBreak") {
      off += 1;
      return <br key={i} />;
    }
    let el: ReactNode = struck && count ? wordNodes(n.text, off, struck, count) : n.text;
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
  /** The spoken character ranges of this block, to strike those words and only those ("Checked off"). */
  struck?: readonly CharRange[];
  onToggleSaid?: (id: string) => void;
}

const Block = memo(function Block({ block, depth, state, ticks, list, struck, onToggleSaid }: BlockProps) {
  const id = block.attrs.id;
  const auto = state === "autosaid";
  const said = state === "said" || auto;
  // Words are wrapped only in a block that has spoken words. A whole-block strike (data-struck-all) only when every word was.
  const count: WordCount = { words: 0, struck: 0 };
  const content = inlineNodes(block.content, struck && struck.length > 0 ? struck : undefined, count);
  const common = {
    "data-block-id": id,
    "data-state": state,
    "data-list": list,
    "data-struck-all": count.words > 0 && count.struck === count.words ? "" : undefined,
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
      {content}
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
  p: Omit<BlockProps, "block" | "depth" | "state"> & { states?: ReadonlyMap<string, BlockState>; struckFor: (id: string) => readonly CharRange[] | undefined },
): ReactNode {
  const items = list.content.map((li: TpListItem, i: number) => (
    <li key={i}>
      {li.content.map((c, k) =>
        c.type === "paragraph" ? (
          <Block key={c.attrs.id} block={c} depth={depth} list={list.type === "bulletList" ? "bullet" : "ordered"} state={p.states?.get(c.attrs.id) ?? "ahead"} ticks={p.ticks} struck={p.struckFor(c.attrs.id)} onToggleSaid={p.onToggleSaid} />
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

export const DocView = memo(function DocView({ doc, states, ticks = false, focusDim = true, textStyle = "classic", spoken = null, struck = null, onToggleSaid, className }: DocViewProps) {
  // A document that did not come through the sanitiser is cleaned here, never trusted.
  const safe = useMemo(() => sanitizeDoc(doc, undefined), [doc]);
  // The block being spoken, before the prompter has a record of it: everything up to the spoken end.
  const current = useMemo<readonly CharRange[] | null>(() => (spoken ? [[0, spoken.endChar]] : null), [spoken]);
  const struckFor = (id: string) => (textStyle !== "checked" ? undefined : struck?.get(id) ?? (spoken?.blockId === id ? current ?? undefined : undefined));
  return (
    <div className={cn("tp-doc tp-read", ticks && "tp-ticks", className)} data-dim={focusDim ? "on" : "off"} data-style={textStyle}>
      {safe.content.map((b) =>
        b.type === "paragraph" || b.type === "heading" ? (
          <Block key={b.attrs.id} block={b} depth={0} state={states?.get(b.attrs.id) ?? "ahead"} ticks={ticks} struck={struckFor(b.attrs.id)} onToggleSaid={onToggleSaid} />
        ) : (
          <Fragment key={`${b.type}-${(b.content[0]?.content[0] as TpParagraph | undefined)?.attrs.id}`}>
            {renderList(b, 1, { ticks, onToggleSaid, states, struckFor })}
          </Fragment>
        ),
      )}
    </div>
  );
});
