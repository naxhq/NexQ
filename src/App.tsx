import { useEffect, useCallback, useState } from "react";
import { useMeetingStore } from "./stores/meetingStore";
import { useConfigStore } from "./stores/configStore";
import { useAIActionsStore } from "./stores/aiActionsStore";
import { LauncherView } from "./launcher/LauncherView";
import { OverlayView } from "./overlay/OverlayView";
import { SettingsOverlay } from "./settings/SettingsOverlay";
import { FirstRunWizard } from "./components/wizard/FirstRunWizard";
import { ToastContainer } from "./components/Toast";
import { showToast } from "./stores/toastStore";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateReadyToast } from "./components/UpdateToast";
import { useTheme } from "./hooks/useTheme";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { useTranslation } from "./hooks/useTranslation";
import { useTraySync } from "./hooks/useTraySync";
import { useUpdater } from "./hooks/useUpdater";
import { useAgentFallbackToast } from "./hooks/useAgentFallbackToast";
import { refreshClaudeModelsOnStart } from "./stores/agentStore";
import { useTranslationStore } from "./stores/translationStore";
import { CallLogPanel } from "./calllog";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { ActiveMeetingProvider } from "./components/ActiveMeetingProvider";
import { initMeetingSpeakers, resetMeetingScopedStores } from "./stores/resetMeeting";
import { listen } from "@tauri-apps/api/event";
import type { AppView, Meeting, AudioMode, AIScenario } from "./lib/types";
import { useDemoShortcut } from "./demo/useDemoShortcut";
import { DemoPicker } from "./demo/DemoPicker";
import { DemoBadge } from "./demo/DemoBadge";
import { SHOW_MEETING_OVERLAY_EVENT, showLauncherWindow, showMeetingOverlay, showOverlayWindow } from "./lib/windows";
import { logToFile } from "./lib/logger";
import { emitOverlayMeetingReady, onCaptureWarning, onOverlayMeetingReady, onStartDetectedMeeting, onStealthModeChanged } from "./lib/events";

