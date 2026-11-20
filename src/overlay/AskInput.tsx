import { useState, useCallback, useRef, useEffect } from "react";
import { useStreamStore } from "../stores/streamStore";
import { runYourAction, useAutoAnswerRunning } from "../lib/autoAnswer";
import { showToast } from "../stores/toastStore";
import { Send, X } from "lucide-react";
import { AskImageChips, DEFAULT_IMAGE_QUESTION, useAskImages } from "./AskImages";

interface AskInputProps {
  visible: boolean;
  onClose: () => void;
}

// Sub-PRD 6: Text input for manual questions (Ctrl+5 / Ask mode)
export function AskInput({ visible, onClose }: AskInputProps) {
  const [inputText, setInputText] = useState("");
  const isStreaming = useStreamStore((s) => s.isStreaming);
  // An automatic answer gives way to what you ask; an answer you asked for does not.
  const autoRunning = useAutoAnswerRunning();
  const locked = isStreaming && !autoRunning;
  const inputRef = useRef<HTMLInputElement>(null);
  const { images, onPaste, remove, clear } = useAskImages();
  const canSend = (inputText.trim().length > 0 || images.length > 0) && !locked;

  // Focus the input when made visible
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [visible]);

  const handleSubmit = useCallback(() => {
    const text = inputText.trim() || (images.length > 0 ? DEFAULT_IMAGE_QUESTION : "");
    if (!text || locked) return;

    // Send question in AskQuestion mode (with the picked transcript scope)
    const withImages = images.length > 0;
    runYourAction("AskQuestion", text, images).then(clear, (err) => {
      // A failed send keeps the images, so they don't have to be pasted again.
      // Tauri rejects with plain text. With an image, say why it couldn't go
      // (e.g. the provider can't take images) instead of a generic failure.
      const msg =
        err instanceof Error ? err.message : withImages && typeof err === "string" ? err : "Failed to send question";
      showToast(msg, "error");
    });
    setInputText("");
    onClose();
  }, [inputText, images, locked, onClose, clear]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Prevent Space hotkey from bubbling while input is focused
      e.stopPropagation();

      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [handleSubmit, onClose]
  );

  if (!visible) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border/20 bg-card/50 px-3 py-1.5">
      <AskImageChips images={images} onRemove={remove} />
      <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder="Ask about the meeting... (Ctrl+V to attach a screenshot)"
        aria-label="Ask a question"
        disabled={locked}
        maxLength={2000}
        className="flex-1 bg-transparent text-xs text-foreground/90 placeholder:text-muted-foreground/50 outline-none"
      />
      <button
        onClick={handleSubmit}
        disabled={!canSend}
        className="rounded-lg p-1.5 text-primary transition-colors duration-150 hover:bg-primary/10 hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed"
        title="Send (Enter)"
        aria-label="Send question"
      >
        <Send className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onClose}
        className="rounded-lg p-1.5 text-muted-foreground/60 transition-colors duration-150 hover:bg-accent hover:text-muted-foreground"
        title="Close (Esc)"
        aria-label="Close ask input"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      </div>
    </div>
  );
}
