import { invoke } from "@tauri-apps/api/core";
import type { DbBackup, DbProblem, DbProblemKind, RetryOpenResult } from "../lib/types";

// The recovery calls and types of this screen, in one place.
export { openDataFolder, restartApp, restoreDatabaseCopy, startWithNewDatabase } from "../lib/ipc";
/**
 * Looks at the file again (the locked case). `{ ok, needs_restart }`: the file opens now but only a restart can use it, or it is still in use.
 * Rejects as "not found" where this build has no such command; `null` from an older build that only reopens.
 */
export const retryOpenDatabase = (): Promise<RetryOpenResult | null> => invoke("retry_open_database");

/** True when a rejection says the command does not exist in this build. */
export const isMissingCommand = (e: unknown): boolean => /not found|unknown command|not registered|no such command|did not find/i.test(e instanceof Error ? e.message : String(e));

export type DatabaseProblemKind = DbProblemKind;
export type DatabaseBackup = DbBackup;
export type DatabaseProblem = DbProblem;

export function copyDate(created_at: number): Date {
  return new Date(created_at < 1e12 ? created_at * 1000 : created_at);
}

/** The file's own name, for "kept aside under its name". */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export const PROBLEM_COPY: Record<DatabaseProblemKind, { title: string; what: string }> = {
  unreadable: { title: "NexQ couldn't open your meetings", what: "The file that holds them couldn't be read." },
  newer: { title: "Your meetings were saved by a newer NexQ", what: "This version is older than the one that last used them, so it leaves them alone." },
  upgrade_failed: { title: "NexQ couldn't finish updating your data", what: "Bringing your meetings up to this version didn't complete." },
  locked: { title: "Your meetings are in use", what: "Another NexQ or program is using the file right now." },
};
