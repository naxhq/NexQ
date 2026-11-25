import { useCallback, useEffect, useMemo, useRef } from "react";
import { OVERLAY_CONTRAST_CSS, OVERLAY_MOTION_CSS } from "./overlayMotion";
import { readableOn, useIsLight } from "../lib/themeText";
import { useMeetingStore } from "../stores/meetingStore";
import { useScenarioStore } from "../stores/scenarioStore";
import { useTranslationStore } from "../stores/translationStore";
import { showToast } from "../stores/toastStore";
import { translateBatch } from "../lib/ipc";
import { TranscriptPanel } from "./TranscriptPanel";
import { QuestionPanel } from "./QuestionDetector";
import { AIResponsePanel } from "./AIResponsePanel";
import { ModeButtons } from "./ModeButtons";
import { ServiceStatusBar } from "../components/ServiceStatusBar";
import { DevLogEmbedded } from "../components/DevLogPanel";
import { CallLogPanel } from "../calllog/CallLogPanel";
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
import { showLauncherWindow } from "../lib/windows";
import { SCREENSHOT_EVENT } from "../lib/screenCapture";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useDemoStore } from "../demo/demoStore";
import {
  Dock,
  LayoutMenuButton,
  DEFAULT_PANELS,
  type DockPanelDef,
  type DockState,
  type LayoutStorage,
  type PanelId,
  useDockState,
} from "./dock";
import { FOCUS_TOOLTIP, focusMode, isShowing, nextFocus, toggleAction } from "./dockControl";
import { hideTransient, readDock } from "./dockPersistence";
import { TranscriptTabMeters } from "./TranscriptPanel";
import { SHORT_ASSISTANT_PX, SHORT_TRANSCRIPT_PX, useElementSize } from "./useElementSize";
import { NotesPanel } from "./panels/NotesPanel";
import { BriefPanel } from "./panels/BriefPanel";
import { PointsPanel } from "./panels/PointsPanel";
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
  MoreHorizontal,
  PanelRightClose,
  Eye,
  ScreenShare,
  ScreenShareOff,
} from "lucide-react";
import { Kbd, Menu, type MenuItemSpec } from "../ui";
import { toggleStealthMode } from "../hooks/useGlobalShortcut";
import { formatShortcut, isMacPlatform } from "../lib/shortcutLabel";
import { formatDuration } from "../lib/utils";
import { MeetingWorkspaceChip } from "../workspace/MeetingWorkspaceChip";

/** Panels the header buttons and keys open on the fly; Escape closes the last of them. */
/** Below this header width the view toggles collapse into one menu. */
const COMPACT_HEADER_PX = 1040;
const AUXILIARY: PanelId[] = ["stats", "bookmarks", "calllog", "devlog"];
/** Raised by the Ask key (useGlobalShortcut): the Ask box must be on screen. */
const ASK_TOGGLE_EVENT = "nexq:toggle-ask-input";
/** The meeting the dock was last set up for in this window, so a remount of the same meeting keeps its panels. */
let lastDockMeeting: string | null = null;
/** Settings opened from this header replaces the meeting view; when it closes, focus goes back to its button. */
let returnFocusToSettings = false;

