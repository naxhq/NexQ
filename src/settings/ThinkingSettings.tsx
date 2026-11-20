import { useEffect, useId, useState } from "react";
import { useConfigStore } from "../stores/configStore";
import type { LLMProviderType, ThinkingSetting } from "../lib/types";
import {
  THINKING_OPTIONS,
  extraJsonError,
  normalizeThinking,
  supportsExtraJson,
  supportsThinking,
} from "../lib/llmRequestOptions";

/**
 * Per-provider "Thinking" choice, plus (Ollama, LM Studio, OpenRouter, custom)
 * an advanced "Extra request JSON" merged into the request. Both are saved with
 * the provider and shared with every window.
 */
export function ThinkingSettings({ provider }: { provider: LLMProviderType }) {
  const thinking = useConfigStore((s) => s.llmThinking[provider]) ?? "auto";
  const savedJson = useConfigStore((s) => s.llmExtraRequestJson[provider]) ?? "";
  const setThinking = useConfigStore((s) => s.setLlmThinking);
  const setExtraJson = useConfigStore((s) => s.setLlmExtraRequestJson);

  const selectId = useId();
  const jsonId = useId();
  const hintId = useId();
  const errorId = useId();

  const [draft, setDraft] = useState(savedJson);
  // Another window changed it, or another provider is shown: follow the saved value,
  // unless this draft is an unsaved invalid edit in progress.
  const draftError = extraJsonError(draft);
  useEffect(() => {
    setDraft((current) => (extraJsonError(current) === null || current === savedJson ? savedJson : current));
  }, [savedJson, provider]);

  if (!supportsThinking(provider)) return null;
  const showJson = supportsExtraJson(provider);

  return (
    <div className="space-y-4 rounded-xl border border-border/30 bg-card/50 p-5">
      <div>
        <label htmlFor={selectId} className="mb-1.5 block text-sm font-semibold text-primary/80">
          Thinking
        </label>
        <select
          id={selectId}
          value={thinking}
          aria-describedby={hintId}
          onChange={(e) => setThinking(provider, normalizeThinking(e.target.value) as ThinkingSetting)}
          className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 cursor-pointer"
        >
          {THINKING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
          Off answers faster. Not every model supports it; NexQ falls back automatically.
        </p>
      </div>

      {showJson && (
        <details className="group rounded-lg border border-border/30 bg-accent/10 px-3.5 py-2.5">
          <summary className="cursor-pointer text-xs font-medium text-foreground select-none">
            Advanced: extra request JSON
          </summary>
          <div className="mt-3">
            <label htmlFor={jsonId} className="mb-1.5 block text-xs font-medium text-foreground">
              Extra request JSON
            </label>
            <textarea
              id={jsonId}
              value={draft}
              rows={4}
              spellCheck={false}
              maxLength={4000}
              placeholder={provider === "ollama" ? '{"options": {"num_ctx": 8192}}' : '{"top_p": 0.9}'}
              aria-invalid={draftError !== null}
              aria-describedby={draftError ? errorId : undefined}
              onChange={(e) => {
                const text = e.target.value;
                setDraft(text);
                // Only valid JSON (or nothing) is ever saved or sent.
                if (extraJsonError(text) === null) setExtraJson(provider, text);
              }}
              className="w-full rounded-lg border border-border/50 bg-background px-3.5 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
            {draftError ? (
              <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">
                {draftError}. Nothing is sent until it is fixed.
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-muted-foreground">
                A JSON object merged into each request after NexQ's own fields.
                {provider === "ollama" ? ' "options" is merged key by key.' : ""} "model", "messages" and "stream"
                are ignored.
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
