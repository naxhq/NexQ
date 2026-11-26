import { useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import type { TalkingPoint } from "../lib/types";
import { useTalkingPointsStore, type SaveState } from "../stores/talkingPointsStore";
import { Button, InfoTip, Menu, Switch } from "../ui";
import { LazyRichEditor } from "./editor/LazyRichEditor";
import type { RichEditorHandle } from "./editor/RichEditor";
import { docToMarkdown } from "./doc/markdown";
import { cleanTitle, parseDoc } from "./doc/model";
import { saveExportFile } from "../lib/export";
import { cn } from "../lib/utils";
import "./noteEditor.css";

export function SaveStatus({
  state,
  error,
  onRetry,
  onResolve,
  onSeeBoth,
}: {
  state: SaveState | undefined;
  error?: string | null;
  onRetry: () => void;
  onResolve?: (which: "mine" | "theirs") => void;
  onSeeBoth?: () => void;
}) {
  if (state === "conflict") {
    const b = "rounded-md px-1.5 py-0.5 font-medium underline underline-offset-2 outline-none hover:bg-accent ui-focus ui-r-md";
    return (
      <span className="ui-meta inline-flex flex-wrap items-center gap-2 text-destructive" role="alert">
        Changed in another window.
        <button type="button" className={b} onClick={() => onResolve?.("mine")}>
          Keep mine
        </button>
        <button type="button" className={b} onClick={() => onResolve?.("theirs")}>
          Use theirs
        </button>
        {onSeeBoth && (
          <button type="button" className={b} onClick={onSeeBoth}>
            See both
          </button>
        )}
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="ui-meta inline-flex flex-wrap items-center gap-2 text-destructive" role="alert">
        Not saved{error ? `: ${error}` : ""}. It keeps trying.
        <button type="button" onClick={onRetry} className="rounded-md px-1.5 py-0.5 font-medium underline underline-offset-2 outline-none hover:bg-accent ui-focus ui-r-md">
          Try now
        </button>
      </span>
    );
  }
  const text = state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes" : "Saved";
  return (
    <span className="ui-meta text-muted-foreground" role="status" aria-live="polite">
      {text}
    </span>
  );
}

/**
 * The quiet save state for a dialog header. What went wrong with a failed save or a conflict, and what
 * to do about it, is drawn by the note itself (`SaveStatus`); the badge only says that it needs a look.
 */
export function SaveBadge({ noteId }: { noteId: string | null }) {
  const state = useTalkingPointsStore((s) => (noteId ? s.saveState[noteId] : undefined));
  if (!noteId) return null;
  const bad = state === "failed" || state === "conflict";
  const text = state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes" : state === "failed" ? "Not saved" : state === "conflict" ? "Needs a look" : "Saved";
  return (
    <span className={cn("ui-meta inline-flex items-center gap-1.5", bad ? "font-medium text-destructive" : "text-muted-foreground")} role="status" aria-live="polite">
      {state === "saving" ? (
        <span aria-hidden className="progress-breathe h-1.5 w-1.5 rounded-full bg-primary" />
      ) : state === "dirty" ? (
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
      ) : bad ? (
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-destructive" />
      ) : (
        <Check className="h-3 w-3 text-success" aria-hidden />
      )}
      {text}
    </span>
  );
}

const DEFAULT_TITLE = "Untitled note";

/**
 * One note: a row with its title (a plain one-line field), the "Use as AI context" chip and the menu,
 * then the body, a writing surface of its own. The formatting bar belongs to the body only: it sits on
 * the body's top edge and the word count in its footer, both drawn by the editor into the two hosts
 * below, so they stay put while a long note scrolls.
 */
export function NoteEditorPane({ note, autoFocusTitle = false }: { note: TalkingPoint; autoFocusTitle?: boolean }) {
  const edit = useTalkingPointsStore((s) => s.edit);
  const retry = useTalkingPointsStore((s) => s.retry);
  const setInContext = useTalkingPointsStore((s) => s.setInContext);
  const resolve = useTalkingPointsStore((s) => s.resolveConflict);
  const loadTheirs = useTalkingPointsStore((s) => s.loadTheirs);
  const theirs = useTalkingPointsStore((s) => s.theirs[note.id]);
  const [both, setBoth] = useState(false);
  const rev = useTalkingPointsStore((s) => s.docRev[note.id] ?? 0);
  const state = useTalkingPointsStore((s) => s.saveState[note.id]);
  const error = useTalkingPointsStore((s) => s.saveError[note.id]);
  // the default name shows as the placeholder: an untouched note invites a title instead of looking named
  const [title, setTitle] = useState(note.title === DEFAULT_TITLE ? "" : note.title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ title, note });
  latest.current = { title, note };
  const [copied, setCopied] = useState(false);
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  const editorRef = useRef<RichEditorHandle | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTitle(note.title === DEFAULT_TITLE ? "" : note.title);
  }, [note.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (autoFocusTitle) titleRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commitTitle = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const clean = cleanTitle(value, DEFAULT_TITLE);
    if (clean !== note.title) edit(note.id, { title: clean });
  };
  // closing the dialog right after typing a title must not drop it
  useEffect(
    () => () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      const { title: t, note: n } = latest.current;
      const clean = cleanTitle(t, DEFAULT_TITLE);
      if (clean !== n.title) useTalkingPointsStore.getState().edit(n.id, { title: clean });
    },
    [],
  );

  const markdown = () => docToMarkdown(parseDoc(note.doc_json));
  const trouble = state === "failed" || state === "conflict";

  return (
    <section aria-label={`Editing ${note.title}`} className="flex min-h-0 flex-1 flex-col gap-3">
      {/* the note's own row: its title, whether the AI may draw on it, and its menu. The title is plain text. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <input
          ref={titleRef}
          type="text"
          value={title}
          maxLength={160}
          aria-label="Note title"
          placeholder={DEFAULT_TITLE}
          onChange={(e) => {
            setTitle(e.target.value);
            if (timer.current) clearTimeout(timer.current);
            const v = e.target.value;
            timer.current = setTimeout(() => commitTitle(v), 600);
          }}
          onBlur={(e) => commitTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              editorRef.current?.focus();
            }
          }}
          className="tp-field h-12 min-w-[12rem] flex-1 basis-[14rem] rounded-xl px-4 text-[1.5rem] font-semibold leading-tight tracking-tight text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground"
        />
        <div
          data-tp-context=""
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-0.5 rounded-lg border pl-3 pr-1 transition-colors",
            note.in_context ? "border-primary/50 bg-primary/10" : "border-border bg-muted/40",
          )}
        >
          <Switch
            className="items-center gap-2 [&>button]:mt-0"
            checked={note.in_context}
            onChange={(v) => void setInContext(note.id, v)}
            label={<span className={cn("font-medium", note.in_context && "text-primary-text")}>Use as AI context</span>}
          />
          <InfoTip label="About using this note as AI context">Live answers and the workspace chat can draw on this note.</InfoTip>
        </div>
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
            <Button variant="ghost" size="sm" {...props} aria-label="More for this note" className="h-9 w-9 shrink-0 px-0">
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          )}
        />
      </div>
      {trouble && (
        <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2">
          <SaveStatus
            state={state}
            error={error}
            onRetry={() => retry(note.id)}
            onResolve={(w) => void resolve(note.id, w)}
            onSeeBoth={() => {
              setBoth((v) => !v);
              void loadTheirs(note.id);
            }}
          />
          {state === "conflict" && both && (
            <p className="ui-body mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-2.5" aria-label="Their version">
              {theirs ? theirs.plain_text || "(empty)" : "Loading their version"}
            </p>
          )}
        </div>
      )}
      {/* the body: its formatting bar on its top edge (it stays while the text scrolls), the text, the count */}
      <div role="group" aria-label="Note body" data-tp-body="" className="tp-field flex min-h-[14rem] min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
        <div data-tp-toolbar-dock="" className="tp-body-band shrink-0 border-b border-border">
          <div ref={setToolbarHost} className="min-h-[2.75rem] min-w-0" />
        </div>
        <div data-tp-scroll="" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-[46rem] flex-col px-5 py-5 sm:px-8">
            <LazyRichEditor
              docJson={note.doc_json}
              resetKey={`${note.id}:${rev}`}
              ariaLabel={`Text of ${note.title}`}
              toolbarHost={toolbarHost}
              footerHost={footerHost}
              handleRef={editorRef}
              onChange={(doc) => edit(note.id, { doc })}
            />
            {/* the empty page below the text is still the page: a click there puts the caret at the end */}
            <div
              aria-hidden
              className="min-h-16 flex-1 cursor-text"
              onMouseDown={(e) => {
                e.preventDefault();
                editorRef.current?.focus();
              }}
            />
          </div>
        </div>
        <footer ref={setFooterHost} className="tp-body-band flex min-h-9 shrink-0 items-center border-t border-border px-5 py-2 sm:px-8" />
      </div>
    </section>
  );
}