function App() {
  const currentView = useMeetingStore((s) => s.currentView);
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const startMeetingFlow = useMeetingStore((s) => s.startMeetingFlow);
  const loadRecentMeetings = useMeetingStore((s) => s.loadRecentMeetings);
  // Changes on every new meeting → used as a React key to remount overlay UI
  // so local component state (open panels, tabs, layout) is reset too.
  const activeMeetingId = useMeetingStore((s) => s.activeMeeting?.id ?? "");
  const firstRunCompleted = useConfigStore((s) => s.firstRunCompleted);
  const configLoaded = useConfigStore((s) => s._loaded);
  const loadConfig = useConfigStore((s) => s.loadConfig);

  // Wire up theme and global shortcuts
  useTheme();
  useGlobalShortcut();

  // Demo mode keyboard shortcut (Ctrl+Shift+D)
  useDemoShortcut();

  // Translation event subscriptions (needed for SelectionToolbar in all views)
  useTranslation();

  // Sync frontend state to system tray icon & menu
  useTraySync();

  // Background updates — the loop runs only in the launcher window
  useUpdater();

  // Tray notification toasts for meeting start/stop
  // Tray notifications removed — LauncherView/OverlayView/StatusBar already show meeting toasts

  // Load persisted config from Tauri store on app start
  useEffect(() => {
    loadConfig();
    useAIActionsStore.getState().loadConfigs();
    useTranslationStore.getState().loadConfig().then(async () => {
      // Sync backend translation provider with persisted frontend setting
      const { provider } = useTranslationStore.getState();
      if (provider) {
        try {
          const { setTranslationProvider, getApiKey } = await import("./lib/ipc");
          // Microsoft needs region to authenticate — load from credential store
          let region: string | undefined;
          if (provider === "microsoft") {
            try {
              region = (await getApiKey("translation_microsoft_region")) || undefined;
            } catch { /* region not stored yet */ }
          }
          await setTranslationProvider(provider, region).catch(() => {});
        } catch { /* non-critical on startup */ }
      }
    });
    // Load scenario config (custom scenarios, overrides, active scenario)
    import("./stores/scenarioStore").then(({ useScenarioStore }) => {
      useScenarioStore.getState().loadScenarioConfig();
    }).catch(() => { /* non-critical */ });
  }, [loadConfig]);

  // Load recent meetings on app start
  useEffect(() => {
    loadRecentMeetings();
  }, [loadRecentMeetings]);

  // Detect which Tauri window we're in ("launcher" or "overlay")
  const [windowLabel, setWindowLabel] = useState<string>("");
  useEffect(() => {
    import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
      const label = getCurrentWebviewWindow().label;
      setWindowLabel(label);
      // Overlay window: transparent CSS (tauri.conf.json already sets transparent:true)
      if (label === "overlay") {
        document.body.style.background = "transparent";
        document.documentElement.style.background = "transparent";
      }
    });
  }, []);

  // LAUNCHER window: the meeting runs in the overlay window. When a meeting
  // starts (or anything asks this window for the meeting view), bring the
  // overlay up and keep the dashboard here, so showing the launcher again
  // never shows a second, unpinned copy of the meeting.
  useEffect(() => {
    if (windowLabel !== "launcher") return;
    if (currentView === "overlay") {
      useMeetingStore.getState().setCurrentView("launcher");
      showMeetingOverlay().catch(() => {});
    }
  }, [currentView, windowLabel]);

  // OVERLAY window: show the meeting overlay on request (launcher RETURN,
  // Ctrl+B, tray "Show Overlay"). It renders only its own view, so switch to
  // the meeting first; with no meeting running, show the launcher instead.
  useEffect(() => {
    if (windowLabel !== "overlay") return;
    const show = () => {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting) {
        showLauncherWindow().catch(() => {});
        return;
      }
      if (store.currentView !== "overlay" && store.currentView !== "settings") store.setCurrentView("overlay");
      showOverlayWindow().catch(() => {});
    };
    const unlisteners: Array<() => void> = [];
    listen(SHOW_MEETING_OVERLAY_EVENT, show).then((fn) => unlisteners.push(fn));
    listen("tray_show_overlay", show).then((fn) => unlisteners.push(fn));
    return () => unlisteners.forEach((fn) => fn());
  }, [windowLabel]);

  // LAUNCHER window: listen for nexq:meeting_ended from overlay, show self + reset state
  useEffect(() => {
    if (windowLabel !== "launcher") return;
    let unlisten: (() => void) | undefined;
    listen("nexq:meeting_ended", () => {
      useMeetingStore.setState({
        currentView: "launcher",
        activeMeeting: null,
        isRecording: false,
        meetingStartTime: null,
        elapsedMs: 0,
      });
      useMeetingStore.getState().loadRecentMeetings().catch(() => {});
      showLauncherWindow().catch(() => {});
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [windowLabel]);

  // LAUNCHER window: start the meeting the meeting-detection prompt asked for
  useEffect(() => {
    if (windowLabel !== "launcher") return;
    let unlisten: (() => void) | undefined;
    onStartDetectedMeeting(({ title, scenario }) => {
      if (useMeetingStore.getState().activeMeeting) return;
      useMeetingStore.getState().startMeetingFlow(title, "online", scenario).catch((err) => {
        console.error("[App] Starting the detected meeting failed:", err);
      });
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [windowLabel]);

  // LAUNCHER window: record that the overlay took the meeting (decides which
  // window persists overlay-edited data when the meeting ends)
  useEffect(() => {
    if (windowLabel !== "launcher") return;
    let unlisten: (() => void) | undefined;
    onOverlayMeetingReady(({ meetingId }) => {
      useMeetingStore.getState().setOverlayMeetingId(meetingId);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [windowLabel]);

  // OVERLAY window: when currentView->"launcher", hide self + show launcher
  useEffect(() => {
    if (windowLabel !== "overlay") return;
    if (currentView === "launcher") {
      showLauncherWindow().catch(() => {});
    }
  }, [currentView, windowLabel]);

  // OVERLAY window: listen for nexq:meeting_started, initialize local state
  useEffect(() => {
    if (windowLabel !== "overlay") return;
    let unlisten: (() => void) | undefined;
    listen<{ meeting: Meeting; audioMode: AudioMode; aiScenario: AIScenario }>(
      "nexq:meeting_started",
      async (e) => {
        const { meeting, audioMode, aiScenario } = e.payload;
        const startedAt = Date.now();
        // Reset ALL per-meeting stores in THIS (overlay) window first. Each Tauri
        // webview has its own Zustand instances, so the launcher clearing its
        // copies is not enough. Publishing the meeting before the reset would let
        // the overlay mount with the previous meeting's transcript (and detect its
        // questions again).
        try {
          await resetMeetingScopedStores();
          initMeetingSpeakers(audioMode);
        } catch (err) {
          console.warn("[App] Failed to reset meeting stores in overlay:", err);
        }
        useMeetingStore.setState({
          activeMeeting: meeting,
          currentView: "overlay",
          audioMode,
          aiScenario,
          isRecording: true,
          meetingStartTime: startedAt,
          elapsedMs: 0,
          lastPersistedIndex: 0,
          selectedMeetingId: null,
          unfinishedMeeting: null,
          settingsOpen: false,
        });
        useMeetingStore.getState().startTimer();
        // Then tell the launcher this window owns the meeting's speaker/bookmark data.
        emitOverlayMeetingReady(meeting.id).catch(() => {});
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [windowLabel]);

  // Toast when Claude is unavailable and requests move to the fallback provider
  useAgentFallbackToast(windowLabel);

  // Claude's model catalog: asked once per app start by the launcher (no
  // model call); the overlay gets it through the persisted config store.
  useEffect(() => {
    if (configLoaded && windowLabel === "launcher") refreshClaudeModelsOnStart();
  }, [configLoaded, windowLabel]);

  const previousView = useMeetingStore((s) => s.previousView);

  // Listen for Escape key to close settings
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (currentView === "settings") {
          // Return to the view settings was opened from
          setCurrentView(previousView || "launcher");
        } else if (settingsOpen) {
          setSettingsOpen(false);
        }
      }
    },
    [currentView, settingsOpen, setCurrentView, setSettingsOpen, previousView]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Listen for tray menu events from Rust backend
  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen("tray_start_meeting", () => {
      startMeetingFlow().catch((err) => {
        console.error("[App] Tray start meeting failed:", err);
      });
    }).then((unlisten) => unlisteners.push(unlisten));

    listen("tray_open_settings", () => {
      // Settings open in the launcher (the tray shows it)
      if (windowLabel === "overlay") return;
      // Use getState() to avoid stale closure captures
      const view = useMeetingStore.getState().currentView;
      if (view === "overlay") {
        useMeetingStore.getState().setSettingsOpen(true);
      } else {
        useMeetingStore.getState().setCurrentView("settings");
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    listen("tray_stop_meeting", () => {
      useMeetingStore.getState().endMeetingFlow().catch((err) => {
        console.error("[App] Tray stop meeting failed:", err);
        // The meeting stays open (e.g. transcript lines not saved yet): say why.
        showToast(err instanceof Error ? err.message : "Couldn't end meeting", "error");
      });
    }).then((unlisten) => unlisteners.push(unlisten));

    listen("tray_toggle_mic", () => {
      useConfigStore.getState().toggleMuteYou();
    }).then((unlisten) => unlisteners.push(unlisten));

    listen("tray_toggle_system", () => {
      useConfigStore.getState().toggleMuteThem();
    }).then((unlisten) => unlisteners.push(unlisten));

    listen("tray_toggle_stealth", () => {
      const store = useMeetingStore.getState();
      const willHide = !store.overlayHidden;
      store.toggleOverlayHidden();
      // Hide/show the overlay window (screen-share stealth is a separate setting)
      import("@tauri-apps/api/webviewWindow").then(async ({ WebviewWindow }) => {
        const overlay = await WebviewWindow.getByLabel("overlay");
        if (overlay) {
          if (willHide) {
            await overlay.hide().catch(() => {});
          } else {
            logToFile("info", "tray", "Hide Overlay toggled: showing the overlay window");
            await overlay.show().catch(() => {});
          }
        }
      }).catch(() => {});
    }).then((unlisten) => unlisteners.push(unlisten));

    onCaptureWarning((message) => {
      showToast(message, "error");
    }).then((unlisten) => unlisteners.push(unlisten));

    onStealthModeChanged((enabled) => {
      useConfigStore.getState().stealthModeApplied(enabled);
    }).then((unlisten) => unlisteners.push(unlisten));

    listen<string>("tray_copy", (e) => {
      console.log("[App] Tray copy requested:", e.payload);
    }).then((unlisten) => unlisteners.push(unlisten));

    listen<string>("tray_open_meeting", (e) => {
      console.log("[App] Tray open meeting requested:", e.payload);
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMeetingFlow]);

  // Don't render until config is loaded from disk — prevents false wizard trigger
  if (!configLoaded) {
    const loadingBg = windowLabel === "overlay" ? "bg-transparent" : "bg-background";
    return (
      <div className={`flex h-screen w-screen items-center justify-center ${loadingBg}`}>
        {windowLabel !== "overlay" && (
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 rounded-xl bg-primary/10 flex items-center justify-center">
              <div className="h-3 w-3 rounded-full bg-primary/40 animate-pulse" />
            </div>
            <div className="text-sm text-muted-foreground">Starting NexQ...</div>
          </div>
        )}
      </div>
    );
  }

  // Determine which view to render
  const resolvedView: AppView = !firstRunCompleted ? "wizard" : currentView;
  const isOverlayWindow = windowLabel === "overlay";
  const isLauncherWindow = windowLabel === "launcher" || windowLabel === "";

  // Overlay Tauri window: always transparent, uses currentView directly (ignores firstRunCompleted)
  if (isOverlayWindow) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-transparent text-foreground">
        <ErrorBoundary fallbackMessage="NexQ encountered an error">
          {currentView === "overlay" && (
            <ErrorBoundary fallbackMessage="Failed to load overlay">
              {/* key on the meeting id → remounts overlay UI per meeting so local
                  state (open panels, tabs, layout mode) does not carry over */}
              <div key={activeMeetingId || "no-meeting"} className="flex h-full">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <OverlayView />
                </div>
                <CallLogPanel />
              </div>
            </ErrorBoundary>
          )}
          {(settingsOpen || currentView === "settings") && (
            <SettingsOverlay isModal={currentView === "overlay"} />
          )}
        </ErrorBoundary>
        <ActiveMeetingProvider isLauncherWindow={false} />
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className={`h-screen w-screen overflow-hidden text-foreground ${resolvedView === "overlay" ? "bg-transparent" : "bg-background"}`}>
      <ErrorBoundary fallbackMessage="NexQ encountered an error">
        {(resolvedView === "launcher" || resolvedView === "overlay") && (
          <ErrorBoundary fallbackMessage="Failed to load launcher">
            <LauncherView />
          </ErrorBoundary>
        )}
        {resolvedView === "wizard" && (
          <ErrorBoundary fallbackMessage="Failed to load setup wizard">
            <FirstRunWizard />
          </ErrorBoundary>
        )}
        {resolvedView === "settings" && (
          <ErrorBoundary fallbackMessage="Failed to load settings">
            <SettingsOverlay />
          </ErrorBoundary>
        )}
        {settingsOpen && resolvedView === "overlay" && <SettingsOverlay isModal />}
      </ErrorBoundary>
      <ActiveMeetingProvider isLauncherWindow={isLauncherWindow} />
      <ToastContainer />
      <SelectionToolbar />
      {/* Call log panel is now integrated into the overlay flex layout above */}

      {/* One-time "update ready" notice (the footer pill stays) */}
      <UpdateReadyToast />

      {/* Demo mode — scenario picker modal + floating exit badge */}
      <DemoPicker />
      <DemoBadge />
    </div>
  );
}

export default App;
