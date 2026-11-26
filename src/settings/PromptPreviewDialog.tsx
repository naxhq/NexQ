import { useEffect, useCallback, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ActionConfig } from "../lib/types";

interface PromptPreviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  actionConfig: ActionConfig;
  composedInstructions: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function PromptPreviewDialog({
  isOpen,
  onClose,
  actionConfig,
  composedInstructions,
}: PromptPreviewDialogProps) {
  const [isVisible, setIsVisible] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Animate in when opened
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => setIsVisible(true));
    } else {
      setIsVisible(false);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(() => onClose(), 150);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        handleClose();
      }
    },
    [handleClose]
  );

  if (!isOpen) return null;

  // Build the simulated user message sections
  const userMessageSections: string[] = [];

  if (actionConfig.includeRagChunks || actionConfig.includeCustomInstructions) {
    const parts: string[] = [];
    if (actionConfig.includeCustomInstructions && composedInstructions) {
      parts.push(composedInstructions);
    }
    if (actionConfig.includeRagChunks) {
      const topK = actionConfig.ragTopK ?? "default";
      parts.push(`[Top ${topK} relevant chunks from indexed documents]`);
    }
    userMessageSections.push(
      `## Reference Materials\n${parts.join("\n\n")}`
    );
  }

  if (actionConfig.includeTranscript) {
    const windowSeconds = actionConfig.transcriptWindowSeconds;
    const windowLabel = windowSeconds
      ? `last ${windowSeconds}s`
      : "global default window";
    userMessageSections.push(
      `## Meeting Transcript (Recent)\n[Transcript segments from ${windowLabel}]`
    );
  }

  if (actionConfig.includeDetectedQuestion) {
    userMessageSections.push(
      `## Detected Question\n[Most recent question detected from the meeting audio]`
    );
  }

  // Mode-specific instruction
  const modeInstructions: Record<string, string> = {
    Assist: "Provide a helpful, concise answer based on the context above.",
    WhatToSay:
      "Suggest what the user should say next in the conversation.",
    Shorten: "Provide a shorter, more concise version of the response.",
    FollowUp: "Suggest relevant follow-up questions or talking points.",
    Recap: "Provide a brief recap of the conversation so far.",
    AskQuestion:
      "Answer the user's specific question based on available context.",
  };

  const modeInstruction =
    modeInstructions[actionConfig.mode] ??
    `[Mode-specific instruction for "${actionConfig.mode}"]`;
  userMessageSections.push(modeInstruction);

  const userMessage = userMessageSections.join("\n\n");
  const systemPrompt = actionConfig.systemPrompt;

  const systemTokens = estimateTokens(systemPrompt);
  const userTokens = estimateTokens(userMessage);
  const totalTokens = systemTokens + userTokens;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-150 ${
        isVisible
          ? "bg-background/70"
          : "bg-background/0"
      }`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Prompt preview"
        className={`w-full max-w-[600px] max-h-[80vh] flex flex-col rounded-xl border border-border/50 bg-card shadow-2xl transition-all duration-150 ${
          isVisible
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 translate-y-2"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/30 px-5 py-3.5">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Prompt Preview
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {actionConfig.name} &mdash; {actionConfig.mode} mode
            </p>
          </div>
          <button
            autoFocus
            onClick={handleClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            title="Close (Esc)"
            aria-label="Close prompt preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* System Prompt Section */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
              System Prompt
            </h3>
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3">
              <pre className="font-mono text-xs text-foreground whitespace-pre-wrap break-words">
                {systemPrompt || "(empty)"}
              </pre>
            </div>
            <p className="text-meta text-muted-foreground mt-1.5">
              ~{systemTokens.toLocaleString()} tokens
              {actionConfig.isDefaultPrompt && (
                <span className="ml-2 text-muted-foreground/70">
                  (default prompt)
                </span>
              )}
            </p>
          </div>

          {/* User Message Section */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
              User Message
            </h3>
            <div className="rounded-lg border border-border/30 bg-muted/30 p-3">
              <pre className="font-mono text-xs text-foreground whitespace-pre-wrap break-words">
                {userMessage}
              </pre>
            </div>
            <p className="text-meta text-muted-foreground mt-1.5">
              ~{userTokens.toLocaleString()} tokens
            </p>
          </div>

          {/* Included Sections Summary */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
              Included Sections
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              <SectionBadge
                label="Transcript"
                active={actionConfig.includeTranscript}
                detail={
                  actionConfig.includeTranscript
                    ? actionConfig.transcriptWindowSeconds
                      ? `${actionConfig.transcriptWindowSeconds}s window`
                      : "default window"
                    : undefined
                }
              />
              <SectionBadge
                label="RAG Chunks"
                active={actionConfig.includeRagChunks}
                detail={
                  actionConfig.includeRagChunks
                    ? `top ${actionConfig.ragTopK ?? "default"}`
                    : undefined
                }
              />
              <SectionBadge
                label="Custom Instructions"
                active={actionConfig.includeCustomInstructions}
              />
              <SectionBadge
                label="Detected Question"
                active={actionConfig.includeDetectedQuestion}
              />
            </div>
          </div>

          {/* Token Estimate */}
          <div className="rounded-lg border border-border/30 bg-muted/20 px-4 py-3 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Estimated total tokens
            </span>
            <span className="text-sm font-semibold text-foreground tabular-nums">
              ~{totalTokens.toLocaleString()}
            </span>
          </div>

          {/* Parameters */}
          {actionConfig.temperature !== null && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">
                Parameters
              </h3>
              <div className="flex gap-3">
                <div className="rounded-md border border-border/30 bg-muted/20 px-3 py-1.5">
                  <span className="text-meta text-muted-foreground">
                    Temperature
                  </span>
                  <p className="text-xs font-medium text-foreground">
                    {actionConfig.temperature}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionBadge({
  label,
  active,
  detail,
}: {
  label: string;
  active: boolean;
  detail?: string;
}) {
  return (
    <div
      className={`rounded-md border px-2.5 py-1.5 text-xs ${
        active
          ? "border-primary/30 bg-primary/5 text-foreground"
          : "border-border/20 bg-muted/10 text-muted-foreground/70 line-through"
      }`}
    >
      {label}
      {active && detail && (
        <span className="ml-1.5 text-meta text-muted-foreground">
          ({detail})
        </span>
      )}
    </div>
  );
}
