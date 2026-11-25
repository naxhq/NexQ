import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { TalkingPoint } from "../lib/types";
import { useTalkingPointsStore, type SaveState } from "../stores/talkingPointsStore";
import { Menu, Switch, buttonClass } from "../ui";
import { LazyRichEditor } from "./editor/LazyRichEditor";
import { docToMarkdown } from "./doc/markdown";
import { cleanTitle, parseDoc } from "./doc/model";
import { saveExportFile } from "../lib/export";
import { cn } from "../lib/utils";

export function SaveStatus({ state, error, onRetry }: { state: SaveState | undefined; error?: string | null; onRetry: () => void }) {
  if (state === "failed") {
    return (
      <span className="ui-meta inline-flex items-center gap-2 text-destructive" role="alert">
        Not saved{error ? `: ${error}` : ""}. It keeps trying.
        <button type="button" onClick={onRetry} className="rounded-md px-1.5 py-0.5 font-medium underline underline-offset-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60">
          Try now
        </button>
      </span>
    );
  }
  const text = state === "saving" ? "Saving" : state === "dirty" ? "Unsaved changes" : "Saved";
  return (
    <span className="ui-meta text-muted-foreground" role="status" aria-live="polite">
      {text}
    </span>
  );
}

/** One note: title, "Use as AI context", the editor and its save state. */
export function NoteEditorPane({ note }: { note: TalkingPoint }) {
  const edit = useTalkingPointsStore((s) => s.edit);
  const retry = useTalkingPointsStore((s) => s.retry);
  const state = useTalkingPointsStore((s) => s.saveState[note.id]);
  const error = useTalkingPointsStore((s) => s.saveError[note.id]);
  const [title, setTitle] = useState(note.title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setTitle(note.title);
  }, [note.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitTitle = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const clean = cleanTitle(value, "Untitled note");
    if (clean !== note.title) edit(note.id, { title: clean });
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const markdown = () => docToMarkdown(parseDoc(note.doc_json));

  return (
    <section aria-label={`Editing ${note.title}`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3">
        <input
          type="text"
          value={title}
          maxLength={160}
          aria-label="Note title"
          placeholder="Untitled note"
          onChange={(e) => {
            setTitle(e.target.value);
            if (timer.current) clearTimeout(timer.current);
            const v = e.target.value;
            timer.current = setTimeout(() => commitTitle(v), 600);
          }}
          onBlur={(e) => commitTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="ui-title min-w-[10rem] flex-1 truncate rounded-md bg-transparent px-1 py-0.5 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60"
        />
        <SaveStatus state={state} error={error} onRetry={() => retry(note.id)} />
        <Menu
          label="More for this note"
          align="end"
          items={[
            {
              id: "export",
              label: "Export as Markdown",
              onSelect: () => void saveExportFile({ defaultName: note.title, extension: "md", filterLabel: "Markdown", content: markdown() }),
            },
            {
              id: "copy",
              label: copied ? "Copied" : "Copy Markdown",
              onSelect: () => {
                void navigator.clipboard?.writeText(markdown()).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              },
            },
          ]}
          renderTrigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label="More for this note"
              className={cn(buttonClass.base, "w-8 px-0 text-muted-foreground hover:bg-accent hover:text-foreground")}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </button>
          )}
        />
      </header>
      <Switch
        className="pb-3"
        checked={note.in_context}
        onChange={(in_context) => edit(note.id, { in_context })}
        label="Use as AI context"
        description="Live answers and the workspace chat can draw on this note."
      />
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <LazyRichEditor
          docJson={note.doc_json}
          resetKey={note.id}
          ariaLabel={`Text of ${note.title}`}
          onChange={(doc) => edit(note.id, { doc })}
        />
      </div>
    </section>
  );
}
