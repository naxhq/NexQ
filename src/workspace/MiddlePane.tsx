import { useRef } from "react";
import { ChevronDown, Library, Loader2, PencilLine, Play, Radio } from "lucide-react";
import { MeetingWave, VoiceprintMark } from "../voiceprint";
import { Tooltip, Button, IconButton } from "../ui";
import { cn } from "../lib/utils";
import { SHORT_PANE, useElementSize } from "./layout";
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

/** Column widths (of this pane, not the window) where the header gives something up. */
export const HEADER_ICONS_BELOW = 700;
export const HEADER_NAME_ONLY_BELOW = 440;

/** One recipe for both Start meeting buttons: md in the header, lg on the empty start screen. */
function StartButton({ starting, onStart, small }: { starting: boolean; onStart: () => void; small?: boolean }) {
  return (
    <Button variant="primary" size={small ? "md" : "lg"} onClick={onStart} disabled={starting} aria-busy={starting}>
      {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" fill="currentColor" aria-hidden="true" />}
      {starting ? "Starting" : "Start meeting"}
    </Button>
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
  onOpenMeeting: (id: string, atMs?: number | null) => void;
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
  const hasMessages = useChatHasMessages(workspace.id);
  const box = useRef<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(box);
  // A chat with messages, or a pane too short to spare the room: one line.
  const compact = hasMessages || height < SHORT_PANE;
  // Measured on this column: with the Library docked it is narrower than the window.
  const iconsOnly = width < HEADER_ICONS_BELOW;
  const nameOnly = width < HEADER_NAME_ONLY_BELOW;

  const wave = meetings.map((m) => ({ id: m.id, title: m.title, date: m.start_time, duration_seconds: m.duration_seconds }));

  const crumbs = (
    <nav aria-label="Breadcrumb" className="ui-meta flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-muted-foreground">
      {!nameOnly && (
        <>
          <Button variant="ghost" size="sm" onClick={onGoAll} className="px-1.5">
            Workspaces
          </Button>
          <span aria-hidden="true" className="shrink-0">
            /
          </span>
        </>
      )}
      <Tooltip content={workspace.name}>
        {/* Buttons do not shrink by default: this one must, or a long name runs under the tools. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSwitcherOpenChange(true)}
          aria-haspopup="dialog"
          aria-label={`${workspace.name}, switch workspace (${formatShortcut(SWITCHER_SHORTCUT)})`}
          className="min-w-0 shrink overflow-hidden px-1.5 text-foreground"
        >
          <VoiceprintMark id={workspace.id} hue={workspace.color} size={13} />
          <span dir="auto" className="min-w-0 truncate">
            {workspace.name}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        </Button>
      </Tooltip>
    </nav>
  );

  const tools = (
    <div className="flex shrink-0 items-center gap-1">
      {activeMeeting && (
        <span className="ui-meta inline-flex items-center gap-1.5 px-1 text-success">
          <Radio className="h-3 w-3" aria-hidden="true" />
          {iconsOnly ? <span className="sr-only">Live</span> : "Live"}
        </span>
      )}
      {iconsOnly ? (
        <Tooltip content="Edit workspace">
          <IconButton aria-label="Edit workspace" onClick={() => actions.edit(workspace.id)}>
            <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
          </IconButton>
        </Tooltip>
      ) : (
        <Button variant="ghost" onClick={() => actions.edit(workspace.id)}>
          <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
          Edit workspace
        </Button>
      )}
      {showLibraryToggle &&
        (iconsOnly ? (
          <Tooltip content="Library">
            <IconButton aria-label="Library" onClick={onToggleLibrary}>
              <Library className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          </Tooltip>
        ) : (
          <Button variant="ghost" onClick={onToggleLibrary}>
            <Library className="h-3.5 w-3.5" aria-hidden="true" />
            Library
          </Button>
        ))}
    </div>
  );

  return (
    <div ref={box} className="flex h-full min-h-0 min-w-0 flex-col" data-header={compact ? "compact" : "full"} data-narrow={iconsOnly ? "true" : undefined}>
      {compact ? (
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
          {crumbs}
          <div className="flex shrink-0 items-center gap-1.5">
            {tools}
            <StartButton starting={starting} onStart={onStart} small />
          </div>
        </header>
      ) : (
        <header className={cn("shrink-0 pb-4 pt-4", iconsOnly ? "px-4" : "px-6")}>
          <div className="flex min-w-0">{crumbs}</div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-48">
              <div className="flex min-w-0 items-center gap-3">
                <VoiceprintMark id={workspace.id} hue={workspace.color} size={26} />
                <h1 dir="auto" className="ui-title min-w-0 truncate text-foreground">
                  {workspace.name}
                </h1>
              </div>
              {workspace.description && <p className="ui-body ui-measure mt-1.5 text-muted-foreground">{workspace.description}</p>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <StartButton starting={starting} onStart={onStart} />
              <span className="ui-meta text-muted-foreground">{startHint(remembered, workspace)}</span>
            </div>
          </div>

          <div className="mt-4 flex min-w-0 items-end justify-between gap-3">
            <div className="min-w-0 flex-1 pb-3">
              {wave.length > 0 ? (
                <>
                  <MeetingWave meetings={wave} hue={workspace.color} onOpen={onOpenMeeting} height={30} />
                  <Tooltip content="Each bar is one meeting, as long as it ran.">
                    <span tabIndex={0} className="ui-meta mt-1 inline-block rounded text-muted-foreground outline-none ui-focus ui-focus-sm">
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
        <ChatPane workspaceId={workspace.id} onOpenMeeting={(id, atMs) => onOpenMeeting(id, atMs)} onOpenItem={(kind, refId, subRef) => void handleOpenRequest({ kind, ref_id: refId, sub_ref: subRef })} />
      </div>

      <WorkspaceSwitcher open={switcherOpen} onClose={() => onSwitcherOpenChange(false)} />
    </div>
  );
}
