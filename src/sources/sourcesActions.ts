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

export function patchMcpServer(id: string, patch: (s: McpServer) => McpServer): Promise<void> {
  return update((c) => ({ ...c, mcp_servers: c.mcp_servers.map((s) => (s.id === id ? patch(s) : s)) }));
}

export function removeMcpServer(id: string): Promise<void> {
  return update((c) => ({ ...c, mcp_servers: c.mcp_servers.filter((s) => s.id !== id) }));
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
