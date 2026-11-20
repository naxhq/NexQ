import type { McpServer, NotesFolder, PersonalSourcesConfig } from "../lib/types";
import { useSourcesStore } from "../stores/sourcesStore";

// Small edits of the saved config, always made on the latest copy (a Check or a
// save can finish long after the user clicked), then saved and given to the backend.

function update(edit: (c: PersonalSourcesConfig) => PersonalSourcesConfig): Promise<void> {
  return useSourcesStore.getState().setConfig(edit(current()));
}

function current(): PersonalSourcesConfig {
  return useSourcesStore.getState().config;
}

/** Add servers the backend has already taken in (they come back with no secret values). */
export function addMcpServers(servers: McpServer[]): Promise<void> {
  return update((c) => {
    const known = new Set(c.mcp_servers.map((s) => s.id));
    return { ...c, mcp_servers: [...c.mcp_servers, ...servers.filter((s) => !known.has(s.id))] };
  });
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

export function removeMcpServer(id: string): Promise<void> {
  return update((c) => ({ ...c, mcp_servers: c.mcp_servers.filter((s) => s.id !== id) }));
}

/**
 * Remove a server and save that for good first: rejects, and the server stays,
 * when the save fails. `afterSave` (forgetting its secrets) runs only then,
 * before the backend is told.
 */
export function removeMcpServerDurably(id: string, afterSave?: () => Promise<void>): Promise<void> {
  const c = current();
  return useSourcesStore
    .getState()
    .setConfigDurably({ ...c, mcp_servers: c.mcp_servers.filter((s) => s.id !== id) }, afterSave);
}

export function addNotesFolder(folder: NotesFolder): Promise<void> {
  return update((c) => ({ ...c, notes_folders: [...c.notes_folders, folder] }));
}

export function patchNotesFolder(id: string, patch: Partial<NotesFolder>): Promise<void> {
  return update((c) => ({
    ...c,
    notes_folders: c.notes_folders.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  }));
}

export function removeNotesFolder(id: string): Promise<void> {
  return update((c) => ({ ...c, notes_folders: c.notes_folders.filter((f) => f.id !== id) }));
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
