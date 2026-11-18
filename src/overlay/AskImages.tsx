import { useCallback, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ImageAttachment } from "../lib/types";
import { imageFilesFrom, imageProblem, previewSrc, readImage } from "../lib/imageAttachments";
import { showToast } from "../stores/toastStore";

/**
 * Sent when an image is pasted and the question box is left empty. The image is
 * the task itself (a question, an exercise), not something to describe.
 */
export const DEFAULT_IMAGE_QUESTION =
  "The attached image is the task or question to handle. Read it and answer or solve it directly, in the context of the meeting. Do not describe the image.";

/**
 * Images pasted (Ctrl+V) into an Ask box. A paste with no image is left alone,
 * so plain text pastes as usual.
 */
export function useAskImages() {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  // The count a quick second paste must see, before React re-renders.
  const count = useRef(0);

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const files = imageFilesFrom(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    void (async () => {
      const added: ImageAttachment[] = [];
      for (const file of files) {
        const problem = imageProblem(file, count.current);
        if (problem) {
          showToast(problem, "error");
          break;
        }
        try {
          added.push(await readImage(file));
          count.current += 1;
        } catch {
          showToast("Couldn't read the image", "error");
        }
      }
      if (added.length > 0) setImages((prev) => [...prev, ...added]);
    })();
  }, []);

  const remove = useCallback((index: number) => {
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== index);
      count.current = next.length;
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    count.current = 0;
    setImages([]);
  }, []);

  return { images, onPaste, remove, clear };
}

/** The pasted images as small previews, each with a remove button. */
export function AskImageChips({ images, onRemove }: { images: ImageAttachment[]; onRemove: (index: number) => void }) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Attached images">
      {images.map((image, i) => (
        <div key={i} className="relative h-8 w-12 overflow-hidden rounded-md border border-border/30 bg-black/20">
          <img src={previewSrc(image)} alt={`Attached image ${i + 1}`} className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="absolute right-0 top-0 rounded-bl-md bg-black/60 p-0.5 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
            title="Remove image"
            aria-label={`Remove image ${i + 1}`}
          >
            <X className="h-2.5 w-2.5" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
