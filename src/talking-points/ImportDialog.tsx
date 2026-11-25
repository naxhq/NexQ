import { useEffect, useRef, useState } from "react";
import { Dialog, Button } from "../ui";
import { cn } from "../lib/utils";
import { markdownTitle, markdownToDoc } from "./doc/markdown";
import { countWords, docPlainText, type TpDoc } from "./doc/model";

interface Props {
  open: boolean;
  onClose: () => void;
  onImport: (result: { title: string; doc: TpDoc }) => Promise<void> | void;
}

const MAX_FILE_BYTES = 2_000_000;

/** Markdown from a file or pasted text becomes a new note. Links turn to text, images and HTML are dropped. */
export function ImportDialog({ open, onClose, onImport }: Props) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setText("");
      setFileName("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const words = text.trim() ? countWords(docPlainText(markdownToDoc(text))) : 0;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      setError("That file is larger than 2 MB. Notes are meant to be read aloud, so keep them shorter.");
      return;
    }
    try {
      setText(await f.text());
      setFileName(f.name.replace(/\.(md|markdown|txt)$/i, ""));
      setError(null);
    } catch {
      setError("That file could not be read.");
    }
  };

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const doc = markdownToDoc(text);
      await onImport({ title: markdownTitle(text, fileName || "Imported note"), doc });
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Could not import.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import Markdown"
      description="Paste Markdown or choose a file. Headings, lists, bold and italic are kept; links become text and images are left out."
      initialFocusRef={area}
      dismissible={!busy}
      size="lg"
      footer={
        <>
          <Button  onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary"  onClick={() => void submit()} disabled={!text.trim() || busy}>
            Import as a new note
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost"  onClick={() => picker.current?.click()}>
            Choose a file
          </Button>
          <span className="ui-meta min-w-0 truncate text-muted-foreground">{fileName ? `${fileName}` : "Markdown or plain text"}</span>
          <input
            ref={picker}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="sr-only"
            tabIndex={-1}
            aria-label="Markdown file"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Markdown to import"
          placeholder={"# Opening\n\n- What I want them to remember\n- The one number that matters"}
          rows={10}
          spellCheck={false}
          className="ui-body block max-h-[50vh] w-full resize-y rounded-lg border border-border bg-background p-3 font-[inherit] outline-none ui-focus ui-r-lg"
        />
        <p className="ui-meta text-muted-foreground" aria-live="polite">
          {words > 0 ? `${words} ${words === 1 ? "word" : "words"} will be imported.` : "Nothing to import yet."}
        </p>
        {error && (
          <p role="alert" className="ui-meta text-destructive">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
