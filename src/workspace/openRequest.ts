import { listLibrary } from "../lib/ipc";
import { useMeetingStore } from "../stores/meetingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** What `nexq:workspace_open` carries (the chat uses camel case on window, the brief and Tauri use snake case). */
export interface OpenRequest {
  kind?: string;
  ref_id?: string;
  refId?: string;
  meetingId?: string;
  sub_ref?: string | null;
  subRef?: string | null;
  start_ms?: number | null;
  atMs?: number | null;
}

/**
 * Something was clicked in a chat answer or a brief and asks to be shown.
 * A meeting opens in the launcher; a document or folder file brings up the
 * Library and marks its row; a talking point opens its editor.
 */
export async function handleOpenRequest(d: OpenRequest | undefined): Promise<void> {
  const id = d?.ref_id ?? d?.refId ?? d?.meetingId;
  if (!d || !id) return;
  if (d.kind === "transcript" || d.kind === "meeting") {
    // A line of a transcript opens at its moment (0 ms is a moment); a meeting alone opens at the top.
    const at = d.kind === "transcript" ? (d.start_ms ?? d.atMs ?? null) : null;
    useMeetingStore.getState().openMeetingAt(id, at);
    return;
  }
  if (d.kind !== "document" && d.kind !== "folder" && d.kind !== "talking_point") return;

  const ws = useWorkspaceStore.getState();
  let workspaceId = ws.openId;
  if (d.kind !== "talking_point") {
    // The workspace that holds it: the open one when it does, else the first that does.
    const open = ws.details[ws.openId] ?? (await ws.loadDetail(ws.openId));
    const here = open?.items.some((i) => i.kind === d.kind && i.ref_id === id);
    if (!here) {
      try {
        const hit = (await listLibrary()).find((i) => i.kind === d.kind && i.ref_id === id);
        const target = hit?.workspace_ids.find((w) => ws.workspaces.some((x) => x.id === w && !x.archived));
        if (target) workspaceId = target;
      } catch {
        /* keep the open workspace */
      }
    }
  }
  const state = useWorkspaceStore.getState();
  if (workspaceId !== state.openId || state.view !== "home") state.openWorkspace(workspaceId);
  useMeetingStore.getState().setSelectedMeetingId(null);
  useWorkspaceStore.getState().setLibrarySheetOpen(true);
  useWorkspaceStore.getState().setFocus({ kind: d.kind, refId: id, subRef: d.sub_ref ?? d.subRef ?? null, workspaceId });
}
