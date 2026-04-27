import { useCallback, useMemo, useState } from "react";
import { useMeetingStore } from "../stores/meetingStore";
import { useScenarioStore } from "../stores/scenarioStore";
import { useCallLogStore } from "../stores/callLogStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useTranslationStore } from "../stores/translationStore";
import { showToast } from "../stores/toastStore";
import { translateBatch } from "../lib/ipc";
import { TranscriptPanel } from "./TranscriptPanel";
import { QuestionDetector } from "./QuestionDetector";
import { AIResponsePanel } from "./AIResponsePanel";
import { ModeButtons } from "./ModeButtons";
import { AskInput } from "./AskInput";
import { ServiceStatusBar } from "../components/ServiceStatusBar";
import { DevLogPanel } from "../components/DevLogPanel";
import { SpeakerStatsPanel } from "./SpeakerStatsPanel";
import { BookmarkToast } from "./BookmarkToast";
import { BookmarkPanel } from "./BookmarkPanel";
import { useBookmarkHotkey } from "../hooks/useBookmarkHotkey";
import { useMeetingShortcuts } from "../hooks/useMeetingShortcuts";
import { useConfigStore } from "../stores/configStore";
import { useSpeakerDetection } from "../hooks/useSpeakerDetection";
import { useTopicDetection } from "../hooks/useTopicDetection";
import { useTranslation } from "../hooks/useTranslation";
import { MODE_COLORS } from "../lib/speakerColors";
import {
  GripHorizontal,
  Minus,
  Settings,
  Square,
  Activity,
  Terminal,
  BarChart3,
  Bookmark,
  Globe,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Columns2,
  PanelLeftClose,
  PanelRightClose,
} from "lucide-react";
import { formatDuration } from "../lib/utils";

