import { useCallback, useEffect, useRef, useState } from "react";
import { FilePlus2, X } from "lucide-react";
import { SlideOver } from "../ui";
import { useTauriFileDrop, describeAdd } from "../context/FileUpload";
import { showToast } from "../stores/toastStore";
import { defaultWorkspaceOf, shouldShowGeneralNote, useWorkspaceStore, workspaceById } from "../stores/workspaceStore";
import { AllWorkspaces } from "./AllWorkspaces";
import { addFilesToWorkspace } from "./addMaterial";
import {
  LIBRARY_DEFAULT,
  LIBRARY_MAX,
  LIBRARY_MIN,
  NARROW_RAIL,
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  shellModeFor,
  useElementWidth,
} from "./layout";
import { LibraryPanel } from "./LibraryPanel";
import { MeetingList } from "./MeetingList";
import { MiddlePane } from "./MiddlePane";
import { ResizeHandle } from "./ResizeHandle";
import { useWorkspaceActions } from "./WorkspaceActions";
import { WorkspaceRail } from "./WorkspaceRail";

/** Keys that are free in the launcher (Ctrl+M, B, comma, Shift+L and Shift+D are taken elsewhere). */
export const HOME_SHORTCUTS = {
  switcher: { key: "o", label: "CmdOrCtrl+Shift+O" },
  create: { key: "n", label: "CmdOrCtrl+Shift+N" },
  library: { key: "y", label: "CmdOrCtrl+Shift+Y" },
} as const;

/**
 * The launcher's home: the rail (workspaces, then the open one's meetings), the
 * middle (header and chat) and the Library. Three panels from 1100 px wide, the
 * Library as a sheet from 820, a rail of marks below that: measured on this
 * element, not on the window.
 */
