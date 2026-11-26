import { useState, useEffect, useRef, useCallback } from "react";
import { useContextStore } from "../stores/contextStore";

export function CustomInstructions() {
  const customInstructions = useContextStore((s) => s.customInstructions);
  const saveCustomInstructions = useContextStore(
    (s) => s.saveCustomInstructions
  );

  const [localText, setLocalText] = useState(customInstructions);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync from store when it changes externally
  useEffect(() => {
    setLocalText(customInstructions);
  }, [customInstructions]);

  // Debounced save
  const handleChange = useCallback(
    (value: string) => {
      setLocalText(value);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        saveCustomInstructions(value);
      }, 500);
    },
    [saveCustomInstructions]
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const charCount = localText.length;
  // Approximate token count: chars / 4
  const tokenCount = Math.ceil(charCount / 4);

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-semibold text-muted-foreground">
          Custom Instructions
        </label>
        <div className="flex items-center gap-3 text-meta text-muted-foreground/70">
          <span>{charCount} chars</span>
          <span>~{tokenCount} tokens</span>
        </div>
      </div>
      <textarea
        value={localText}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Add custom instructions for AI responses..."
        rows={3}
        maxLength={5000}
        className="w-full resize-none rounded-xl border border-border/40 bg-secondary/20 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-ring focus:bg-secondary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
      />
    </div>
  );
}
