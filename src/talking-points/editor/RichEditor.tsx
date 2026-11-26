/**
 * The TipTap editor. This file and everything it imports from @tiptap is one lazy
 * chunk (see `LazyRichEditor`); the reader and the lists never load it.
 *
 * The formatting bar is part of the layout and never follows the caret: docked in the
 * host the page gives it (`toolbarHost`), or at the top of the editor when there is none
 * (the meeting panel). The word count and speaking time sit in a quiet footer line
 * (`footerHost`, or under the text).
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { createExtensions } from "./extensions";
import { FormatToolbar } from "./FormatToolbar";
import {
  countWords,
  DEFAULT_WPM,
  docPlainText,
  parseDoc,
  sanitizeDoc,
  serializeDoc,
  speakingTime,
  type TpDoc,
} from "../doc/model";
import { markdownToDoc } from "../doc/markdown";
import { outsideTextProps } from "./pasteFilter";
import { cn } from "../../lib/utils";
import "../talkingPoints.css";

export interface RichEditorHandle {
  focus: () => void;
  /** Replaces the whole document (undoable). */
  setDoc: (doc: TpDoc) => void;
  getDoc: () => TpDoc;
}

export interface RichEditorProps {
  /** Document JSON text to start from. Changing `resetKey` loads it again. */
  docJson: string;
  /** Usually the note id; a new key swaps the document without remounting. */
  resetKey: string;
  onChange: (doc: TpDoc) => void;
  ariaLabel: string;
  autoFocus?: boolean;
  /** Narrow places (the meeting panel): tighter type, a boxed toolbar above the text. */
  compact?: boolean;
  /**
   * Where the formatting bar is drawn: an element the page keeps pinned above the text.
   * `null` means the page's element is not there yet (nothing is drawn); leave it out to
   * dock the bar at the top of the editor itself.
   */
  toolbarHost?: HTMLElement | null;
  /** Where the word count goes (same rule as `toolbarHost`). */
  footerHost?: HTMLElement | null;
  className?: string;
  showCounts?: boolean;
  wpm?: number;
  handleRef?: Ref<RichEditorHandle>;
}

export default function RichEditor({
  docJson,
  resetKey,
  onChange,
  ariaLabel,
  autoFocus,
  compact,
  toolbarHost,
  footerHost,
  className,
  showCounts = true,
  wpm = DEFAULT_WPM,
  handleRef,
}: RichEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [counts, setCounts] = useState(() => countWords(docPlainText(parseDoc(docJson))));
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const editor = useEditor({
    extensions: createExtensions(),
    content: parseDoc(docJson) as never,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ariaLabel,
        spellcheck: "true",
        class: "tp-doc tp-prose outline-none",
      },
      // text from outside (paste and drop) is cleaned by the one shared rule; typed text is untouched
      ...outsideTextProps,
      handleDrop: () => false,
    },
    onUpdate: ({ editor: ed }) => {
      const doc = sanitizeDoc(ed.getJSON());
      setCounts(countWords(docPlainText(doc)));
      onChangeRef.current(doc);
    },
  });

  // New note: swap the document without a remount; the history of the old one is dropped.
  const lastKey = useRef(resetKey);
  useEffect(() => {
    if (!editor || lastKey.current === resetKey) return;
    const prevNote = lastKey.current.split(":")[0];
    lastKey.current = resetKey;
    const incoming = parseDoc(docJson);
    const sameNote = prevNote === resetKey.split(":")[0];
    // the same text again (our own save coming back) is not a change: nothing moves under the caret
    if (sameNote && serializeDoc(sanitizeDoc(editor.getJSON())) === serializeDoc(incoming)) return;
    const { from, to } = editor.state.selection;
    const hadFocus = editor.isFocused;
    editor.commands.setContent(incoming as never, { emitUpdate: false });
    if (sameNote && hadFocus) {
      // a real change from elsewhere: keep the caret where it was, clamped to the new text
      const max = editor.state.doc.content.size;
      editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
    }
    setCounts(countWords(docPlainText(incoming)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, resetKey]);

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => editor?.commands.focus("end"),
      setDoc: (doc) => {
        editor?.commands.setContent(sanitizeDoc(doc) as never, { emitUpdate: true });
      },
      getDoc: () => (editor ? sanitizeDoc(editor.getJSON()) : parseDoc(docJson)),
    }),
    [editor, docJson],
  );

  const keyDown = useCallback((e: React.KeyboardEvent) => {
    // Everything typed in the editor stays in the editor (Space, digits, letters are not meeting keys here).
    if (e.key !== "Escape") e.stopPropagation();
  }, []);

  if (!editor) return null;
  const countsLine = (
    <p className={cn("ui-meta text-muted-foreground", footerHost === undefined && "mt-3")} aria-live="off">
      {counts} {counts === 1 ? "word" : "words"}, about {speakingTime(counts, wpm)} to say
    </p>
  );
  const bar = <FormatToolbar editor={editor as Editor} compact={compact} />;
  return (
    <div ref={wrapRef} className={cn("tp-editor relative", compact && "tp-editor-compact", className)} onKeyDown={keyDown}>
      {toolbarHost === undefined ? (
        compact ? (
          <div className="sticky top-0 z-10 bg-popover">{bar}</div>
        ) : (
          <div className="sticky top-0 z-10 border-b border-border bg-background">{bar}</div>
        )
      ) : (
        toolbarHost && createPortal(bar, toolbarHost)
      )}
      <EditorContent editor={editor} />
      {showCounts && (footerHost === undefined ? countsLine : footerHost && createPortal(countsLine, footerHost))}
    </div>
  );
}
