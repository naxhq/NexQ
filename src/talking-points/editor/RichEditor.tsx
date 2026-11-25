/**
 * The TipTap editor. This file and everything it imports from @tiptap is one lazy
 * chunk (see `LazyRichEditor`); the reader and the lists never load it.
 *
 * Quiet by design: no permanent toolbar. A small floating bar follows the caret
 * while the editor has focus (shortcuts are in every tooltip), and a footer line
 * carries the word count and speaking time.
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { createExtensions } from "./extensions";
import { FloatingToolbar } from "./FloatingToolbar";
import {
  countWords,
  DEFAULT_WPM,
  docPlainText,
  parseDoc,
  sanitizeDoc,
  serializeDoc,
  speakingTime,
  stripHiddenHtml,
  stripHiddenText,
  type TpDoc,
} from "../doc/model";
import { markdownToDoc } from "../doc/markdown";
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
  /** Narrow places (the meeting panel): tighter type, toolbar docked at the top. */
  compact?: boolean;
  className?: string;
  showCounts?: boolean;
  wpm?: number;
  handleRef?: Ref<RichEditorHandle>;
}

const MD_HINT = /^(#{1,3}\s|[-*+]\s|\d+[.)]\s)|\*\*[^*\n]+\*\*/m;

function looksLikeMarkdown(text: string): boolean {
  return text.includes("\n") ? MD_HINT.test(text) : /^(#{1,3}\s|[-*+]\s\S|\d+[.)]\s\S)/.test(text);
}

export default function RichEditor({
  docJson,
  resetKey,
  onChange,
  ariaLabel,
  autoFocus,
  compact,
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
      // text from outside loses what nobody can see (zero-width spaces, bidi overrides); joiners stay
      transformPastedHTML: (html) => stripHiddenHtml(html),
      transformPastedText: (text) => stripHiddenText(text),
      handlePaste: (view, event) => {
        // Plain text that is Markdown becomes formatted blocks; HTML goes through the schema.
        const cd = event.clipboardData;
        if (!cd || cd.types.includes("text/html")) return false;
        const text = stripHiddenText(cd.getData("text/plain"));
        if (!text || !looksLikeMarkdown(text)) return false;
        const doc = markdownToDoc(text);
        const { state } = view;
        const node = state.schema.nodeFromJSON({ type: "doc", content: doc.content });
        view.dispatch(state.tr.replaceSelection(node.slice(0, node.content.size, true)).scrollIntoView());
        return true;
      },
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
  return (
    <div ref={wrapRef} className={cn("tp-editor relative", compact && "tp-editor-compact", className)} onKeyDown={keyDown}>
      <FloatingToolbar editor={editor as Editor} container={wrapRef} compact={compact} />
      <EditorContent editor={editor} />
      {showCounts && (
        <p className="ui-meta mt-3 text-muted-foreground" aria-live="off">
          {counts} {counts === 1 ? "word" : "words"}, about {speakingTime(counts, wpm)} to say
        </p>
      )}
    </div>
  );
}
