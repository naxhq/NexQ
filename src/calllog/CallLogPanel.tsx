import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useCallLogStore } from "../stores/callLogStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useTranslationStore } from "../stores/translationStore";
import { exportTranslatedTranscript } from "../lib/ipc";
import { showToast } from "../stores/toastStore";
import { CallLogEntry } from "./CallLogEntry";
import { useMeetingAgentUsage } from "../hooks/useMeetingAgentUsage";
import { useAgentStore } from "../stores/agentStore";
import { formatUsageSummary, formatCostEstimate, formatDuration, isApiBilled } from "../lib/agentUsage";
import { cliAgentName, isCliAgent } from "../lib/cliAgents";
import { useConfigStore } from "../stores/configStore";
import { PromptViewer } from "./PromptViewer";
import { callLogStats, formatCompactTokens } from "./stats";
import type { LogFilterKind } from "../lib/types";
import {
  X,
  Trash2,
  Activity,
  FileSearch,
  Download,
  ChevronDown,
} from "lucide-react";

// -- Filter options ----------------------------------------------------------

const FILTER_OPTIONS: Array<{ label: string; value: LogFilterKind }> = [
  { label: "All", value: "all" },
  { label: "Assist", value: "Assist" },
  { label: "Say", value: "WhatToSay" },
  { label: "Short", value: "Shorten" },
  { label: "F/U", value: "FollowUp" },
  { label: "Recap", value: "Recap" },
  { label: "Ask", value: "AskQuestion" },
  { label: "Errors", value: "errors" },
];

// -- Main panel component ----------------------------------------------------

