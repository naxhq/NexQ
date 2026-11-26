import type { PassageKind, WorkspaceCitation } from "../../lib/types";

/** How the pane asks its parent to open something. Missing handlers fall back to `OPEN_EVENT` on window. */
export interface ChatOpeners {
  /** Open a meeting, at a moment when `atMs` is given. */
  onOpenMeeting?: (meetingId: string, atMs?: number | null) => void;
  /** Open a document, a folder file or a talking point. */
  onOpenItem?: (kind: Exclude<PassageKind, "transcript">, refId: string, subRef?: string | null) => void;
}

export const OPEN_EVENT = "nexq:workspace_open";

export type OpenDetail =
  | { kind: "meeting"; meetingId: string; atMs: number | null }
  | { kind: Exclude<PassageKind, "transcript">; refId: string; subRef: string | null };

export function openMeeting(o: ChatOpeners, meetingId: string, atMs: number | null) {
  if (o.onOpenMeeting) o.onOpenMeeting(meetingId, atMs);
  else window.dispatchEvent(new CustomEvent<OpenDetail>(OPEN_EVENT, { detail: { kind: "meeting", meetingId, atMs } }));
}

export function openItem(o: ChatOpeners, kind: Exclude<PassageKind, "transcript">, refId: string, subRef: string | null) {
  if (o.onOpenItem) o.onOpenItem(kind, refId, subRef);
  else window.dispatchEvent(new CustomEvent<OpenDetail>(OPEN_EVENT, { detail: { kind, refId, subRef } }));
}

export function openCitation(o: ChatOpeners, c: WorkspaceCitation) {
  if (c.kind === "transcript") openMeeting(o, c.ref_id, c.start_ms);
  else openItem(o, c.kind, c.ref_id, c.sub_ref);
}
