import { useCallback } from "react";
import type { Meeting } from "../../lib/types";
import type { SummaryGenerationState } from "../../hooks/useSummaryGeneration";
import { useStreamStore } from "../../stores/streamStore";
import { showToast } from "../../stores/toastStore";
import { Sparkles, Copy, Download, Loader2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { withoutImages } from "../../lib/answerMarkdown";

export function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();
}

/** Fix malformed markdown patterns from LLM output */
function cleanMarkdown(text: string): string {
  return text
    // Bold-wrapped ATX headers: **### text** → ### text
    .replace(/^\*\*(#{1,6})\s+(.+?)\*\*\s*$/gm, "$1 $2")
    // Headers with bold content: ### **text** → ### text
    .replace(/^(#{1,6})\s+\*\*(.+?)\*\*\s*$/gm, "$1 $2");
}

/** Custom ReactMarkdown component overrides for styled rendering */
export const mdComponents: Components = withoutImages({
  h1: ({ children }) => (
    <h1 className="text-lg font-bold text-foreground mt-6 mb-3 pb-2 border-b border-primary/20">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[15px] font-semibold text-primary mt-7 mb-2.5 pb-1.5 border-b border-border/20 tracking-wide uppercase text-primary/80">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold text-foreground mt-4 mb-1.5">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="text-sm leading-7 text-foreground/80 mb-3">
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="my-2 ml-1 space-y-1.5">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-1 space-y-1.5 list-decimal list-inside">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="text-sm leading-relaxed text-foreground/80 flex gap-2">
      <span className="text-primary/60 mt-1.5 shrink-0">•</span>
      <span>{children}</span>
    </li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">
      {children}
    </strong>
  ),
  em: ({ children }) => (
    <em className="italic text-foreground/70">{children}</em>
  ),
  hr: () => <hr className="my-5 border-border/20" />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border/30">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-border/40 bg-muted/20">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-border/10">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="hover:bg-muted/10 transition-colors">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2.5 text-left text-xs font-semibold text-foreground/70 uppercase tracking-wider">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2.5 text-sm text-foreground/80">{children}</td>
  ),
});

interface SummaryViewProps {
  meeting: Meeting;
  generation: SummaryGenerationState;
  onExport: () => void;
}

export function SummaryView({ meeting, generation, onExport }: SummaryViewProps) {
  const isOtherStreaming = useStreamStore((s) => s.isStreaming);

  const handleCopy = useCallback(async () => {
    const text = meeting.summary || generation.streamedContent;
    if (text) {
      try {
        await navigator.clipboard.writeText(stripThinkTags(text));
        showToast("Copied to clipboard", "success");
      } catch { showToast("Couldn't copy to clipboard", "error"); }
    }
  }, [meeting.summary, generation.streamedContent]);

  // Streaming
  if (generation.isGenerating) {
    const cleanedStreaming = cleanMarkdown(stripThinkTags(generation.streamedContent));
    return (
      <div className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-primary">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-medium">Generating summary...</span>
          </div>
          <button
            onClick={generation.cancel}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground/50 hover:bg-secondary hover:text-foreground cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
        </div>
        <div>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {cleanedStreaming}
          </ReactMarkdown>
          <span className="inline-block h-4 w-0.5 animate-pulse bg-primary/60 ml-0.5" />
        </div>
      </div>
    );
  }

  // Error
  if (generation.error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          {generation.error}
        </div>
        <button
          onClick={generation.generate}
          className="rounded-xl bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/20 cursor-pointer"
        >
          Regenerate Summary
        </button>
      </div>
    );
  }

  // Has summary
  if (meeting.summary) {
    const cleanedSummary = cleanMarkdown(stripThinkTags(meeting.summary));
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-border/20">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/50">
            <Sparkles className="h-3 w-3" />
            <span>AI Generated</span>
          </div>
          <div className="flex-1" />
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground/60 hover:bg-secondary hover:text-foreground transition-colors cursor-pointer"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
          <button
            onClick={onExport}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground/60 hover:bg-secondary hover:text-foreground transition-colors cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {cleanedSummary}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  // Empty state
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <Sparkles className="mb-4 h-8 w-8 text-primary/20" />
      <p className="mb-1 text-sm font-semibold text-muted-foreground/50">No summary yet</p>
      <p className="mb-5 text-xs text-muted-foreground/40">Generate an AI summary from the transcript</p>
      <button
        onClick={generation.generate}
        disabled={isOtherStreaming || meeting.transcript.length === 0}
        className="flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/10 transition-all duration-200 hover:shadow-lg hover:shadow-primary/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        <Sparkles className="h-4 w-4" />
        Generate Summary
      </button>
    </div>
  );
}