export function CallLogPanel() {
  const isOpen = useCallLogStore((s) => s.isOpen);
  const setOpen = useCallLogStore((s) => s.setOpen);
  const entries = useCallLogStore((s) => s.entries);
  const activeFilter = useCallLogStore((s) => s.activeFilter);
  const setFilter = useCallLogStore((s) => s.setFilter);
  const clearAll = useCallLogStore((s) => s.clearAll);
  const expandedEntryId = useCallLogStore((s) => s.expandedEntryId);

  // Translation state
  const meetingId = useMeetingStore((s) => s.activeMeeting?.id ?? null);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const batchProgress = useTranslationStore((s) => s.batchProgress);
  const { sessions: claudeSessions, usage: claudeUsage } = useMeetingAgentUsage();
  const activeAgent = useConfigStore((s) => (isCliAgent(s.llmProvider) ? s.llmProvider : "claude_cli"));
  const claudeApiBilled = useAgentStore((s) => isApiBilled(s.statuses[activeAgent]));
  // Session updates only arrive once the store has subscribed in this window
  useEffect(() => {
    useAgentStore.getState().init();
  }, []);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Close on Escape (skip if settings overlay is open)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (useMeetingStore.getState().settingsOpen) return;
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, setOpen]);

  // Filter entries
  const filteredEntries = useMemo(() => {
    if (activeFilter === "all") return entries;
    if (activeFilter === "errors")
      return entries.filter((e) => e.status === "error");
    return entries.filter((e) => e.mode === activeFilter);
  }, [entries, activeFilter]);

  // Filter counts
  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = { all: entries.length, errors: 0 };
    for (const e of entries) {
      counts[e.mode] = (counts[e.mode] ?? 0) + 1;
      if (e.status === "error") counts.errors++;
    }
    return counts;
  }, [entries]);

  // Performance stats
  const stats = useMemo(() => callLogStats(entries), [entries]);

  // Selected entry for detail view
  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === expandedEntryId) ?? null,
    [entries, expandedEntryId]
  );

  // Close export menu on outside click
  useEffect(() => {
    if (!showExportMenu) return;
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showExportMenu]);

  // Export translated transcript
  const handleExport = useCallback(async (format: string) => {
    if (!meetingId) return;
    try {
      const content = await exportTranslatedTranscript(meetingId, targetLang, format);
      if (format === "clipboard") {
        await navigator.clipboard.writeText(content);
        showToast("Copied to clipboard", "success");
      } else {
        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `transcript-${format.replace("_", "-")}.${format.includes("md") ? "md" : "txt"}`;
        a.click();
        URL.revokeObjectURL(url);
        showToast("Export downloaded", "success");
      }
    } catch (err) {
      showToast(`Export failed: ${err}`, "error");
    }
    setShowExportMenu(false);
  }, [meetingId, targetLang]);

  const handleClose = useCallback(() => setOpen(false), [setOpen]);

  return (
    <div
      className={`shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
        isOpen ? "w-[380px]" : "w-0"
      }`}
    >
      {isOpen && (
        <div className="flex flex-col h-full w-[380px] border-l border-border/40 bg-card">
          {/* ── Header ── */}
          <div className="border-b border-border/30 px-3 py-2.5 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-semibold text-foreground">
                  AI Call Log
                </span>
                {entries.length > 0 && (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-meta font-medium text-primary">
                    {entries.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Export dropdown */}
                {meetingId && entries.length > 0 && (
                  <div className="relative" ref={exportMenuRef}>
                    <button
                      onClick={() => setShowExportMenu((v) => !v)}
                      className="flex items-center gap-1 rounded-lg border border-border/30 bg-secondary/30 px-2 py-1 text-meta font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
                      title="Export transcript"
                    >
                      <Download className="h-3 w-3" />
                      Export
                      <ChevronDown className="h-2.5 w-2.5" />
                    </button>

                    {showExportMenu && (
                      <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-border/40 bg-popover shadow-lg">
                        <div className="py-1">
                          <button
                            onClick={() => handleExport("translated_txt")}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/40 transition-colors"
                          >
                            Translated transcript (.txt)
                          </button>
                          <button
                            onClick={() => handleExport("bilingual_txt")}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/40 transition-colors"
                          >
                            Bilingual transcript (.txt)
                          </button>
                          <button
                            onClick={() => handleExport("bilingual_md")}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/40 transition-colors"
                          >
                            Bilingual transcript (.md)
                          </button>
                          <div className="my-1 border-t border-border/20" />
                          <button
                            onClick={() => handleExport("clipboard")}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-accent/40 transition-colors"
                          >
                            Copy to clipboard
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {entries.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-destructive"
                    title="Clear all"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={handleClose}
                  className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
                  title="Close (Esc)"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* CLI agent session usage for this meeting (an estimate, not quota) */}
            {claudeSessions.length > 0 && (
              <div className="mt-2 text-meta text-muted-foreground" data-testid="claude-usage">
                <span className="font-medium text-foreground/80">{cliAgentName(activeAgent)}</span>{" "}
                <span className="tabular-nums">{formatUsageSummary(claudeUsage)}</span>
                <span className="block text-muted-foreground/70">{formatCostEstimate(claudeUsage, claudeApiBilled)}</span>
              </div>
            )}

            {/* Filter chips */}
            <div className="mt-2 flex flex-wrap gap-1">
              {FILTER_OPTIONS.map(({ label, value }) => {
                const count = filterCounts[value] ?? 0;
                const isActive = activeFilter === value;
                return (
                  <button
                    key={value}
                    onClick={() => setFilter(value)}
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium transition-colors duration-100 ${
                      isActive
                        ? "bg-primary/20 text-primary ring-1 ring-primary/30"
                        : "bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                  >
                    {label}
                    {count > 0 && (
                      <span
                        className={
                          isActive
                            ? "text-primary/70"
                            : "text-muted-foreground/50"
                        }
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Stats mini-dashboard ── */}
          {stats.total > 0 && (
            <div
              className="flex items-center justify-between border-b border-border/20 bg-secondary/20 px-3 py-1.5 shrink-0"
              data-testid="call-log-stats"
            >
              <StatTile label="Calls" value={`${stats.total}`} />
              <StatTile
                label="Avg response"
                value={stats.avgLatencyMs != null ? formatDuration(stats.avgLatencyMs) : "—"}
              />
              <StatTile
                label="First word"
                value={stats.avgFirstTokenMs != null ? formatDuration(stats.avgFirstTokenMs) : "—"}
              />
              <StatTile label="Tokens" value={formatCompactTokens(stats.totalTokens)} />
              {stats.errorCount > 0 && (
                <StatTile
                  label="Errors"
                  value={`${stats.errorCount}`}
                  valueClass="text-red-400"
                />
              )}
            </div>
          )}

          {/* ── Batch translation progress ── */}
          {batchProgress && (
            <div className="flex items-center gap-2 px-4 py-2 bg-primary/5 border-b border-primary/10 shrink-0">
              <span className="text-meta text-primary/60 font-medium whitespace-nowrap">
                Translating to {targetLang.toUpperCase()}...
              </span>
              <div className="flex-1 h-1 rounded-full bg-border/20 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary/50 transition-all duration-300"
                  style={{ width: `${(batchProgress.completed / batchProgress.total) * 100}%` }}
                />
              </div>
              <span className="text-meta text-primary/60 font-medium tabular-nums">
                {batchProgress.completed} / {batchProgress.total}
              </span>
            </div>
          )}

          {/* ── Two-zone layout ── */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Top zone: Entry list (compact, scrollable) */}
            <div
              className={`overflow-y-auto border-b border-border/20 ${
                selectedEntry ? "max-h-[45%]" : "flex-1"
              }`}
            >
              {filteredEntries.length === 0 ? (
                <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-2 text-muted-foreground/60">
                  <FileSearch className="h-6 w-6" />
                  <span className="text-xs">
                    {entries.length === 0
                      ? "No AI calls yet"
                      : "No calls match filter"}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 p-1.5">
                  {filteredEntries.map((entry) => (
                    <CallLogEntry
                      key={entry.id}
                      entry={entry}
                      isSelected={entry.id === expandedEntryId}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Bottom zone: Selected entry detail */}
            {selectedEntry ? (
              <div className="flex-1 min-h-0 overflow-hidden">
                <PromptViewer entry={selectedEntry} />
              </div>
            ) : (
              filteredEntries.length > 0 && (
                <div className="flex-1 flex items-center justify-center text-muted-foreground/60">
                  <span className="text-xs">
                    Click an entry to view prompt details
                  </span>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// -- Internal stat tile component --------------------------------------------

function StatTile({
  label,
  value,
  valueClass = "text-foreground",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className={`text-xs font-medium tabular-nums ${valueClass}`}>
        {value}
      </span>
      <span className="text-meta text-muted-foreground/50">{label}</span>
    </div>
  );
}
