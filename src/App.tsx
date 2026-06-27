import { useEffect, useCallback, useState } from "react";
import { useMeetingStore } from "./stores/meetingStore";
import { useConfigStore } from "./stores/configStore";
import { useAIActionsStore } from "./stores/aiActionsStore";
import { LauncherView } from "./launcher/LauncherView";
import { OverlayView } from "./overlay/OverlayView";
import { SettingsOverlay } from "./settings/SettingsOverlay";
import { FirstRunWizard } from "./components/wizard/FirstRunWizard";
import { ToastContainer } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateDialog } from "./components/UpdateDialog";
import { UpdateDownloadToast, UpdateReadyToast } from "./components/UpdateToast";
import { useTheme } from "./hooks/useTheme";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { useTranslation } from "./hooks/useTranslation";
import { useTraySync } from "./hooks/useTraySync";
import { useUpdater } from "./hooks/useUpdater";
import { useTranslationStore } from "./stores/translationStore";
import { CallLogPanel } from "./calllog";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { ActiveMeetingProvider } from "./components/ActiveMeetingProvider";
import { listen } from "@tauri-apps/api/event";
import { NEXQ_VERSION } from "./lib/version";
import type { AppView, Meeting, AudioMode, AIScenario } from "./lib/types";
import { useDemoShortcut } from "./demo/useDemoShortcut";
import { DemoPicker } from "./demo/DemoPicker";
import { DemoBadge } from "./demo/DemoBadge";
import { showLauncherWindow, showOverlayWindow } from "./lib/windows";

function App() {
  const currentView = useMeetingStore((s) => s.currentView);
  const settingsOpen = useMeetingStore((s) => s.settingsOpen);
  const setSettingsOpen = useMeetingStore((s) => s.setSettingsOpen);
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const startMeetingFlow = useMeetingStore((s) => s.startMeetingFlow);
  const loadRecentMeetings = useMeetingStore((s) => s.loadRecentMeetings);
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

  // Auto-update lifecycle: startup check, periodic checks, download, restart
  const {
    checkStatus,
    availableUpdate,
    downloadStatus,
    downloadedBytes,
    totalBytes,
    startDownload,
    restart,
    skipVersion,
  } = useUpdater();

  const [showUpdateDialog, setShowUpdateDialog] = useState(false);

  // Show dialog when update becomes available (startup check)
  useEffect(() => {
    if (checkStatus === "available" && availableUpdate) {
      setShowUpdateDialog(true);
    }
  }, [checkStatus, availableUpdate]);

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

  // LAUNCHER window: when meeting starts, show overlay Tauri window and hide self
  useEffect(() => {
    if (windowLabel !== "launcher") return;
    if (currentView === "overlay") {
      showOverlayWindow().catch(() => {});
    }
  }, [currentView, windowLabel]);

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
      (e) => {
        const { meeting, audioMode, aiScenario } = e.payload;
        useMeetingStore.setState({
          activeMeeting: meeting,
          currentView: "overlay",
          audioMode,
          aiScenario,
          isRecording: true,
          meetingStartTime: Date.now(),
          elapsedMs: 0,
          lastPersistedIndex: 0,
        });
        useMeetingStore.getState().startTimer();
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [windowLabel]);

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
      // Hide/show overlay window and toggle capture stealth
      import("@tauri-apps/api/webviewWindow").then(async ({ WebviewWindow }) => {
        const overlay = await WebviewWindow.getByLabel("overlay");
        if (overlay) {
          if (willHide) {
            await overlay.hide().catch(() => {});
          } else {
            await overlay.show().catch(() => {});
          }
        }
      }).catch(() => {});
      import("./lib/ipc").then(({ setStealthMode }) => {
        setStealthMode(willHide).catch((e: unknown) =>
          console.warn("[App] Failed to set stealth mode:", e)
        );
      }).catch(() => {});
    }).then((unlisten) => unlisteners.push(unlisten));

    listen("tray_show_overlay", () => {
      showOverlayWindow().catch(() => {});
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
              <div className="flex h-full">
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
        {resolvedView === "launcher" && (
          <ErrorBoundary fallbackMessage="Failed to load launcher">
            <LauncherView />
          </ErrorBoundary>
        )}
        {resolvedView === "overlay" && (
          <ErrorBoundary fallbackMessage="Failed to load overlay">
            <div className="flex h-full">
              <div className="flex-1 min-w-0 overflow-hidden">
                <OverlayView />
              </div>
              <CallLogPanel />
            </div>
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

      {/* Update Dialog — shown when a new version is detected */}
      {showUpdateDialog && availableUpdate && (
        <UpdateDialog
          currentVersion={NEXQ_VERSION}
          newVersion={availableUpdate.version}
          changelog={availableUpdate.body}
          onUpdate={() => { setShowUpdateDialog(false); startDownload(); }}
          onLater={() => setShowUpdateDialog(false)}
          onSkip={() => { skipVersion(availableUpdate.version); setShowUpdateDialog(false); }}
        />
      )}

      {/* Update Download Toast — progress indicator while downloading */}
      {downloadStatus === "downloading" && availableUpdate && (
        <div className="fixed bottom-4 right-4 z-50">
          <UpdateDownloadToast
            version={availableUpdate.version}
            downloadedBytes={downloadedBytes}
            totalBytes={totalBytes}
          />
        </div>
      )}

      {/* Update Ready Toast — restart prompt after download completes */}
      {downloadStatus === "ready" && availableUpdate && (
        <div className="fixed bottom-4 right-4 z-50">
          <UpdateReadyToast version={availableUpdate.version} onRestart={restart} />
        </div>
      )}

      {/* Demo mode — scenario picker modal + floating exit badge */}
      <DemoPicker />
      <DemoBadge />
    </div>
  );
}

export default App;
