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
import "../talkingPoints.css";

/** "autosaid": ticked by voice (softer, easy to spot and untick); "said": ticked by hand. */
export type BlockState = "current" | "ahead" | "past" | "said" | "autosaid";

export interface DocViewProps {
  doc: TpDoc;
  /** Per block id. Missing = ahead. */
  states?: ReadonlyMap<string, BlockState>;
  /** Draws the "said it" tick in the gutter. */
  ticks?: boolean;
  onToggleSaid?: (blockId: string) => void;
  className?: string;
}

function inlineNodes(content: TpInline[] | undefined): ReactNode[] {
  if (!content) return [];
  return content.map((n, i) => {
    if (n.type === "hardBreak") return <br key={i} />;
    let el: ReactNode = n.text;
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
  onToggleSaid?: (id: string) => void;
}

const Block = memo(function Block({ block, depth, state, ticks, onToggleSaid }: BlockProps) {
  const id = block.attrs.id;
  const auto = state === "autosaid";
  const said = state === "said" || auto;
  const common = {
    "data-block-id": id,
    "data-state": state,
    style: { "--d": depth } as React.CSSProperties,
  };
  const body = (
    <>
      {ticks && (
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
      {inlineNodes(block.content)}
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
  p: Omit<BlockProps, "block" | "depth" | "state"> & { states?: ReadonlyMap<string, BlockState> },
): ReactNode {
  const items = list.content.map((li: TpListItem, i: number) => (
    <li key={i}>
      {li.content.map((c, k) =>
        c.type === "paragraph" ? (
          <Block key={c.attrs.id} block={c} depth={depth} state={p.states?.get(c.attrs.id) ?? "ahead"} ticks={p.ticks} onToggleSaid={p.onToggleSaid} />
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

export const DocView = memo(function DocView({ doc, states, ticks = false, onToggleSaid, className }: DocViewProps) {
  // A document that did not come through the sanitiser is cleaned here, never trusted.
  const safe = useMemo(() => sanitizeDoc(doc, undefined), [doc]);
  return (
    <div className={cn("tp-doc tp-read", className)}>
      {safe.content.map((b) =>
        b.type === "paragraph" || b.type === "heading" ? (
          <Block key={b.attrs.id} block={b} depth={0} state={states?.get(b.attrs.id) ?? "ahead"} ticks={ticks} onToggleSaid={onToggleSaid} />
        ) : (
          <Fragment key={`${b.type}-${(b.content[0]?.content[0] as TpParagraph | undefined)?.attrs.id}`}>
            {renderList(b, 1, { ticks, onToggleSaid, states })}
          </Fragment>
        ),
      )}
    </div>
  );
});
