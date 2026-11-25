import { deleteMeeting, deleteWorkspaceMeetings, listWorkspaceMeetings } from "../lib/ipc";

export interface DeleteAllResult {
  deleted: number;
  failed: number;
  /** How many the workspace said it had when we started (the count the person was shown). */
  expected: number;
}

const PAGE = 200;
/** Never loops for ever, whatever the backend answers. */
const MAX_PAGES = 500;

const isMissingCommand = (e: unknown) => /not found|unknown command|not registered|no such command|did not find/i.test(e instanceof Error ? e.message : String(e));

/** Every meeting id of a workspace: page until `total` is reached (or a page comes back empty). */
export async function collectWorkspaceMeetingIds(workspaceId: string): Promise<{ ids: string[]; total: number }> {
  const ids: string[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await listWorkspaceMeetings(workspaceId, null, PAGE, ids.length);
    const got = Array.isArray(r?.meetings) ? r.meetings : [];
    total = r?.total ?? total;
    for (const m of got) if (!ids.includes(m.id)) ids.push(m.id);
    if (got.length === 0 || ids.length >= total) break;
  }
  return { ids, total };
}

async function deleteEach(ids: string[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await deleteMeeting(id);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}

/** Deletes meetings by id and says exactly how many went and how many did not. */
export async function deleteMeetingsById(ids: string[]): Promise<DeleteAllResult> {
  const r = await deleteEach(ids);
  return { ...r, expected: ids.length };
}

/**
 * Deletes every meeting of a workspace. Uses the backend's one call when it
 * exists; otherwise pages through the list until the total is reached and
 * deletes one by one. A list shorter than the total counts as failed, never as done.
 */
export async function deleteAllInWorkspace(workspaceId: string, expected: number): Promise<DeleteAllResult> {
  try {
    const r = await deleteWorkspaceMeetings(workspaceId);
    // Anything that is not the agreed answer is no answer: use the paging path.
    if (typeof r?.deleted !== "number" || !Array.isArray(r?.failed)) throw new Error("not found");
    return { deleted: r.deleted, failed: r.failed.length, expected: Math.max(expected, r.deleted + r.failed.length) };
  } catch (e) {
    if (!isMissingCommand(e)) throw e;
  }
  const { ids, total } = await collectWorkspaceMeetingIds(workspaceId);
  const r = await deleteEach(ids);
  const missed = Math.max(0, total - ids.length);
  return { deleted: r.deleted, failed: r.failed + missed, expected: Math.max(expected, total) };
}

/** One line for the person: exact numbers, never "all deleted" when some were not. */
export function describeDeleteAll(r: DeleteAllResult): string {
  const n = (c: number) => `${c} ${c === 1 ? "meeting" : "meetings"}`;
  if (r.failed === 0 && r.deleted > 0) return `Deleted ${n(r.deleted)}`;
  if (r.deleted === 0 && r.failed === 0) return "There was nothing to delete";
  return `Deleted ${r.deleted} of ${n(Math.max(r.expected, r.deleted + r.failed))}. ${r.failed} could not be deleted.`;
}
