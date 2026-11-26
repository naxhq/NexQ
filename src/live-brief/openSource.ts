import type { BriefSource } from "../lib/types";
import { showLauncherWindow } from "../lib/windows";

/** One shared event for "open this meeting, document or file". */
export const WORKSPACE_OPEN_EVENT = "nexq:workspace_open";

export interface WorkspaceOpenDetail {
  kind: BriefSource["kind"];
  ref_id: string;
  sub_ref: string | null;
  start_ms: number | null;
}

/** On an explicit click: tell this window and the launcher, then show the launcher. */
export async function openBriefSource(src: BriefSource): Promise<void> {
  const detail: WorkspaceOpenDetail = { kind: src.kind, ref_id: src.ref_id, sub_ref: src.sub_ref, start_ms: src.start_ms };
  window.dispatchEvent(new CustomEvent(WORKSPACE_OPEN_EVENT, { detail }));
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(WORKSPACE_OPEN_EVENT, detail);
    await showLauncherWindow();
  } catch {
    /* Not in the app shell (tests): the same-window event is enough. */
  }
}
