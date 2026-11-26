import type { McpServer, NotesFolder, PersonalSourcesConfig } from "../lib/types";
import { useSourcesStore } from "../stores/sourcesStore";
import { useMeetingStore } from "../stores/meetingStore";
import { defaultWorkspaceOf, useWorkspaceStore } from "../stores/workspaceStore";
import { removeLibraryItem, type SourcesFiling } from "../lib/ipc";

// Small edits of the saved config, always made on the latest copy (a Check or a
// save can finish long after the user clicked), then saved and given to the backend.

function update(edit: (c: PersonalSourcesConfig) => PersonalSourcesConfig, filing?: SourcesFiling): Promise<void> {
  return useSourcesStore.getState().setConfig(edit(current()), filing);
}

/**
 * The workspace an explicit add belongs to: the open one in the launcher, the
 * default one from Settings (which has no open workspace of its own).
 */
export function explicitWorkspaceId(): string {
  const ws = useWorkspaceStore.getState();
  const inSettings = useMeetingStore.getState().currentView === "settings";
  return inSettings ? defaultWorkspaceOf(ws.workspaces).id : ws.openId;
}

/** A folder or server left the saved sources: it leaves every workspace. A failure is only logged (it shows as missing). */
function leaveLibrary(kind: "folder" | "server", id: string): void {
  removeLibraryItem(kind, id).catch((e) => console.warn("[sources] remove_library_item failed:", e));
}

function current(): PersonalSourcesConfig {
  return useSourcesStore.getState().config;
}

/**
 * Add servers the backend has already taken in (they come back with no secret
 * values). A server exists once: when the backend found that one it was given
 * is already saved, it hands that one back, and it is only linked into the
 * workspace. Resolves with those servers that were already in Settings.
 */
export async function addMcpServers(servers: McpServer[], workspaceId: string = explicitWorkspaceId()): Promise<McpServer[]> {
  let already: McpServer[] = [];
  await update((c) => {
    const known = new Set(c.mcp_servers.map((s) => s.id));
    already = servers.filter((s) => known.has(s.id));
    return { ...c, mcp_servers: [...c.mcp_servers, ...servers.filter((s) => !known.has(s.id))] };
  }, { workspace_id: workspaceId, items: servers.map((s) => ({ kind: "server" as const, ref_id: s.id })) });
  return already;
}

/** What the person is told when what they added was already in Settings. */
export const ALREADY_IN_SETTINGS = "Already in Settings, added to this workspace";

/** A folder path as the system compares it: slashes unified, no trailing slash, no case. Same rule as the backend's. */
export function normalizedPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return normalizedPath(a) === normalizedPath(b);
}

/** Swap in a server's new state (after an edit or a Check). A server removed meanwhile stays removed. */
export function replaceMcpServer(server: McpServer): Promise<void> {
  return update((c) => ({
    ...c,
    mcp_servers: c.mcp_servers.map((s) => (s.id === server.id ? server : s)),
  }));
}

/** What starts a server: a change here makes an older Check's answer about something else. */
function launchSignature(s: McpServer): string {
  return stableJson([s.transport, s.env]);
}

/**
 * JSON with object keys sorted and missing values read as null: a config read
 * back from disk has its keys in another order than the backend's answer.
 */
function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Take a Check's answer into the latest copy of the server: only the tool list
 * (new tools arrive with the backend's default) and the status. The switches the
 * user flipped while it ran (`enabled`, each tool's `allowed`) stay. A failed
 * Check keeps the tools. The answer is dropped when the server is gone or what
 * starts it (command, address, variables) changed meanwhile.
 */
export function applyCheckResult(result: McpServer): Promise<void> {
  return patchMcpServer(result.id, (now) => {
    if (launchSignature(now) !== launchSignature(result)) return now;
    if (!result.last_check?.ok) return { ...now, last_check: result.last_check };
    const allowedNow = new Map(now.tools.map((t) => [t.full_name, t.allowed]));
    const tools = result.tools.map((t) => ({ ...t, allowed: allowedNow.get(t.full_name) ?? t.allowed }));
    return { ...now, tools, last_check: result.last_check };
  });
}

export function patchMcpServer(id: string, patch: (s: McpServer) => McpServer): Promise<void> {
  return update((c) => ({ ...c, mcp_servers: c.mcp_servers.map((s) => (s.id === id ? patch(s) : s)) }));
}

export async function removeMcpServer(id: string): Promise<void> {
  await update((c) => ({ ...c, mcp_servers: c.mcp_servers.filter((s) => s.id !== id) }));
  leaveLibrary("server", id);
}

/**
 * Remove a server and save that for good first: rejects, and the server stays,
 * when the save fails. `afterSave` (forgetting its secrets) runs only then,
 * before the backend is told.
 */
export async function removeMcpServerDurably(id: string, afterSave?: () => Promise<void>): Promise<void> {
  const c = current();
  await useSourcesStore
    .getState()
    .setConfigDurably({ ...c, mcp_servers: c.mcp_servers.filter((s) => s.id !== id) }, afterSave);
  leaveLibrary("server", id);
}

/** A folder exists once too: one at the same path is only linked into the workspace. */
export function addNotesFolder(folder: NotesFolder, workspaceId: string = explicitWorkspaceId()): Promise<void> {
  const same = current().notes_folders.find((f) => samePath(f.path, folder.path));
  if (same) return update((c) => c, { workspace_id: workspaceId, items: [{ kind: "folder", ref_id: same.id }] });
  return update((c) => ({ ...c, notes_folders: [...c.notes_folders, folder] }), { workspace_id: workspaceId, items: [{ kind: "folder", ref_id: folder.id }] });
}

export function patchNotesFolder(id: string, patch: Partial<NotesFolder>): Promise<void> {
  return update((c) => ({
    ...c,
    notes_folders: c.notes_folders.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  }));
}

export async function removeNotesFolder(id: string): Promise<void> {
  await update((c) => ({ ...c, notes_folders: c.notes_folders.filter((f) => f.id !== id) }));
  leaveLibrary("folder", id);
}

export function markMcpNoticeSeen(): Promise<void> {
  return update((c) => ({ ...c, mcp_notice_seen: true }));
}

/** The last part of a path, for a folder's first label. */
export function folderNameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A readable reason out of whatever a failed command rejected with. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}
