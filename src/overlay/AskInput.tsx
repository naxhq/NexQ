import { useState, useCallback, useRef, useEffect } from "react";
import { useStreamStore } from "../stores/streamStore";
import { runYourAction, useAutoAnswerRunning } from "../lib/autoAnswer";
import { showToast } from "../stores/toastStore";
import { Send, X } from "lucide-react";

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

  // Focus the input when made visible
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [visible]);

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || locked) return;

    // Send question in AskQuestion mode (with the picked transcript scope)
    runYourAction("AskQuestion", text).catch((err) => {
      const msg = err instanceof Error ? err.message : "Failed to send question";
      showToast(msg, "error");
    });
    setInputText("");
    onClose();
  }, [inputText, locked, onClose]);

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
    <div className="flex items-center gap-2 rounded-xl border border-border/20 bg-card/50 px-3 py-1.5">
      <input
        ref={inputRef}
        type="text"
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask about the meeting..."
        aria-label="Ask a question"
        disabled={locked}
        maxLength={2000}
        className="flex-1 bg-transparent text-xs text-foreground/90 placeholder:text-muted-foreground/50 outline-none"
      />
      <button
        onClick={handleSubmit}
        disabled={!inputText.trim() || locked}
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
  );
}