// ════════════════════════════════════════════════════════════════
export function OverlayView() {
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const recordingEnabled = useConfigStore((s) => s.recordingEnabled);
  const audioMode = useMeetingStore((s) => s.audioMode);
  const endMeetingFlow = useMeetingStore((s) => s.endMeetingFlow);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const scenarioName = useScenarioStore((s) => s.getActiveTemplate().name);
  const meetingId = activeMeeting?.id ?? "";
  const isLight = useIsLight();

  useEffect(() => {
    if (!returnFocusToSettings) return;
    returnFocusToSettings = false;
    document.querySelector<HTMLElement>('button[aria-label="Settings"]')?.focus();
  }, []);

  // ── Dock: every panel of the window lives in one dock, mounted once ──
  // Only the overlay window saves the layout; the launcher's demo mode shows the
  // same view but never writes it (or anything else of the user's).
  const writable = useMemo(() => {
    try {
      return getCurrentWebviewWindow().label === "overlay" && !useDemoStore.getState().isDemoActive;
    } catch {
      return false;
    }
  }, []);
  const startup = useMemo(() => {
    const cfg = useConfigStore.getState();
    // A new meeting starts with the panels the last one opened on the fly closed again.
    const fresh = writable && lastDockMeeting !== meetingId;
    const saved = readDock(DEFAULT_PANELS, cfg.overlayDock);
    return {
      dock: fresh ? hideTransient(saved, cfg.overlayDockTransient) : saved,
      opened: fresh ? [] : cfg.overlayDockTransient.filter((p) => AUXILIARY.includes(p)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const storage = useMemo<LayoutStorage | undefined>(
    () => (writable ? { save: (st: DockState) => useConfigStore.getState().setOverlayDock(st) } : undefined),
    [writable],
  );
  const { state: dock, dispatch: dockDispatch } = useDockState(DEFAULT_PANELS, storage, 500, startup.dock);
  const layout = dock.layout;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Panels opened on the fly (S, K, Ctrl+Shift+L, the header): Escape closes the last one.
  const openedRef = useRef<PanelId[]>(startup.opened);
  const rememberOpened = useCallback(() => {
    if (writable) useConfigStore.getState().setOverlayDockTransient([...openedRef.current]);
  }, [writable]);
  useEffect(() => {
    if (!writable) return;
    lastDockMeeting = meetingId;
    if (useConfigStore.getState().overlayDockTransient.length && openedRef.current.length === 0) {
      useConfigStore.getState().setOverlayDockTransient([]);
    }
  }, [writable, meetingId]);

  const togglePanel = useCallback(
    (panel: PanelId) => {
      const l = layoutRef.current;
      if (isShowing(l, panel)) {
        openedRef.current = openedRef.current.filter((p) => p !== panel);
      } else if (AUXILIARY.includes(panel) && l.hidden.includes(panel)) {
        openedRef.current = [...openedRef.current.filter((p) => p !== panel), panel];
      }
      dockDispatch(toggleAction(l, panel));
      rememberOpened();
    },
    [dockDispatch, rememberOpened],
  );
  const openPanel = useCallback(
    (panel: PanelId) => {
      const l = layoutRef.current;
      if (AUXILIARY.includes(panel) && l.hidden.includes(panel)) {
        openedRef.current = [...openedRef.current.filter((p) => p !== panel), panel];
        rememberOpened();
      }
      dockDispatch({ type: "reveal", panel });
    },
    [dockDispatch, rememberOpened],
  );
  /** Escape: put away every panel opened on the fly, as before. The assistant is never one of them. */
  const closeLastPanel = useCallback(() => {
    for (const panel of openedRef.current) {
      if (!layoutRef.current.hidden.includes(panel)) dockDispatch({ type: "hide", panel });
    }
    openedRef.current = [];
    rememberOpened();
  }, [dockDispatch, rememberOpened]);

  // The overlay window stays mounted between meetings: a new meeting closes the panels
  // the last one opened on the fly (the arrangement itself stays).
  const seenMeeting = useRef(meetingId);
  useEffect(() => {
    if (seenMeeting.current === meetingId) return;
    seenMeeting.current = meetingId;
    for (const panel of openedRef.current) dockDispatch({ type: "hide", panel });
    openedRef.current = [];
    rememberOpened();
  }, [meetingId, dockDispatch, rememberOpened]);

  // A panel asks for another one (a note's time reveals the transcript).
  useEffect(() => {
    const on = (e: Event) => {
      const panel = (e as CustomEvent<{ panel?: PanelId }>).detail?.panel;
      if (panel) openPanel(panel);
    };
    window.addEventListener("nexq:reveal-panel", on);
    return () => window.removeEventListener("nexq:reveal-panel", on);
  }, [openPanel]);

  // A captured screenshot, or the Ask key, needs the Ask box: bring the assistant into
  // view whether it is hidden, behind another tab, a strip or locked in place.
  useEffect(() => {
    const reveal = () => dockDispatch({ type: "reveal", panel: "assistant" });
    window.addEventListener(SCREENSHOT_EVENT, reveal);
    window.addEventListener(ASK_TOGGLE_EVENT, reveal);
    return () => {
      window.removeEventListener(SCREENSHOT_EVENT, reveal);
      window.removeEventListener(ASK_TOGGLE_EVENT, reveal);
    };
  }, [dockDispatch]);

  // The old three-way button: split -> focus AI -> focus transcript, as strip collapse.
  const mode = focusMode(layout);
  const cycleLayout = () => {
    for (const a of nextFocus(layoutRef.current).actions) dockDispatch(a);
  };
  const statsOpen = isShowing(layout, "stats");
  const bookmarksOpen = isShowing(layout, "bookmarks");
  const logOpen = isShowing(layout, "calllog");
  const devLogOpen = isShowing(layout, "devlog");

  const mutedYou = useConfigStore((s) => s.mutedYou);
  const mutedThem = useConfigStore((s) => s.mutedThem);
  const toggleMuteYou = useConfigStore((s) => s.toggleMuteYou);
  const toggleMuteThem = useConfigStore((s) => s.toggleMuteThem);
  const overlayOpacity = useConfigStore((s) => s.overlayOpacity);
  const stealthMode = useConfigStore((s) => s.stealthMode);
  const stealthShortcut = useConfigStore((s) => s.stealthShortcut);
  const setOverlayOpacity = useConfigStore((s) => s.setOverlayOpacity);
  const OPACITY_PRESETS = [0.9, 0.65, 0.35, 0.1];
  const cycleOpacity = () => {
    const idx = OPACITY_PRESETS.findIndex((p) => Math.abs(p - overlayOpacity) < 0.08);
    setOverlayOpacity(OPACITY_PRESETS[(idx + 1) % OPACITY_PRESETS.length]);
  };

  const autoTranslateActive = useTranslationStore((s) => s.autoTranslateActive);
  const setAutoTranslateActive = useTranslationStore((s) => s.setAutoTranslateActive);
  const displayMode = useTranslationStore((s) => s.displayMode);
  const setDisplayMode = useTranslationStore((s) => s.setDisplayMode);
  const targetLang = useTranslationStore((s) => s.targetLang);
  const provider = useTranslationStore((s) => s.provider);
  const batchProgress = useTranslationStore((s) => s.batchProgress);
  const isBatchTranslating = batchProgress !== null;

  // addBookmarkAtNow: used by the B key (useMeetingShortcuts) and the toolbar button
  const addBookmarkAtNow = useBookmarkHotkey();

  // Consolidated keyboard shortcuts for live meeting
  const shortcutActions = useMemo(
    () => ({
      addBookmark: addBookmarkAtNow,
      toggleStats: () => togglePanel("stats"),
      toggleBookmarks: () => togglePanel("bookmarks"),
      toggleMute: () => useConfigStore.getState().toggleMuteYou(),
      closeAllPanels: closeLastPanel,
      toggleDevLog: () => togglePanel("devlog"),
    }),
    [addBookmarkAtNow, togglePanel, closeLastPanel],
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

  // Hide the overlay and show the dashboard; the overlay keeps its meeting
  // view, so RETURN, Ctrl+B or the tray bring it straight back.
  // Under stealth mode AND an active meeting, hide the overlay to the tray
  // instead of revealing the launcher — showing the dashboard full-size
  // during a meeting would leak NexQ to anyone looking at the screen.
  const stealthHide = stealthMode && !!activeMeeting;
  const handleMinimizeToDashboard = useCallback(async () => {
    if (stealthHide) {
      // Hide the overlay without revealing the launcher. If the window API
      // isn't available (should not happen inside Tauri), do nothing: under
      // stealth a silent click is better than a visible launcher.
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const overlay = await WebviewWindow.getByLabel("overlay");
        await overlay?.hide();
      } catch (e) {
        console.warn("[overlay] stealth-hide fell through, overlay stays visible:", e);
      }
      return;
    }
    showLauncherWindow().catch(() => {});
  }, [stealthHide]);

  const meetingTitle = activeMeeting?.title || "NexQ";

  // A narrow window gives the header two rows, not three: the view toggles move into one menu
  // (every one still reachable, with its key and state).
  const [headerRef, headerSize] = useElementSize<HTMLDivElement>();
  const compactHeader = headerSize.w > 0 && headerSize.w < COMPACT_HEADER_PX;
  const moreItems: MenuItemSpec[] = [
    { id: "focus", label: FOCUS_TOOLTIP[mode], onSelect: cycleLayout },
    { id: "stats", label: "Speaker stats", hint: <Kbd>S</Kbd>, checked: statsOpen, separatorBefore: true, onSelect: () => togglePanel("stats") },
    { id: "bookmarks", label: "Bookmarks", hint: <Kbd>K</Kbd>, checked: bookmarksOpen, onSelect: () => togglePanel("bookmarks") },
    { id: "calllog", label: "AI call log", checked: logOpen, onSelect: () => togglePanel("calllog") },
    { id: "devlog", label: "Dev log", hint: <Kbd>Ctrl+Shift+L</Kbd>, checked: devLogOpen, onSelect: () => togglePanel("devlog") },
    { id: "opacity", label: `Transparency: ${Math.round(overlayOpacity * 100)}% (cycle)`, separatorBefore: true, onSelect: cycleOpacity },
  ];

  // Each panel keeps its identity (a stable element at a stable place), so none of
  // them remounts when the layout changes.
  // A short area keeps the lines and drops the toolbars around them.
  const [transcriptRef, transcriptSize] = useElementSize<HTMLDivElement>();
  const [assistantRef, assistantSize] = useElementSize<HTMLDivElement>();
  const shortTranscript = transcriptSize.h > 0 && transcriptSize.h < SHORT_TRANSCRIPT_PX;
  const shortAssistant = assistantSize.h > 0 && assistantSize.h < SHORT_ASSISTANT_PX;
  const panels = {
    transcript: {
      title: "Transcript",
      reading: true,
      node: (
        <div ref={transcriptRef} className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5">
          <TranscriptPanel short={shortTranscript} onOpenDevLog={() => openPanel("devlog")} />
        </div>
      ),
    },
    assistant: {
      title: "Assistant",
      reading: true,
      node: (
        <div ref={assistantRef} className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
          <QuestionPanel />
          <div className="flex shrink-0 items-center gap-1 border-b border-border/20 pb-1.5">
            <ModeButtons />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <AIResponsePanel short={shortAssistant} />
          </div>
        </div>
      ),
    },
    notes: { title: "Live notes", reading: true, node: <NotesPanel /> },
    brief: { title: "Brief", reading: true, node: <BriefPanel /> },
    points: { title: "Talking points", reading: true, node: <PointsPanel /> },
    bookmarks: {
      title: "Bookmarks",
      node: (
        <div className="min-h-0 flex-1 overflow-y-auto [&>div]:max-h-none">
          <BookmarkPanel />
        </div>
      ),
    },
    stats: {
      title: "Stats",
      node: (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <SpeakerStatsPanel isOpen />
        </div>
      ),
    },
    calllog: { title: "AI Call Log", reading: true, node: <CallLogPanel embedded onClose={() => togglePanel("calllog")} /> },
    devlog: { title: "Dev Log", node: <DevLogEmbedded onClose={() => togglePanel("devlog")} /> },
  } satisfies Record<string, DockPanelDef>;
  const menuPanels = useMemo(
    () => Object.fromEntries(Object.entries(panels).map(([id, p]) => [id, { title: p.title }])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="overlay-bg flex h-full flex-col rounded-xl border border-border/20 shadow-xl" style={{ background: `hsl(var(--background) / ${overlayOpacity})`, backdropFilter: overlayOpacity > 0.7 ? "blur(12px) saturate(1.1)" : "none" }}>

      <style>{`${OVERLAY_MOTION_CSS} ${OVERLAY_CONTRAST_CSS}`}</style>
      {/* ═══ HEADER ═══ */}
      <div
        ref={headerRef}
        className="no-select flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 cursor-move"
        data-tauri-drag-region
        style={{ borderBottom: "1px solid hsl(var(--border) / 0.12)" }}
      >
        <div className="flex min-w-0 items-center gap-2.5" data-tauri-drag-region>
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
            style={{ color: readableOn(MODE_COLORS[audioMode].text, isLight ? "light" : "dark", 5.6), backgroundColor: MODE_COLORS[audioMode].bg }}
          >
            {audioMode === "online" ? "ONLINE" : "IN-PERSON"}
          </span>
          {/* Scenario chip */}
          <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-white/5">
            {scenarioName}
          </span>
          {meetingId && <MeetingWorkspaceChip meetingId={meetingId} />}
          <ElapsedClock />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1">
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
          {!compactHeader && <HeaderBtn
            icon={mode === "split" ? <Columns2 className="h-3.5 w-3.5" /> : mode === "ai" ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
            onClick={cycleLayout}
            tooltip={FOCUS_TOOLTIP[mode]}
          />}
          <LayoutMenuButton state={dock} dispatch={dockDispatch} panels={menuPanels} />
          <div className="w-px h-3.5 bg-border/20 mx-0.5" />
          {compactHeader ? (
            <Menu
              label="More view options"
              align="end"
              items={moreItems}
              renderTrigger={(props, { open }) => (
                <button
                  {...props}
                  type="button"
                  aria-label="More view options"
                  className={`rounded-lg p-2 transition-all duration-150 cursor-pointer ui-focus ${open ? "bg-primary/10 text-primary" : "text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"}`}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            />
          ) : (<>
          <HeaderBtn icon={<BarChart3 className="h-3.5 w-3.5" />} active={statsOpen} onClick={() => togglePanel("stats")} tooltip="Speaker Stats (S)" />
          <HeaderBtn icon={<Bookmark className="h-3.5 w-3.5" />} active={bookmarksOpen} onClick={() => togglePanel("bookmarks")} tooltip="Bookmarks (K)" />
          <HeaderBtn icon={<Activity className="h-3.5 w-3.5" />} active={logOpen} onClick={() => togglePanel("calllog")} tooltip="AI Call Log" />
          <HeaderBtn icon={<Terminal className="h-3.5 w-3.5" />} active={devLogOpen} onClick={() => togglePanel("devlog")} tooltip="Dev Log (Ctrl+Shift+L)" />
          </>)}
          <HeaderBtn
            icon={stealthMode ? <ScreenShareOff className="h-3.5 w-3.5" /> : <ScreenShare className="h-3.5 w-3.5" />}
            active={stealthMode}
            onClick={() => { toggleStealthMode().catch(() => {}); }}
            tooltip={`${stealthMode ? "Hidden from screen share — click to show" : "Visible in screen share — click to hide"} (${formatShortcut(stealthShortcut)})`}
          />
          {!compactHeader && <HeaderBtn icon={<Eye className="h-3.5 w-3.5" />} onClick={cycleOpacity} tooltip={`Transparency: ${Math.round(overlayOpacity * 100)}% (click to cycle)`} />}
          <HeaderBtn icon={<Settings className="h-3.5 w-3.5" />} onClick={() => { returnFocusToSettings = true; setCurrentView("settings"); }} tooltip="Settings" />
          <HeaderBtn icon={<Minus className="h-3.5 w-3.5" />} onClick={handleMinimizeToDashboard} tooltip={stealthHide ? `Hide to ${isMacPlatform() ? "menu bar" : "tray"} (${formatShortcut("CmdOrCtrl+B")} brings it back)` : `Minimize to Dashboard (${formatShortcut("CmdOrCtrl+B")} brings it back)`} />

          {/* Translation controls */}
          <button
            onClick={() => setAutoTranslateActive(!autoTranslateActive)}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-all ${
              autoTranslateActive
                ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                : "text-muted-foreground hover:bg-accent"
            }`}
            title="Toggle auto-translate"
            aria-pressed={autoTranslateActive}
          >
            <Globe className="h-3 w-3" aria-hidden="true" />
            {compactHeader ? <span className="sr-only">Translate</span> : "Translate"}
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

      {/* ═══ MAIN: the dock ═══ */}
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0">
          <Dock
            panels={panels}
            state={dock}
            dispatch={dockDispatch}
            windowOpacity={overlayOpacity}
            renderTabExtra={(p) => (p === "transcript" && shortTranscript ? <TranscriptTabMeters /> : null)}
          />
        </div>
      </div>

      {/* Bookmark toast (manages its own visibility) */}
      <BookmarkToast />

      {/* ═══ FOOTER: Service Status ═══ */}
      <div className="border-t border-border/20">
        <ServiceStatusBar compact />
      </div>
    </div>
  );
}

/**
 * The meeting clock: the one thing that ticks every second. It subscribes to the
 * elapsed time itself, so only this text node updates (the window does not re-render).
 */
function ElapsedClock() {
  const elapsedMs = useMeetingStore((s) => s.elapsedMs);
  return (
    <span className="text-xs text-muted-foreground/60 tabular-nums font-medium">
      {elapsedMs > 0 ? formatDuration(elapsedMs) : "00:00"}
    </span>
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


