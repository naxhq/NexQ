import { useCallback, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ImageAttachment } from "../lib/types";
import {
  MAX_IMAGES,
  clipboardHasText,
  imageFilesFrom,
  imageProblem,
  prepareImage,
  providerReadsImages,
  previewSrc,
} from "../lib/imageAttachments";
import { showToast } from "../stores/toastStore";
import { useConfigStore } from "../stores/configStore";

/** Why a pasted image is refused when the provider can't read images. */
export const IMAGES_NEED_CLAUDE = "Images work only with Claude (subscription). Choose it in Settings > LLM.";

/**
 * The Ask box placeholder. Short enough to show whole in the overlay's Ask box
 * (about 24 characters); it mentions screenshots only where they can be pasted.
 */
export function askPlaceholder(canAttach: boolean): string {
  return canAttach ? "Ask or paste a screenshot" : "Ask about the meeting...";
}

/**
 * Images pasted (Ctrl+V) into an Ask box. A paste that carries text, or no
 * image, is left alone, so plain text pastes as usual. Only the Claude
 * (subscription) provider can read images: with another one a pasted image is
 * refused with a hint instead of being attached and failing on send.
 */
export function useAskImages() {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  // A request with these images is on its way: they aren't shown meanwhile.
  const [sending, setSending] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const canAttach = useConfigStore((s) => providerReadsImages(s.llmProvider));
  // Slots taken so far, including images still being prepared. A slot is reserved
  // before the (async) work starts, so a quick second paste sees it.
  const count = useRef(0);

  /**
   * Attaches image files: from a paste, or the screen-capture shortcut. The
   * provider check, the 3-image limit, the type and size checks and the
   * downscaling are the same for both. Returns whether at least one file was
   * accepted; otherwise a toast already says why.
   */
  const attach = useCallback((files: File[]): boolean => {
    if (files.length === 0) return false;
    if (!providerReadsImages(useConfigStore.getState().llmProvider)) {
      showToast(IMAGES_NEED_CLAUDE, "warning");
      return false;
    }
    const accepted: File[] = [];
    for (const file of files) {
      const problem = imageProblem(file, count.current);
      if (problem) {
        showToast(problem, "error");
        break;
      }
      count.current += 1;
      accepted.push(file);
    }
    if (accepted.length === 0) return false;
    void (async () => {
      const prepared = await Promise.allSettled(accepted.map(prepareImage));
      const added: ImageAttachment[] = [];
      for (const result of prepared) {
        if (result.status === "fulfilled") {
          added.push(result.value);
        } else {
          count.current -= 1;
          showToast(result.reason instanceof Error ? result.reason.message : "Couldn't read the image", "error");
        }
      }
      if (added.length > 0) {
        setImages((prev) => [...prev, ...added]);
        setAnnouncement(`Image attached (${count.current} of ${MAX_IMAGES})`);
      }
    })();
    return true;
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      // Text wins: a copy from Excel, Word or a web page also carries a picture.
      if (clipboardHasText(e.clipboardData)) return;
      const files = imageFilesFrom(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      attach(files);
    },
    [attach],
  );

  const remove = useCallback((index: number) => {
    // One slot back; images still being prepared keep theirs.
    count.current = Math.max(0, count.current - 1);
    setImages((prev) => prev.filter((_, i) => i !== index));
    setAnnouncement("Image removed");
  }, []);

  /**
   * Drops the images that were just sent (by identity) and frees their slots;
   * one attached while the request was on its way stays.
   */
  const removeSent = useCallback((sent: ImageAttachment[]) => {
    if (sent.length === 0) return;
    count.current = Math.max(0, count.current - sent.length);
    setImages((prev) => prev.filter((image) => !sent.includes(image)));
    setAnnouncement("");
  }, []);

  const clear = useCallback(() => {
    count.current = 0;
    setImages([]);
    setAnnouncement("");
  }, []);

  return { images, sending, setSending, canAttach, announcement, onPaste, attach, remove, removeSent, clear };
}

/**
 * The pasted images as small previews, each with a remove button, and a polite
 * announcement for screen readers when one is attached or removed.
 */
export function AskImageChips({
  images,
  onRemove,
  announcement = "",
}: {
  images: ImageAttachment[];
  onRemove: (index: number) => void;
  announcement?: string;
}) {
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {images.length > 0 && (
        <div role="group" className="flex flex-wrap items-center gap-1.5" aria-label="Attached images">
          {images.map((image, i) => (
            <div key={i} className="relative h-8 w-12 overflow-hidden rounded-md border border-border/30 bg-black/20">
              <img src={previewSrc(image)} alt={`Attached image ${i + 1}`} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="absolute right-0 top-0 flex h-6 w-6 items-start justify-end rounded-bl-md p-0.5 text-white/80 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                
                aria-label={`Remove image ${i + 1}`}
              >
                <X className="h-3 w-3 rounded-bl-md bg-black/60 p-px hover:bg-black/80" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
