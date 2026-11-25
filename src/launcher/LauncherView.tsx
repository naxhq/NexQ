import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import { formatShortcut } from "../lib/shortcutLabel";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { showToast } from "../stores/toastStore";
import { lazyNamed } from "../lib/lazyNamed";

// Past meetings open in their own chunk.
const MeetingDetails = lazyNamed(() => import("./meeting-details/MeetingDetailsContainer"), "MeetingDetails");
import { MeetingSetupModal, type MeetingSetupChoice } from "./MeetingSetupModal";
import { NEXQ_VERSION, NEXQ_DEVELOPER } from "../lib/version";
import { ServiceStatusBar } from "../components/ServiceStatusBar";
import { showMeetingOverlay } from "../lib/windows";
import { endMeetingFromThisWindow } from "../hooks/useUpdater";
import { Dialog, Button } from "../ui";
import { WorkspaceActionsProvider } from "../workspace/WorkspaceActions";
import { WorkspaceHome } from "../workspace/WorkspaceHome";
import { SkipLinks, useRegionKeys } from "../workspace/regions";
import { DatabaseProblemScreen } from "../workspace/DatabaseProblemScreen";
import { handleOpenRequest, type OpenRequest } from "../workspace/openRequest";
import type { AudioMode, AIScenario } from "../lib/types";
import { Settings, Radio } from "lucide-react";
import { LauncherStealthButton } from "./LauncherStealthButton";

// Start-on-login begins a meeting once per app launch. This lives outside the
// component: the launcher unmounts while a demo or Settings is on screen and
// remounts after, which must not start a recording.
let autoStartDone = false;

/** Test hook: lets the next mount auto-start again. */
export function resetLauncherAutoStart() {
  autoStartDone = false;
}

/** What the person chose in the setup dialog, kept while the running meeting is dealt with. */
interface PendingSetup extends MeetingSetupChoice {
  audioMode: AudioMode;
  scenario: AIScenario;
}

/**
 * The launcher window: a header, the workspace home (rail, chat, library) or a
 * past meeting's details, and the footer. Meetings started here are filed in
 * the workspace that is open.
 */