// ════════════════════════════════════════════════════════════════
export function OverlayView() {
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const elapsedMs = useMeetingStore((s) => s.elapsedMs);
  const recordingEnabled = useConfigStore((s) => s.recordingEnabled);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const endMeetingFlow = useMeetingStore((s) => s.endMeetingFlow);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const scenarioTemplate = useScenarioStore((s) => s.getActiveTemplate());
  const [askInputVisible, setAskInputVisible] = useState(false);
  const [devLogOpen, setDevLogOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<"split" | "ai" | "transcript">("split");
  const cycleLayout = () => setLayoutMode((m) => m === "split" ? "ai" : m === "ai" ? "transcript" : "split");
  const toggleLog = useCallLogStore((s) => s.toggleOpen);
  const logOpen = useCallLogStore((s) => s.isOpen);
  const autoTrigger = useAIActionsStore((s) => s.configs.globalDefaults.autoTrigger);

  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const toggleMuteYou = useConfigStore((s) => s.toggleMuteYou);
  const toggleMuteThem = useConfigStore((s) => s.toggleMuteThem);

  const autoTranslateActive = useTranslationStore((s) => s.autoTranslateActive);
  const setAutoTranslateActive = useTranslationStore((s) => s.setAutoTranslateActive);
  const displayMode = useTranslationStore((s) => s.displayMode);
  const setDisplayMode = useTranslationStore((s) => s.setDisplayMode);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const provider = useTranslationStore((s) => s.provider);
  const batchProgress = useTranslationStore((s) => s.batchProgress);
  const isBatchTranslating = batchProgress !== null;

  // Bookmark hotkey (Ctrl+B) — also returns addBookmarkAtNow for shortcut hook
  const addBookmarkAtNow = useBookmarkHotkey();

  // Consolidated keyboard shortcuts for live meeting
  const shortcutActions = useMemo(
    () => ({
      addBookmark: addBookmarkAtNow,
      toggleStats: () => setStatsOpen((p) => !p),
      toggleBookmarks: () => setBookmarksOpen((p) => !p),
      toggleMute: () => useConfigStore.getState().toggleMuteYou(),
      closeAllPanels: () => {
        setStatsOpen(false);
        setBookmarksOpen(false);
        setDevLogOpen(false);
      },
      toggleDevLog: () => setDevLogOpen((p) => !p),
    }),
    [addBookmarkAtNow],
  );
  useMeetingShortcuts(shortcutActions);

  // Speaker detection from Deepgram diarization events
  useSpeakerDetection();

  // Live topic detection from backend events
  useTopicDetection();

  // Translation event subscriptions + auto-translate trigger
  useTranslation();

  const handleEndMeeting = useCallback(async () => {
    try { await endMeetingFlow(); showToast("Meeting ended", "info"); }
    catch (err) { showToast(err instanceof Error ? err.message : "Couldn't end meeting", "error"); }
  }, [endMeetingFlow]);

  const handleTranslateAll = useCallback(async () => {
    const meetingId = activeMeeting?.id;
    if (!meetingId || !targetLang) return;
    try {
      const { total, alreadyDone, newlyTranslated } = await translateBatch(meetingId, targetLang);
      if (newlyTranslated === 0) {
        showToast(`All ${total} segments already translated`, "info");
      } else if (alreadyDone > 0) {
        showToast(`Translated ${newlyTranslated} new segments (${alreadyDone} already cached, ${total} total)`, "success");
      } else {
        showToast(`Translated all ${total} segments`, "success");
      }
    } catch (err) {
      showToast(`Batch translation failed: ${err}`, "error");
    }
  }, [activeMeeting?.id, targetLang]);

  const meetingTitle = activeMeeting?.title || "NexQ";

  return (
    <div className="overlay-bg flex h-full flex-col rounded-xl border border-border/20 shadow-xl">

      {/* ═══ HEADER ═══ */}
      <div
        className="no-select flex items-center justify-between gap-3 px-4 py-2 cursor-move"
        data-tauri-drag-region
        style={{ borderBottom: "1px solid hsl(var(--border) / 0.12)" }}
      >
        <div className="flex items-center gap-2.5" data-tauri-drag-region>
          <GripHorizontal className="h-3 w-3 text-muted-foreground/40" />
          <span className="text-xs font-semibold text-foreground/90 truncate max-w-[160px]" title={meetingTitle}>
            {meetingTitle}
          </span>
          {recordingEnabled && (
            <div className="flex items-center gap-1.5 rounded-full bg-destructive/20 px-2.5 py-0.5 ring-1 ring-destructive/10" role="status" aria-label="Recording in progress">
              <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
              </span>
              <span className="text-meta font-semibold text-destructive tracking-wide">REC</span>
            </div>
          )}
          {/* Mode badge */}
          <span
            className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded"
            style={{ color: MODE_COLORS[audioMode].text, backgroundColor: MODE_COLORS[audioMode].bg }}
          >
            {audioMode === "online" ? "ONLINE" : "IN-PERSON"}
          </span>
          {/* Scenario chip */}
          <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-white/5">
            {scenarioTemplate.name}
          </span>
          <span className="text-xs text-muted-foreground/60 tabular-nums font-medium">
            {elapsedMs > 0 ? formatDuration(elapsedMs) : "00:00"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Mute controls */}
          <button
            onClick={toggleMuteYou}
            className={`rounded-lg p-2 transition-all duration-150 cursor-pointer ${
              mutedYou
                ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                : "text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
            }`}
            aria-label={mutedYou ? "Unmute mic (You)" : "Mute mic (You)"}
            aria-pressed={mutedYou}
            title={mutedYou ? "Unmute mic (You)" : "Mute mic (You)"}
          >
            {mutedYou ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={toggleMuteThem}
            className={`rounded-lg p-2 transition-all duration-150 cursor-pointer ${
              mutedThem
                ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                : "text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
            }`}
            aria-label={mutedThem ? "Unmute them" : "Mute them"}
            aria-pressed={mutedThem}
            title={mutedThem ? "Unmute them" : "Mute them"}
          >
            {mutedThem ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
          <div className="w-px h-3.5 bg-border/20 mx-0.5" />
          <HeaderBtn
            icon={layoutMode === "split" ? <Columns2 className="h-3.5 w-3.5" /> : layoutMode === "ai" ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
            onClick={cycleLayout}
            tooltip={layoutMode === "split" ? "Focus AI panel" : layoutMode === "ai" ? "Focus Transcript" : "Split view"}
          />
          <div className="w-px h-3.5 bg-border/20 mx-0.5" />
          <HeaderBtn icon={<BarChart3 className="h-3.5 w-3.5" />} active={statsOpen} onClick={() => setStatsOpen(p => !p)} tooltip="Speaker Stats (S)" />
          <HeaderBtn icon={<Bookmark className="h-3.5 w-3.5" />} active={bookmarksOpen} onClick={() => setBookmarksOpen(p => !p)} tooltip="Bookmarks (K)" />
          <HeaderBtn icon={<Activity className="h-3.5 w-3.5" />} active={logOpen} onClick={toggleLog} tooltip="AI Call Log" />
          <HeaderBtn icon={<Terminal className="h-3.5 w-3.5" />} active={devLogOpen} onClick={() => setDevLogOpen(p => !p)} tooltip="Dev Log (Ctrl+Shift+L)" />
          <HeaderBtn icon={<Settings className="h-3.5 w-3.5" />} onClick={() => setCurrentView("settings")} tooltip="Settings" />
          <HeaderBtn icon={<Minus className="h-3.5 w-3.5" />} onClick={() => setCurrentView("launcher")} tooltip="Minimize to Dashboard" />

          {/* Translation controls */}
          <button
            onClick={() => setAutoTranslateActive(!autoTranslateActive)}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-all ${
              autoTranslateActive
                ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                : "text-muted-foreground hover:bg-accent"
            }`}
            title="Toggle auto-translate"
          >
            <Globe className="h-3 w-3" />
            Translate
          </button>

          {autoTranslateActive && (
            <>
              <div className="flex rounded-md border border-border/30 overflow-hidden">
                <button
                  onClick={() => setDisplayMode("inline")}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-all ${
                    displayMode === "inline" ? "bg-primary/15 text-primary" : "text-muted-foreground/50"
                  }`}
                >
                  Inline
                </button>
                <button
                  onClick={() => setDisplayMode("hover")}
                  className={`px-2 py-0.5 text-[10px] font-medium border-l border-border/30 transition-all ${
                    displayMode === "hover" ? "bg-primary/15 text-primary" : "text-muted-foreground/50"
                  }`}
                >
                  Hover
                </button>
              </div>
              <button
                onClick={handleTranslateAll}
                disabled={isBatchTranslating}
                className="flex items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 cursor-pointer"
                title="Translate all past transcript segments"
              >
                {isBatchTranslating ? "Translating..." : "Translate All"}
              </button>
              <span className="text-[10px] text-muted-foreground/40 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-success inline-block" />
                {targetLang.toUpperCase()}
              </span>
            </>
          )}

          <button
            onClick={handleEndMeeting}
            className="ml-1.5 flex items-center gap-1.5 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-1.5 text-xs font-semibold text-destructive transition-all duration-150 hover:bg-destructive/20 hover:border-destructive/30 hover:shadow-sm hover:shadow-destructive/10 cursor-pointer"
            aria-label="End meeting"
          >
            <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            End
          </button>
        </div>
      </div>

      {/* ═══ MAIN ═══ */}
      <div className="relative flex-1 min-h-0">
      <div className="absolute inset-0 flex flex-wrap gap-2.5 overflow-hidden px-3 py-2.5">

        {/* ── LEFT: TRANSCRIPT ── */}
        {layoutMode !== "ai" ? (
          <div className="flex min-w-[180px] min-h-0 flex-1 basis-[220px] flex-col overflow-hidden rounded-xl bg-card/20">
            <div className="flex shrink-0 items-center border-b border-border/20 px-3 py-1.5">
              <span className="text-meta font-semibold uppercase tracking-wider text-muted-foreground/60">Transcript</span>
            </div>
            <div className="flex flex-1 flex-col min-h-0 overflow-hidden p-2.5">
              <TranscriptPanel />
            </div>
          </div>
        ) : (
          <div
            className="flex min-h-0 w-8 shrink-0 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl bg-card/20 transition-all duration-200 hover:bg-card/30"
            onClick={() => setLayoutMode("split")}
            role="button"
            aria-label="Expand transcript panel"
            title="Expand transcript"
          >
            <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/40" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
              Transcript
            </span>
          </div>
        )}

        {/* ── RIGHT ── */}
        {layoutMode !== "transcript" ? (
        <div className="flex min-w-[180px] min-h-0 flex-1 basis-[220px] flex-col gap-2.5 overflow-hidden">
          {/* Question detector — only shown when auto-trigger is on */}
          {autoTrigger && (
            <div className="shrink-0 rounded-xl border border-info/10 bg-info/5 px-4 py-3">
              <QuestionDetector />
            </div>
          )}

          {/* AI Response */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card/20">
            <div className="flex shrink-0 items-center gap-1 border-b border-border/20 px-2.5 py-1.5">
              <ModeButtons />
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <AIResponsePanel />
            </div>
          </div>
        </div>
        ) : (
          <div
            className="flex min-h-0 w-8 shrink-0 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl bg-card/20 transition-all duration-200 hover:bg-card/30"
            onClick={() => setLayoutMode("split")}
            role="button"
            aria-label="Expand AI panel"
            title="Expand AI panel"
          >
            <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/40" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
              AI
            </span>
          </div>
        )}
      </div>
      </div>

      {/* Ask input */}
      {askInputVisible && (
        <div className="border-t border-border/20 px-3 py-1.5 slide-down-enter">
          <AskInput visible={askInputVisible} onClose={() => setAskInputVisible(false)} />
        </div>
      )}

      {/* DevLog panel */}
      <DevLogPanel open={devLogOpen} onClose={() => setDevLogOpen(false)} />

      {/* Speaker Stats */}
      {statsOpen && (
        <div className="border-t border-border/20 px-3 py-2">
          <SpeakerStatsPanel isOpen={statsOpen} />
        </div>
      )}

      {/* Bookmark panel */}
      {bookmarksOpen && <BookmarkPanel />}

      {/* Bookmark toast (manages its own visibility) */}
      <BookmarkToast />

      {/* ═══ FOOTER: Service Status ═══ */}
      <div className="border-t border-border/20">
        <ServiceStatusBar compact />
      </div>
    </div>
  );
}

// ── Header Button ──
function HeaderBtn({ icon, active, onClick, tooltip }: { icon: React.ReactNode; active?: boolean; onClick: () => void; tooltip: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg p-2 transition-all duration-150 cursor-pointer ${
        active ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
      }`}
      aria-label={tooltip}
      aria-pressed={active}
    >
      {icon}
    </button>
  );
}


