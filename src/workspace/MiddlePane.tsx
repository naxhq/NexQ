import { useRef, useState } from "react";
import { cn } from "../lib/utils";
import { SHORT_PANE, useElementSize } from "./layout";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceChatStore } from "../stores/workspaceChatStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { WorkspaceSummary } from "../lib/types";
import { ChatPane } from "./chat/ChatPane";
import { handleOpenRequest } from "./openRequest";
import { useWorkspaceMeetings } from "./useWorkspaceMeetings";
import { waveMeetings } from "./waveMeetings";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useWorkspaceActions } from "./WorkspaceActions";
import { WorkspaceHeader, HEADER_ICONS_BELOW, HEADER_NAME_ONLY_BELOW } from "./WorkspaceHeader";
import { DEFAULT_EXTRA, condenseRange } from "./headerCollapse";
import { useHeaderCollapse } from "./useHeaderCollapse";

export { HEADER_ICONS_BELOW, HEADER_NAME_ONLY_BELOW };

/** A chat with something in it is open: the header gives its room to the answers. */
function useChatHasMessages(workspaceId: string): boolean {
  return useWorkspaceChatStore((s) => {
    const id = s.activeChat[workspaceId];
    const session = id ? s.sessions[id] : undefined;
    return !!session && (session.messages.length > 0 || !!session.turn);
  });
}

/**
 * The middle of the home: where you are (a breadcrumb that switches), the workspace's name and its
 * meetings as one wave, the Start meeting button as the strongest thing on screen, and the chat.
 * The header is one thing that condenses as a chat is scrolled (see `WorkspaceHeader`).
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
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);
  const unavailable = useWorkspaceStore((s) => s.unavailable);
  // The wave shows the whole history: a big page, with the oldest gathered by month.
  const { meetings, total } = useWorkspaceMeetings(workspace.id, "", "here", 1000);
  const hasMessages = useChatHasMessages(workspace.id);
  const chatId = useWorkspaceChatStore((s) => s.activeChat[workspace.id] ?? "");
  const box = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLElement>(null);
  const block = useRef<HTMLDivElement>(null);
  const extras = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(box);
  const [measured, setMeasured] = useState(DEFAULT_EXTRA);
  const range = condenseRange(measured);

  // A chat with messages scrolls the header down to a bar; a pane too short to spare the room starts as the bar.
  const short = height < SHORT_PANE;
  const collapsing = hasMessages || short;
  const { mode, pinned, toggle, closePinned } = useHeaderCollapse({
    box,
    parts: { overlay, block, extras },
    active: collapsing,
    locked: short && !hasMessages,
    range,
    resetKey: chatId,
  });
  const header = collapsing ? mode : "full";

  const wave = waveMeetings(meetings);

  return (
    <div
      ref={box}
      className="relative flex h-full min-h-0 min-w-0 flex-col"
      data-header={header}
      data-narrow={width < HEADER_ICONS_BELOW ? "true" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && pinned) {
          e.stopPropagation();
          closePinned();
        }
      }}
    >
      <WorkspaceHeader
        workspace={workspace}
        wave={wave}
        total={total}
        starting={starting}
        live={!!activeMeeting}
        unavailable={unavailable}
        width={width}
        collapsing={collapsing}
        mode={mode}
        pinned={pinned}
        extra={range}
        parts={{ overlay, block, extras }}
        onExtra={setMeasured}
        onToggle={toggle}
        onStart={onStart}
        onOpenMeeting={(id) => onOpenMeeting(id)}
        onEdit={() => actions.edit(workspace.id)}
        onGoAll={onGoAll}
        onSwitch={() => onSwitcherOpenChange(true)}
        showLibraryToggle={showLibraryToggle}
        onToggleLibrary={onToggleLibrary}
      />

      <div className={cn("min-h-0 flex-1 overflow-hidden", !collapsing && "border-t border-border")}>
        <ChatPane
          workspaceId={workspace.id}
          topInset={collapsing && hasMessages ? range : 0}
          onOpenMeeting={(id, atMs) => onOpenMeeting(id, atMs)}
          onOpenItem={(kind, refId, subRef) => void handleOpenRequest({ kind, ref_id: refId, sub_ref: subRef })}
        />
      </div>

      <WorkspaceSwitcher open={switcherOpen} onClose={() => onSwitcherOpenChange(false)} />
    </div>
  );
}