export function LauncherView() {
  const setCurrentView = useMeetingStore((s) => s.setCurrentView);
  const startMeetingFlow = useMeetingStore((s) => s.startMeetingFlow);
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const selectedMeetingId = useMeetingStore((s) => s.selectedMeetingId);
  const setSelectedMeetingId = useMeetingStore((s) => s.setSelectedMeetingId);
  const loadRecentMeetings = useMeetingStore((s) => s.loadRecentMeetings);
  const openId = useWorkspaceStore((s) => s.openId);
  const database = useWorkspaceStore((s) => s.database);

  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showConflictPrompt, setShowConflictPrompt] = useState(false);
  const [showMeetingSetup, setShowMeetingSetup] = useState(false);
  // What was chosen in the setup dialog while a meeting still runs: used when "End and start new" goes ahead.
  const pendingMeetingSetup = useRef<PendingSetup | null>(null);

  // A brief source asks to open a meeting (raised in this window or the meeting window).
  useEffect(() => {
    const open = (d: OpenRequest | undefined) => void handleOpenRequest(d);
    const local = (e: Event) => open((e as CustomEvent).detail);
    window.addEventListener("nexq:workspace_open", local);
    let off: (() => void) | undefined;
    let gone = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<OpenRequest>("nexq:workspace_open", (e) => open(e.payload)))
      .then((u) => (gone ? u() : (off = u)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
      window.removeEventListener("nexq:workspace_open", local);
    };
  }, []);

  useEffect(() => {
    loadRecentMeetings();
    if (!autoStartDone) {
      autoStartDone = true;
      const { startOnLogin } = useConfigStore.getState();
      const { activeMeeting: am } = useMeetingStore.getState();
      // Not a click in a workspace: it starts in the default one.
      if (startOnLogin && !am) startMeetingFlow();
    }
  }, [loadRecentMeetings, startMeetingFlow]);

  const begin = useCallback(
    async (setup: PendingSetup, toast: string) => {
      setIsStarting(true);
      setStartError(null);
      try {
        await startMeetingFlow(undefined, setup.audioMode, setup.scenario, { workspaceId: setup.workspaceId, borrowed: setup.borrowed });
        showToast(toast, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to start meeting";
        setStartError(msg);
        showToast(msg, "error");
      } finally {
        setIsStarting(false);
      }
    },
    [startMeetingFlow],
  );

  // Start meeting: the setup dialog always opens first, so what is chosen is never lost.
  const handleStartMeeting = useCallback(() => setShowMeetingSetup(true), []);

  const handleSetupConfirm = useCallback(
    (audioMode: AudioMode, scenario: AIScenario, choice: MeetingSetupChoice) => {
      setShowMeetingSetup(false);
      const setup: PendingSetup = { audioMode, scenario, ...choice };
      if (useMeetingStore.getState().activeMeeting) {
        // A meeting still runs: keep the choice for "End current and start new".
        pendingMeetingSetup.current = setup;
        setShowConflictPrompt(true);
        return;
      }
      void begin(setup, "Meeting started");
    },
    [begin],
  );

  const closeConflict = useCallback(() => {
    pendingMeetingSetup.current = null;
    setShowConflictPrompt(false);
  }, []);

  const handleEndAndStartNew = useCallback(async () => {
    setShowConflictPrompt(false);
    const setup = pendingMeetingSetup.current;
    pendingMeetingSetup.current = null;
    setIsStarting(true);
    try {
      // The overlay saves its own data: wait until every window has ended it.
      if (!(await endMeetingFromThisWindow())) {
        throw new Error("Couldn't finish saving the meeting, so the new meeting was not started");
      }
      await startMeetingFlow(undefined, setup?.audioMode, setup?.scenario, setup ? { workspaceId: setup.workspaceId, borrowed: setup.borrowed } : undefined);
      showToast("New meeting started", "success");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setIsStarting(false);
    }
  }, [startMeetingFlow]);

  const handleOpenMeeting = useCallback(
    (meetingId: string, atMs?: number | null) => {
      if (activeMeeting?.id === meetingId) {
        showMeetingOverlay().catch(() => {});
        return;
      }
      if (typeof atMs === "number") useMeetingStore.getState().openMeetingAt(meetingId, atMs);
      else setSelectedMeetingId(meetingId);
    },
    [activeMeeting, setSelectedMeetingId],
  );

  useRegionKeys();

  const handleReturnToMeeting = useCallback(() => {
    showMeetingOverlay().catch(() => {});
  }, []);

  return (
    <WorkspaceActionsProvider>
      <div className="flex h-full flex-col bg-background">
        <SkipLinks />
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-2.5">
          <div className="flex items-center gap-2.5">
            <img src="/nexq-icon.png" alt="NexQ" className="h-7 w-7 rounded-lg" />
            <span className="text-sm font-bold tracking-tight text-foreground">NexQ</span>
          </div>

          {activeMeeting && (
            <button
              onClick={handleReturnToMeeting}
              className="flex max-w-[24rem] cursor-pointer items-center gap-2 rounded-full border border-success/30 bg-success/10 py-1 pl-3 pr-1.5 outline-none transition-colors hover:bg-success/15 ui-focus ui-focus-pill"
            >
              <Radio className="h-3 w-3 shrink-0 text-success" aria-hidden="true" />
              <span className="ui-meta truncate font-medium text-foreground">{activeMeeting.title}</span>
              <span className="ui-meta rounded-full bg-success/20 px-2 py-0.5 font-semibold text-success">Return to meeting</span>
            </button>
          )}

          <div className="flex items-center gap-1">
            <LauncherStealthButton />
            <button
              onClick={() => setCurrentView("settings")}
              className="cursor-pointer rounded-lg p-2 text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground ui-focus ui-r-lg"
              aria-label={`Settings (${formatShortcut("CmdOrCtrl+,")})`}
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {startError && (
          <p role="alert" className="ui-body border-b border-destructive/30 bg-destructive/5 px-5 py-1.5 text-destructive">
            {startError}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {database ? (
            // The meetings file can't be used: nothing to list, ask or start from. Settings and the footer stay.
            <DatabaseProblemScreen problem={database} />
          ) : selectedMeetingId ? (
            <Suspense fallback={null}>
              <MeetingDetails meetingId={selectedMeetingId} onBack={() => setSelectedMeetingId(null)} />
            </Suspense>
          ) : (
            <WorkspaceHome starting={isStarting} onStart={handleStartMeeting} onOpenMeeting={handleOpenMeeting} />
          )}
        </div>

        <footer id="region-footer" data-region tabIndex={-1} aria-label="Status" className="flex items-center justify-between border-t border-border outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60">
          <ServiceStatusBar />
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap pr-5 ui-meta text-muted-foreground">
            <span className="hidden min-[900px]:inline">&copy; {new Date().getFullYear()} {NEXQ_DEVELOPER}</span>
            <span className="hidden text-muted-foreground/60 min-[900px]:inline">|</span>
            <span className="font-medium">NexQ v{NEXQ_VERSION}</span>
          </div>
        </footer>

        <MeetingSetupModal
          open={showMeetingSetup}
          workspaceId={openId}
          onStart={handleSetupConfirm}
          onCancel={() => setShowMeetingSetup(false)}
        />

        <Dialog
          open={showConflictPrompt}
          onClose={closeConflict}
          title="Meeting in progress"
          description={`"${activeMeeting?.title ?? "A meeting"}" is still running.`}
          size="sm"
          footer={
            <>
              <Button  onClick={closeConflict}>
                Cancel
              </Button>
              <Button
                
                onClick={() => {
                  closeConflict();
                  handleReturnToMeeting();
                }}>
                Return to current meeting
              </Button>
              <Button variant="primary"  onClick={handleEndAndStartNew}>
                End current and start new
              </Button>
            </>
          }
        />
      </div>
    </WorkspaceActionsProvider>
  );
}
