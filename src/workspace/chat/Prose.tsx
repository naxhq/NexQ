import { memo, useMemo, type ComponentType, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { noRemoteImages } from "../../lib/answerMarkdown";
import type { WorkspaceCitation } from "../../lib/types";
import { Tooltip } from "../../ui";
import { cn } from "../../lib/utils";
import { displayTitle } from "./titles";
import { stripHidden } from "./instructionText";
import { CITE_SCHEME, citationKindName, citationWhere, findCitation, linkCitations } from "./citations";

export type OpenCitation = (citation: WorkspaceCitation) => void;

const chipClass =
  "relative -top-[0.38em] mx-px inline-flex h-[1.15em] min-w-[1.6em] items-center justify-center rounded-[5px] px-1 align-baseline text-[0.68em] font-semibold leading-none tabular-nums";

/**
 * `[S1]` in an answer. While the answer is being written the tags are not checked yet, so the
 * chip is plain (same size, so nothing moves when it becomes a button). A tag that is not in
 * the saved list stays as text.
 */
export function CitationChip({
  tag,
  citation,
  live,
  onOpen,
}: {
  tag: string;
  citation: WorkspaceCitation | null;
  live: boolean;
  onOpen?: OpenCitation;
}) {
  if (!citation) {
    return live ? (
      <span className={cn(chipClass, "bg-muted text-muted-foreground")} aria-label={`Source ${tag}`}>
        {tag}
      </span>
    ) : (
      <span>{`[${tag}]`}</span>
    );
  }
  // The source is gone (its ref is empty): a muted chip that says why on hover or focus, and opens nothing.
  if (!citation.ref_id) {
    const reason = citation.snippet || displayTitle(citation.title, citation.ref_id);
    return (
      <Tooltip content={<span className="block max-w-[16rem] text-foreground">{reason}</span>} delay={200}>
        <span
          tabIndex={0}
          role="note"
          aria-label={`Source ${tag}: ${reason}`}
          className={cn(chipClass, "cursor-default bg-muted text-muted-foreground line-through outline-none ui-focus")}
        >
          {tag}
        </span>
      </Tooltip>
    );
  }
  const tip = (
    <span className="block max-w-[16rem]">
      <span className="block font-semibold text-foreground">{citationWhere(citation)}</span>
      <span className="block text-muted-foreground">{citationKindName(citation)}</span>
      {citation.snippet && <span className="mt-1 line-clamp-3 block text-foreground/80">{citation.snippet}</span>}
    </span>
  );
  return (
    <Tooltip content={tip} delay={200}>
      <button
        type="button"
        onClick={() => onOpen?.(citation)}
        aria-label={`Source ${tag}: ${citationWhere(citation)}`}
        className={cn(
          chipClass,
          "cursor-pointer bg-accent text-foreground/85 outline-none transition-colors hover:bg-accent/70 hover:text-foreground ui-focus",
        )}
      >
        {tag}
      </button>
    </Tooltip>
  );
}

function table({ children }: { children?: ReactNode }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  );
}

function buildComponents(citations: WorkspaceCitation[], live: boolean, onOpen?: OpenCitation): Components {
  const Link = noRemoteImages.a as unknown as ComponentType<{ href?: string; children?: ReactNode }>;
  return {
    ...noRemoteImages,
    a: (props) => {
      const href = typeof props.href === "string" ? props.href : "";
      if (href.startsWith(CITE_SCHEME)) {
        const tag = href.slice(CITE_SCHEME.length);
        return <CitationChip tag={tag} citation={findCitation(citations, tag)} live={live} onOpen={onOpen} />;
      }
      return <Link href={props.href}>{props.children}</Link>;
    },
    h1: ({ children }) => <h3 className="ui-dialog-title !mt-6 text-foreground">{children}</h3>,
    h2: ({ children }) => <h3 className="ui-section !mt-5 text-foreground">{children}</h3>,
    h3: ({ children }) => <h4 className="ui-section !mt-4 text-foreground">{children}</h4>,
    h4: ({ children }) => <h4 className="ui-section !mt-4 font-medium text-foreground/90">{children}</h4>,
    ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-border pl-3 text-foreground/80">{children}</blockquote>,
    hr: () => <hr className="border-border" />,
    pre: ({ children }) => <pre className="max-w-full overflow-x-auto rounded-lg bg-muted/60 px-3 py-2.5 ui-meta leading-relaxed">{children}</pre>,
    code: ({ className, children }) =>
      className ? (
        <code className={className}>{children}</code>
      ) : (
        <code className="rounded bg-muted px-1 py-px text-[0.9em]">{children}</code>
      ),
    table,
    th: ({ children }) => <th className="border-b border-border px-2 py-1.5 font-semibold">{children}</th>,
    td: ({ children }) => <td className="border-b border-border/50 px-2 py-1.5 align-top">{children}</td>,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  };
}

const urlTransform = (url: string) => (url.startsWith(CITE_SCHEME) ? url : defaultUrlTransform(url));

/**
 * An answer set like a page: one measure (72 characters), one vertical rhythm (blocks 0.75rem
 * apart), citations as small chips. Remote images never load (see lib/answerMarkdown).
 */
export const Prose = memo(function Prose({
  text,
  citations,
  live = false,
  onOpenCitation,
  className,
}: {
  text: string;
  citations: WorkspaceCitation[];
  live?: boolean;
  onOpenCitation?: OpenCitation;
  className?: string;
}) {
  // Hidden characters are never drawn (the whole text is cleaned each time, so a character split across tokens is judged with its neighbours).
  const source = useMemo(() => linkCitations(stripHidden(text)), [text]);
  const components = useMemo(() => buildComponents(citations, live, onOpenCitation), [citations, live, onOpenCitation]);
  return (
    <div className={cn("ui-body ui-measure break-words text-foreground [&>*+*]:mt-3", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
