import { ChevronDown, Library, Loader2, PencilLine, Play, Radio } from "lucide-react";
import { MeetingWave, VoiceprintMark } from "../voiceprint";
import { Tooltip } from "../ui";
import { formatShortcut } from "../lib/shortcutLabel";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceChatStore } from "../stores/workspaceChatStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { WorkspaceSummary } from "../lib/types";
import { ChatPane } from "./chat/ChatPane";
import { handleOpenRequest } from "./openRequest";
import { useWorkspaceMeetings } from "./useWorkspaceMeetings";
import { WorkspaceSwitcher, SWITCHER_SHORTCUT } from "./WorkspaceSwitcher";
import { useWorkspaceActions } from "./WorkspaceActions";
import { quietButton } from "./styles";

/** "Online, team meeting": what Start will use, said under the button. */
function startHint(remembered: { audioMode: string; scenario: string } | null, workspace: WorkspaceSummary): string {
  if (remembered) {
    const mode = remembered.audioMode === "online" ? "Online" : "In person";
    const scenario = (workspace.default_scenario ?? remembered.scenario).replace(/^custom_.*/, "custom scenario").replace(/_/g, " ");
    return `${mode}, ${scenario}`;
  }
  return formatShortcut("CmdOrCtrl+M");
}

/** A chat with something in it is open: the header gives its room to the answers. */
function useChatHasMessages(workspaceId: string): boolean {
  return useWorkspaceChatStore((s) => {
    const id = s.activeChat[workspaceId];
    const session = id ? s.sessions[id] : undefined;
    return !!session && (session.messages.length > 0 || !!session.turn);
  });
}

function StartButton({ starting, onStart, small }: { starting: boolean; onStart: () => void; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={starting}
      aria-busy={starting}
      className={
        small
          ? "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[0.8125rem] font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-60"
          : "inline-flex h-11 items-center gap-2.5 rounded-xl bg-primary px-6 text-[0.9375rem] font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
      }
    >
      {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" fill="currentColor" aria-hidden="true" />}
      {starting ? "Starting" : "Start meeting"}
    </button>
  );
}

/**
 * The middle of the home: where you are (a breadcrumb that switches), the
 * workspace's name and its meetings as one wave, the Start meeting button as
 * the strongest thing on screen, and the chat. Once a chat has messages the
 * header shrinks to one line so the answers get the room.
 */
export function MiddlePane({
  workspace,
  starting,
  onStart,
  onOpenMeeting,
  showLibraryToggle,
  onToggleLibrary,
  onShowLibrary,
  onGoAll,
  switcherOpen,
  onSwitcherOpenChange,
}: {
  workspace: WorkspaceSummary;
  starting: boolean;
  onStart: () => void;
  onOpenMeeting: (id: string) => void;
  showLibraryToggle: boolean;
  onToggleLibrary: () => void;
  /** A cited file or note was clicked: bring the Library into view. */
  onShowLibrary: () => void;
  onGoAll: () => void;
  switcherOpen: boolean;
  onSwitcherOpenChange: (open: boolean) => void;
}) {
  const actions = useWorkspaceActions();
  const remembered = useConfigStore((s) => s.rememberedMeetingSetup);
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const unavailable = useWorkspaceStore((s) => s.unavailable);
  const { meetings, total } = useWorkspaceMeetings(workspace.id, "", "here");
  const compact = useChatHasMessages(workspace.id);

  const wave = meetings.map((m) => ({ id: m.id, title: m.title, date: m.start_time, duration_seconds: m.duration_seconds }));

  const crumbs = (
    <nav aria-label="Breadcrumb" className="ui-meta flex min-w-0 items-center gap-1 text-muted-foreground">
      <button
        type="button"
        onClick={onGoAll}
        className="shrink-0 rounded px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        Workspaces
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        onClick={() => onSwitcherOpenChange(true)}
        aria-haspopup="dialog"
        aria-label={`${workspace.name}, switch workspace (${formatShortcut(SWITCHER_SHORTCUT)})`}
        className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <VoiceprintMark id={workspace.id} hue={workspace.color} size={13} />
        <span className="truncate">{workspace.name}</span>
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>
    </nav>
  );

  const tools = (
    <div className="flex shrink-0 items-center gap-1">
      {activeMeeting && (
        <span className="ui-meta inline-flex items-center gap-1.5 px-2 text-success">
          <Radio className="h-3 w-3" aria-hidden="true" />
          Live
        </span>
      )}
      <button type="button" onClick={() => actions.edit(workspace.id)} className={quietButton}>
        <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
        Edit workspace
      </button>
      {showLibraryToggle && (
        <button type="button" onClick={onToggleLibrary} className={quietButton}>
          <Library className="h-3.5 w-3.5" aria-hidden="true" />
          Library
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-header={compact ? "compact" : "full"}>
      {compact ? (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-2">
          {crumbs}
          <div className="flex shrink-0 items-center gap-2">
            {tools}
            <StartButton starting={starting} onStart={onStart} small />
          </div>
        </header>
      ) : (
        <header className="shrink-0 px-6 pb-4 pt-4">
          {crumbs}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-64">
              <div className="flex items-center gap-3">
                <VoiceprintMark id={workspace.id} hue={workspace.color} size={26} />
                <h1 className="ui-title truncate text-foreground">{workspace.name}</h1>
              </div>
              {workspace.description && <p className="ui-body ui-measure mt-1.5 text-muted-foreground">{workspace.description}</p>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <StartButton starting={starting} onStart={onStart} />
              <span className="ui-meta text-muted-foreground">{startHint(remembered, workspace)}</span>
            </div>
          </div>

          <div className="mt-4 flex items-end justify-between gap-4">
            <div className="min-w-0 flex-1 pb-3">
              {wave.length > 0 ? (
                <>
                  <MeetingWave meetings={wave} hue={workspace.color} onOpen={onOpenMeeting} height={30} />
                  <Tooltip content="Each bar is one meeting, as long as it ran.">
                    <span tabIndex={0} className="ui-meta mt-1 inline-block rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                      {total} {total === 1 ? "meeting" : "meetings"}
                    </span>
                  </Tooltip>
                </>
              ) : (
                <p className="ui-meta text-muted-foreground">No meetings yet. Each one you hold here becomes a bar.</p>
              )}
            </div>
            {tools}
          </div>
          {unavailable && (
            <p className="ui-meta mt-3 rounded-lg bg-accent px-3 py-2 text-foreground" role="note">
              Workspaces aren't available right now. Everything is in General, and NexQ works as before.
            </p>
          )}
        </header>
      )}

      <div className={compact ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-hidden border-t border-border"}>
        <ChatPane workspaceId={workspace.id} onOpenMeeting={(id) => onOpenMeeting(id)} onOpenItem={(kind, refId, subRef) => void handleOpenRequest({ kind, ref_id: refId, sub_ref: subRef })} />
      </div>

      <WorkspaceSwitcher open={switcherOpen} onClose={() => onSwitcherOpenChange(false)} />
    </div>
  );
}
