import { lazy, Suspense } from "react";
import type { RichEditorProps } from "./RichEditor";

/**
 * TipTap and ProseMirror are about 300 kB; the launcher and the meeting window
 * start without them and fetch the chunk the first time someone edits a note.
 */
const RichEditor = lazy(() => import("./RichEditor"));

export type { RichEditorHandle, RichEditorProps } from "./RichEditor";

export function LazyRichEditor(props: RichEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="ui-body py-6 text-muted-foreground" role="status">
          Opening the editor
        </div>
      }
    >
      <RichEditor {...props} />
    </Suspense>
  );
}