export function WorkspaceHome({
  starting,
  onStart,
  onOpenMeeting,
}: {
  starting: boolean;
  onStart: () => void;
  onOpenMeeting: (meetingId: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(box);
  const mode = shellModeFor(width);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const openId = useWorkspaceStore((s) => s.openId);
  const view = useWorkspaceStore((s) => s.view);
  const setView = useWorkspaceStore((s) => s.setView);
  const railWidth = useWorkspaceStore((s) => s.railWidth);
  const libraryWidth = useWorkspaceStore((s) => s.libraryWidth);
  const setRailWidth = useWorkspaceStore((s) => s.setRailWidth);
  const setLibraryWidth = useWorkspaceStore((s) => s.setLibraryWidth);
  const sheetOpen = useWorkspaceStore((s) => s.librarySheetOpen);
  const setSheetOpen = useWorkspaceStore((s) => s.setLibrarySheetOpen);
  const noteVisible = useWorkspaceStore(shouldShowGeneralNote);
  const dismissNote = useWorkspaceStore((s) => s.dismissNote);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const actions = useWorkspaceActions();
  const [switcher, setSwitcher] = useState(false);
  const [meetingsSheet, setMeetingsSheet] = useState(false);
  const [meetingQuery, setMeetingQuery] = useState("");

  const open = workspaceById(workspaces, openId) ?? defaultWorkspaceOf(workspaces);

  // Another workspace: a fresh search.
  useEffect(() => setMeetingQuery(""), [openId]);

  // Files dropped on the window go to the open workspace (Tauri's drop event: `File.path` is empty in WebView2).
  const { dragging } = useTauriFileDrop(
    useCallback(
      (paths, skipped) => {
        if (paths.length === 0 && skipped.length === 0) return;
        addFilesToWorkspace(paths, open.id).then((r) => {
          const said = describeAdd(r.added, r.failed.length, skipped.length);
          if (r.added > 0) showToast(`Added ${r.added} ${r.added === 1 ? "file" : "files"} to ${open.name}`, "success");
          if (said) showToast(said, "warning");
        });
      },
      [open.id, open.name],
    ),
    view === "home",
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === HOME_SHORTCUTS.switcher.key) setSwitcher((v) => !v);
      else if (k === HOME_SHORTCUTS.create.key) actions.create();
      else if (k === HOME_SHORTCUTS.library.key) {
        if (mode === "wide") return;
        setSheetOpen(!useWorkspaceStore.getState().librarySheetOpen);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, mode, setSheetOpen]);

  const narrow = mode === "narrow";
  const railPx = narrow ? NARROW_RAIL : railWidth;
  const openMeetingFromAll = (workspaceId: string, meetingId: string) => {
    openWorkspace(workspaceId);
    onOpenMeeting(meetingId);
  };

  return (
    <div ref={box} className="relative flex h-full min-h-0 flex-col" data-shell-mode={mode}>
      {noteVisible && (
        <div role="note" className="ui-body flex items-center justify-between gap-3 border-b border-border bg-accent/50 px-6 py-2 text-foreground">
          <span>Your meetings and files are in General. New workspaces keep their own.</span>
          <button
            type="button"
            onClick={dismissNote}
            aria-label="Dismiss this note"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside style={{ width: railPx }} className="shrink-0 overflow-hidden bg-card/40" aria-label="Workspaces and meetings">
          <WorkspaceRail
            narrow={narrow}
            onOpenMeeting={onOpenMeeting}
            onShowMeetings={() => setMeetingsSheet(true)}
            meetingQuery={meetingQuery}
            onMeetingQuery={setMeetingQuery}
          />
        </aside>
        {!narrow && (
          <ResizeHandle label="Resize the workspace list" value={railWidth} min={RAIL_MIN} max={RAIL_MAX} fallback={RAIL_DEFAULT} grow={1} onChange={setRailWidth} />
        )}
        {narrow && <div className="w-px shrink-0 bg-border" aria-hidden="true" />}

        <main className="min-w-0 flex-1">
          {view === "all" ? (
            <AllWorkspaces onOpenMeeting={openMeetingFromAll} />
          ) : (
            <MiddlePane
              workspace={open}
              starting={starting}
              onStart={onStart}
              onOpenMeeting={onOpenMeeting}
              showLibraryToggle={mode !== "wide"}
              onToggleLibrary={() => setSheetOpen(!sheetOpen)}
              onShowLibrary={() => mode !== "wide" && setSheetOpen(true)}
              onGoAll={() => setView("all")}
              switcherOpen={switcher}
              onSwitcherOpenChange={setSwitcher}
            />
          )}
        </main>

        {mode === "wide" && view === "home" && (
          <>
            <ResizeHandle label="Resize the library" value={libraryWidth} min={LIBRARY_MIN} max={LIBRARY_MAX} fallback={LIBRARY_DEFAULT} grow={-1} onChange={setLibraryWidth} />
            <aside style={{ width: libraryWidth }} className="shrink-0 bg-card/40" aria-label="Library">
              <LibraryPanel workspaceId={open.id} />
            </aside>
          </>
        )}
      </div>

      {mode !== "wide" && (
        <SlideOver open={sheetOpen && view === "home"} onClose={() => setSheetOpen(false)} title={`Library of ${open.name}`}>
          <div className="-mx-5 -my-3 h-[calc(100vh-7rem)]">
            <LibraryPanel workspaceId={open.id} />
          </div>
        </SlideOver>
      )}
      {narrow && (
        <SlideOver side="left" open={meetingsSheet} onClose={() => setMeetingsSheet(false)} title={`Meetings in ${open.name}`}>
          <div className="-mx-5 -my-3 flex h-[calc(100vh-7rem)] flex-col">
            <MeetingList
              workspace={open}
              query={meetingQuery}
              onQueryChange={setMeetingQuery}
              onOpenMeeting={(id) => {
                setMeetingsSheet(false);
                onOpenMeeting(id);
              }}
            />
          </div>
        </SlideOver>
      )}

      {dragging && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-background/85"
        >
          <FilePlus2 className="h-6 w-6 text-primary" aria-hidden="true" />
          <p className="ui-section text-foreground">Drop to add to {open.name}</p>
          <p className="ui-meta text-muted-foreground">PDF, text, Markdown or Word files</p>
        </div>
      )}
    </div>
  );
}
