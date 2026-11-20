import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useStreamStore } from "../stores/streamStore";
import { useMeetingStore } from "../stores/meetingStore";
import {
  Sparkles,
  Pin,
  PinOff,
  Copy,
  Check,
  Globe,
  History,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getModeLabel } from "../lib/utils";
import type { AIResponse, StreamSource } from "../lib/types";
import { useConfigStore } from "../stores/configStore";
import { ColorPickerButton } from "../components/ColorPickerButton";
import { ResponseProgress } from "./ResponseProgress";
import { ResponseHistoryList } from "./ResponseHistoryList";
import { formatDuration } from "./responseFormat";
import { SourceChips } from "../sources/SourceChips";
import { SourceActivityLines, SourceNotices } from "../sources/SourceActivityLines";

/** "current", "resp-<id>" (a history answer) or "pinned-<id>". */
type TabId = "current" | `resp-${string}` | `pinned-${string}`;

/** Answers shown as tabs next to "Current"; the rest are in History. */
const PREVIOUS_TABS = 4;

// Sub-PRD 6: Streaming markdown, response history tabs, pin/copy
export function AIResponsePanel() {
  const isStreaming = useStreamStore((s) => s.isStreaming);
  const phase = useStreamStore((s) => s.phase);
  const currentContent = useStreamStore((s) => s.currentContent);
  const currentMode = useStreamStore((s) => s.currentMode);
  const currentId = useStreamStore((s) => s.currentId);
  const error = useStreamStore((s) => s.error);
  const currentSources = useStreamStore((s) => s.currentSources);
  const currentActivity = useStreamStore((s) => s.currentActivity);
  const currentNotices = useStreamStore((s) => s.currentNotices);
  const responseHistory = useStreamStore((s) => s.responseHistory);
  const pinnedResponses = useStreamStore((s) => s.pinnedResponses);
  const pinResponse = useStreamStore((s) => s.pinResponse);
  const unpinResponse = useStreamStore((s) => s.unpinResponse);
  const meetingStart = useMeetingStore((s) => s.meetingStartTime);

  const aiResponseFontSize = useConfigStore((s) => s.aiResponseFontSize ?? 12);
  const aiResponseTextColor = useConfigStore((s) => s.aiResponseTextColor ?? "#d4d4d8");
  const aiResponseLineHeight = useConfigStore((s) => s.aiResponseLineHeight ?? 1.6);
  const aiResponseHPad = useConfigStore((s) => s.aiResponseHPad ?? 0);
  const aiResponseAlign = useConfigStore((s) => s.aiResponseAlign ?? "left");
  const setAiResponseFontSize = useConfigStore((s) => s.setAiResponseFontSize);
  const setAiResponseTextColor = useConfigStore((s) => s.setAiResponseTextColor);
  const setAiResponseLineHeight = useConfigStore((s) => s.setAiResponseLineHeight);
  const setAiResponseHPad = useConfigStore((s) => s.setAiResponseHPad);
  const setAiResponseAlign = useConfigStore((s) => s.setAiResponseAlign);

  const proseStyle = {
    fontSize: `${aiResponseFontSize}px`,
    color: aiResponseTextColor,
    lineHeight: aiResponseLineHeight,
    paddingLeft: `${aiResponseHPad}px`,
    paddingRight: `${aiResponseHPad}px`,
    textAlign: aiResponseAlign as React.CSSProperties["textAlign"],
  };

  const [activeTab, setActiveTab] = useState<TabId>("current");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);

  // A request in flight: clicked (sending) or streaming.
  const inFlight = isStreaming || phase !== "idle";

  // Auto-scroll during streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentContent, isStreaming]);

  // Switch to "current" tab when a new request starts
  useEffect(() => {
    if (inFlight) {
      setActiveTab("current");
      setHistoryOpen(false);
    }
  }, [inFlight]);

  const handleCopy = useCallback(
    async (content: string, id: string) => {
      try {
        await navigator.clipboard.writeText(content);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      } catch {
        // Clipboard access may fail in some contexts
      }
    },
    []
  );

  const pinnedIds = useMemo(() => new Set(pinnedResponses.map((r) => r.id)), [pinnedResponses]);

  const handlePin = useCallback(
    (id: string) => {
      if (pinnedIds.has(id)) {
        unpinResponse(id);
      } else {
        pinResponse(id);
      }
    },
    [pinnedIds, pinResponse, unpinResponse]
  );

  // Tabs: Current, the previous answers (never the current one again), pinned.
  const previousResponses = useMemo(
    () => responseHistory.filter((r) => r.id !== currentId).slice(0, PREVIOUS_TABS),
    [responseHistory, currentId]
  );
  const currentResponse = currentId ? responseHistory.find((r) => r.id === currentId) ?? null : null;
  const hasTabs = previousResponses.length > 0 || pinnedResponses.length > 0;

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    historyButtonRef.current?.focus();
  }, []);

  // Error state
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-xs text-destructive/70">{error}</p>
      </div>
    );
  }

  // The answer a history / pinned tab shows (by id, so new answers never shift it)
  let displayResponse: AIResponse | null = null;
  if (activeTab !== "current") {
    const id = activeTab.replace(/^(resp|pinned)-/, "");
    displayResponse =
      responseHistory.find((r) => r.id === id) ?? pinnedResponses.find((r) => r.id === id) ?? null;
  }
  const displayContent = displayResponse?.content || null;
  const selectedId = activeTab === "current" ? currentId : displayResponse?.id ?? null;
  // An answer opened from History that has no tab of its own.
  const openedFromHistory =
    activeTab.startsWith("resp-") && !previousResponses.some((r) => `resp-${r.id}` === activeTab);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Tabs row */}
      {hasTabs && (
        <div className="mb-2 flex shrink-0 items-center gap-1.5 pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" role="tablist" aria-label="AI response tabs">
            <TabButton
              label="Current"
              active={activeTab === "current"}
              onClick={() => setActiveTab("current")}
            />
            {previousResponses.map((resp) => (
              <TabButton
                key={resp.id}
                label={getModeLabel(resp.mode)}
                active={activeTab === `resp-${resp.id}`}
                onClick={() => setActiveTab(`resp-${resp.id}`)}
                secondary
              />
            ))}
            {pinnedResponses.map((resp) => (
              <TabButton
                key={resp.id}
                label={`${getModeLabel(resp.mode)}`}
                active={activeTab === `pinned-${resp.id}`}
                onClick={() => setActiveTab(`pinned-${resp.id}`)}
                pinned
              />
            ))}
          </div>
          {responseHistory.length > 0 && (
            <button
              ref={historyButtonRef}
              type="button"
              onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
              aria-expanded={historyOpen}
              aria-haspopup="dialog"
              aria-label={`History, ${responseHistory.length} ${responseHistory.length === 1 ? "answer" : "answers"}`}
              className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium transition-colors duration-150 ${
                historyOpen || openedFromHistory
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground/60 hover:bg-muted/30 hover:text-muted-foreground"
              }`}
            >
              <History className="h-2.5 w-2.5" aria-hidden="true" />
              History · <span className="tabular-nums">{responseHistory.length}</span>
            </button>
          )}
        </div>
      )}

      {/* Content area */}
      <div className="relative flex-1 min-h-0">
      {historyOpen && (
        <ResponseHistoryList
          responses={responseHistory}
          pinnedIds={pinnedIds}
          selectedId={selectedId}
          meetingStart={meetingStart}
          onSelect={(id) => {
            setActiveTab(id === currentId ? "current" : `resp-${id}`);
            closeHistory();
          }}
          onClose={closeHistory}
        />
      )}
      <div ref={scrollRef} className="absolute inset-0 overflow-y-auto" role="tabpanel" aria-label="AI response content">
        {/* Request in flight: progress, then the words as they arrive */}
        {activeTab === "current" && inFlight && (
          <div className="space-y-2.5" aria-atomic="false">
            <ResponseProgress />
            <SourceActivityLines lines={currentActivity.map((a) => a.label)} />
            <SourceNotices notices={currentNotices} />
            {currentContent && (
              <div className="prose prose-sm prose-invert max-w-none leading-relaxed" style={proseStyle}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {currentContent}
                </ReactMarkdown>
                <span className="inline-block h-3 w-0.5 animate-pulse bg-primary/60 ml-0.5" />
              </div>
            )}
          </div>
        )}

        {/* Finished current content (not streaming) */}
        {activeTab === "current" && !inFlight && currentContent && (
          <div className="space-y-2.5">
            {currentMode && (
              <AnswerHeader
                response={currentResponse}
                mode={currentMode}
                copied={copiedId === "current"}
                pinned={currentResponse ? pinnedIds.has(currentResponse.id) : false}
                onCopy={() => handleCopy(currentContent, "current")}
                onPin={currentResponse ? () => handlePin(currentResponse.id) : undefined}
              />
            )}
            <SourceNotices notices={currentResponse?.source_notices ?? []} />
            <div className="prose prose-sm prose-invert max-w-none leading-relaxed" style={proseStyle}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {currentContent}
              </ReactMarkdown>
            </div>
            <SourcesList sources={currentSources} />
            <SourceChips chips={currentResponse?.source_chips ?? []} />
          </div>
        )}

        {/* History / pinned tab content */}
        {activeTab !== "current" && displayContent && displayResponse && (
          <div className="space-y-2.5">
            <AnswerHeader
              response={displayResponse}
              mode={displayResponse.mode}
              copied={copiedId === displayResponse.id}
              pinned={pinnedIds.has(displayResponse.id)}
              onCopy={() => handleCopy(displayContent, displayResponse!.id)}
              onPin={() => handlePin(displayResponse!.id)}
            />
            <SourceNotices notices={displayResponse.source_notices ?? []} />
            <div className="prose prose-sm prose-invert max-w-none leading-relaxed" style={proseStyle}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayContent}
              </ReactMarkdown>
            </div>
            <SourcesList sources={displayResponse.sources} />
            <SourceChips chips={displayResponse.source_chips ?? []} />
          </div>
        )}

        {/* Empty state */}
        {activeTab === "current" && !inFlight && !currentContent && (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <Sparkles className="h-5 w-5 text-primary/30" />
            <p className="text-xs text-muted-foreground/50">
              Press <kbd className="mx-0.5 rounded border border-border/30 bg-secondary/30 px-1.5 py-0.5 font-mono text-meta text-foreground/70">Space</kbd> for AI assistance
            </p>
          </div>
        )}
      </div>
      </div>

      {/* Typeset controls */}
      <div className="flex shrink-0 flex-col gap-1 border-t border-border/10 px-1 pt-1.5">
        {/* Row 1: font size + color */}
        <div className="flex items-center gap-3">
          <span className="text-[0.6rem] uppercase tracking-widest text-muted-foreground/40 font-medium">AI Text</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setAiResponseFontSize(Math.max(8, aiResponseFontSize - 1))} className="h-5 w-5 flex items-center justify-center rounded text-[0.6rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Smaller">A</button>
            <span className="text-[0.6rem] tabular-nums text-muted-foreground/50 w-6 text-center">{aiResponseFontSize}</span>
            <button onClick={() => setAiResponseFontSize(Math.min(32, aiResponseFontSize + 1))} className="h-5 w-5 flex items-center justify-center rounded text-[0.75rem] font-medium text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Larger">A</button>
          </div>
          <ColorPickerButton value={aiResponseTextColor} onChange={setAiResponseTextColor} label="AI text color" />
        </div>
        {/* Row 2: line height + horizontal padding + text align */}
        <div className="flex items-center gap-3">
          {/* Line height */}
          <div className="flex items-center gap-1">
            <span className="text-[0.6rem] text-muted-foreground/40">LH</span>
            <button onClick={() => setAiResponseLineHeight(Math.max(1.0, parseFloat((aiResponseLineHeight - 0.1).toFixed(1))))} className="h-5 w-5 flex items-center justify-center rounded text-[0.65rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Decrease line height">−</button>
            <span className="text-[0.6rem] tabular-nums text-muted-foreground/50 w-6 text-center">{aiResponseLineHeight.toFixed(1)}</span>
            <button onClick={() => setAiResponseLineHeight(Math.min(3.0, parseFloat((aiResponseLineHeight + 0.1).toFixed(1))))} className="h-5 w-5 flex items-center justify-center rounded text-[0.65rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Increase line height">+</button>
          </div>
          {/* Horizontal padding */}
          <div className="flex items-center gap-1">
            <span className="text-[0.6rem] text-muted-foreground/40">↔</span>
            <button onClick={() => setAiResponseHPad(Math.max(0, aiResponseHPad - 4))} className="h-5 w-5 flex items-center justify-center rounded text-[0.65rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Decrease margin">−</button>
            <span className="text-[0.6rem] tabular-nums text-muted-foreground/50 w-6 text-center">{aiResponseHPad}</span>
            <button onClick={() => setAiResponseHPad(Math.min(80, aiResponseHPad + 4))} className="h-5 w-5 flex items-center justify-center rounded text-[0.65rem] text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground/70 transition-colors" title="Increase margin">+</button>
          </div>
          {/* Text align */}
          <div className="flex items-center gap-0.5 rounded border border-border/20 overflow-hidden">
            {(["left", "center", "right"] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAiResponseAlign(a)}
                className={`px-1.5 py-0.5 text-[0.6rem] font-medium transition-colors ${aiResponseAlign === a ? "bg-primary/20 text-primary" : "text-muted-foreground/40 hover:text-muted-foreground/70"}`}
                title={`Align ${a}`}
              >
                {a === "left" ? "L" : a === "center" ? "C" : "R"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function SourcesList({ sources }: { sources?: StreamSource[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/10 pt-2">
      <Globe className="h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden="true" />
      {sources.map((source, idx) => (
        <a
          key={`${source.url}-${idx}`}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          title={source.url}
          className="max-w-[14rem] truncate rounded-full bg-accent/30 px-2 py-0.5 text-meta text-muted-foreground/70 hover:bg-accent/50 hover:text-foreground/80 transition-colors"
        >
          {source.title}
        </a>
      ))}
    </div>
  );
}

/** Mode badge, scope and timing ("1.2 s · first words 0.6 s"), with copy / pin. */
function AnswerHeader({
  response,
  mode,
  copied,
  pinned,
  onCopy,
  onPin,
}: {
  response: AIResponse | null;
  mode: AIResponse["mode"];
  copied: boolean;
  pinned: boolean;
  onCopy: () => void;
  onPin?: () => void;
}) {
  const total = response ? response.total_ms || response.latency_ms : null;
  const timing = [
    total ? formatDuration(total) : null,
    response?.first_token_ms != null ? `first words ${formatDuration(response.first_token_ms)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-0.5 text-meta font-medium text-primary/80">
          {getModeLabel(mode)}
        </span>
        {(timing || response?.scope_label) && (
          <span className="min-w-0 truncate text-meta tabular-nums text-muted-foreground/45">
            {[response?.scope_label, timing].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ActionButton
          icon={copied ? Check : Copy}
          title="Copy to clipboard"
          onClick={onCopy}
          active={copied}
        />
        {onPin && (
          <ActionButton
            icon={pinned ? PinOff : Pin}
            title={pinned ? "Unpin" : "Pin response"}
            onClick={onPin}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  secondary,
  pinned,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  secondary?: boolean;
  pinned?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-meta font-medium transition-colors duration-150 ${
        active
          ? "bg-primary/20 text-primary"
          : secondary
            ? "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground"
            : pinned
              ? "text-warning/70 hover:bg-warning/10 hover:text-warning"
              : "text-muted-foreground/70 hover:bg-muted/30 hover:text-muted-foreground"
      }`}
    >
      {pinned && <Pin className="mr-0.5 inline-block h-2.5 w-2.5" aria-hidden="true" />}
      {label}
    </button>
  );
}

function ActionButton({
  icon: Icon,
  title,
  onClick,
  active,
}: {
  icon: typeof Copy;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg p-1.5 transition-colors duration-150 ${
        active
          ? "text-success"
          : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent"
      }`}
      aria-label={title}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
