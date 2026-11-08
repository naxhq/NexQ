// Discord-style updates: a single owner (the launcher window) checks 10 s after
// launch and every 4 h, downloads silently when automatic updates are on, and
// the footer pill opens the "what's new" dialog that installs it. Rust installs
// a downloaded update on quit (see updater_commands::on_exit_requested).
//
// The checks continue after a download, and opening the dialog checks again, so
// a newer release replaces the waiting one and people land on the latest version
// in one step instead of going through each release.
//
// The action functions below work from any window (Settings -> About can open
// in the overlay); only the check loop is launcher-only. Preference changes are
// broadcast so every window's store stays in sync.

import { useEffect } from "react";
import { load } from "@tauri-apps/plugin-store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useUpdaterStore } from "../stores/updaterStore";
import { useMeetingStore } from "../stores/meetingStore";
import { showToast } from "../stores/toastStore";
import { meetingEndRoute } from "../lib/windows";
import { compareVersions } from "../lib/changelog";
import {
  checkForUpdate,
  downloadUpdate,
  getPendingUpdate,
  installUpdateNow,
} from "../lib/ipc";
import {
  emitStopMeeting,
  emitUpdaterPrefsChanged,
  onWindowMeetingEnded,
  onUpdateDownloadFailed,
  onUpdateDownloadProgress,
  onUpdateDownloaded,
  onUpdaterPrefsChanged,
} from "../lib/events";

// Same keys are read by Rust at quit time — keep in sync with updater_commands.rs.
const STORE_NAME = "nexq-settings.json";
const SKIPPED_VERSION_KEY = "skipped_version";
const AUTO_UPDATE_KEY = "auto_update";

const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Windows that each run endMeetingFlow and hold part of the meeting's data. */
const MEETING_WINDOWS = ["launcher", "overlay"];
export const MEETING_END_TIMEOUT_MS = 60_000;

/** Never hold up an install for longer than this waiting on GitHub. */
export const UPDATE_CHECK_LIMIT_MS = 8_000;
export const UPDATE_DOWNLOAD_LIMIT_MS = 120_000;

export const RELEASES_URL = "https://github.com/naxhq/NexQ/releases";

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

function settingsStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} });
}

async function persist(key: string, value: unknown): Promise<void> {
  try {
    const store = await settingsStore();
    if (value === undefined) await store.delete(key);
    else await store.set(key, value);
  } catch (err) {
    console.warn(`[updater] Failed to persist ${key}:`, err);
  }
}

async function broadcastPrefs(): Promise<void> {
  const { autoUpdate, skippedVersion } = useUpdaterStore.getState();
  try {
    await emitUpdaterPrefsChanged({ autoUpdate, skippedVersion: skippedVersion ?? null });
  } catch (err) {
    console.warn("[updater] Failed to broadcast preferences:", err);
  }
}

/** Load persisted preferences and any update already downloaded by Rust. */
export async function hydrateUpdater(): Promise<void> {
  const updater = useUpdaterStore.getState();
  try {
    const store = await settingsStore();
    const skipped = await store.get<string>(SKIPPED_VERSION_KEY);
    const auto = await store.get<boolean>(AUTO_UPDATE_KEY);
    updater.setSkippedVersion(skipped ?? undefined);
    if (typeof auto === "boolean") updater.setAutoUpdate(auto);
  } catch (err) {
    console.warn("[updater] Failed to load preferences:", err);
  }

  try {
    const pending = await getPendingUpdate();
    // setReady ignores a skipped version
    if (pending) updater.setReady(pending.version, pending.body);
  } catch (err) {
    console.warn("[updater] Failed to read pending update:", err);
  }
}

/**
 * Check for an update; download it when automatic updates are on.
 * Automatic checks ignore a skipped version, manual checks don't (and a
 * download after a manual check counts as explicit).
 */
export async function checkForUpdates(opts?: { manual?: boolean }): Promise<void> {
  const { phase, startCheck } = useUpdaterStore.getState();
  if (phase === "checking" || phase === "downloading") return;
  if (phase === "ready") {
    await refreshReadyUpdate();
    return;
  }

  startCheck();
  let update;
  try {
    const found = await checkForUpdate();
    update = useUpdaterStore.getState().finishCheck(found, opts);
  } catch (err) {
    useUpdaterStore.getState().failCheck(errorMessage(err));
    return;
  }

  if (update && useUpdaterStore.getState().autoUpdate) {
    await downloadUpdateNow({ explicit: opts?.manual });
  }
}

function withinLimit<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out")), limitMs);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * With an update already downloaded, look for a newer one and swap it in. The
 * waiting update stays ready throughout and is kept if anything goes wrong.
 * `explicit` means the user is about to install, which counts even with
 * automatic updates off. A skipped version is never fetched.
 */
export async function refreshReadyUpdate(opts?: { explicit?: boolean }): Promise<void> {
  const { phase, refresh, setRefresh } = useUpdaterStore.getState();
  if (phase !== "ready" || refresh !== "idle") return;

  setRefresh("checking");
  try {
    const found = await withinLimit(checkForUpdate(), UPDATE_CHECK_LIMIT_MS);
    const { version, skippedVersion, autoUpdate } = useUpdaterStore.getState();
    if (!found || !version || compareVersions(found.version, version) <= 0) return;
    if (found.version === skippedVersion) return;
    if (!autoUpdate && !opts?.explicit) return;

    setRefresh("downloading", found.version);
    const info = await withinLimit(downloadUpdate(), UPDATE_DOWNLOAD_LIMIT_MS);
    useUpdaterStore.getState().setReady(info.version, info.body);
  } catch (err) {
    console.warn("[updater] Keeping the downloaded update:", err);
  } finally {
    useUpdaterStore.getState().setRefresh("idle");
  }
}

/** Show what's in the update, and make sure it's the newest one. */
export function openUpdateDialog(): void {
  useUpdaterStore.getState().setDialogOpen(true);
  void refreshReadyUpdate({ explicit: true });
}

/**
 * Download the available update in the background (no install). An explicit
 * download of a skipped version clears the skip, so Rust's install-on-quit
 * agrees with what the user chose.
 */
export async function downloadUpdateNow(opts?: { explicit?: boolean }): Promise<void> {
  const { phase, version, skippedVersion, startDownload } = useUpdaterStore.getState();
  if (phase === "downloading" || phase === "ready") return;

  if (opts?.explicit && version && version === skippedVersion) {
    useUpdaterStore.getState().setSkippedVersion(undefined);
    await persist(SKIPPED_VERSION_KEY, undefined);
    await broadcastPrefs();
  }

  startDownload();
  try {
    const info = await downloadUpdate();
    useUpdaterStore.getState().setReady(info.version, info.body, opts);
  } catch (err) {
    useUpdaterStore.getState().failDownload(errorMessage(err));
  }
}

/**
 * End the meeting through the cross-window stop path (the tray's Stop): both
 * windows run endMeetingFlow and save the data they hold. Resolves true once
 * both report done, false on timeout or error.
 */
export async function endMeetingInAllWindows(
  timeoutMs: number = MEETING_END_TIMEOUT_MS,
): Promise<boolean> {
  const waiting = new Set(MEETING_WINDOWS);
  let finish: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    finish = resolve;
  });

  let unlisten: UnlistenFn | undefined;
  const timer = setTimeout(() => finish(false), timeoutMs);
  try {
    unlisten = await onWindowMeetingEnded((e) => {
      waiting.delete(e.window);
      if (waiting.size === 0) finish(true);
    });
    await emitStopMeeting();
    return await done;
  } catch (err) {
    console.error("[updater] Failed to end the meeting:", err);
    return false;
  } finally {
    clearTimeout(timer);
    unlisten?.();
  }
}

/**
 * End the running meeting from this window. When the overlay took the
 * meeting and this is another window, it ends through every window so the
 * overlay saves the data only it holds; resolves once both are done (false
 * on timeout). Otherwise this window ends it by itself.
 */
export async function endMeetingFromThisWindow(): Promise<boolean> {
  const state = useMeetingStore.getState();
  const meeting = state.activeMeeting;
  if (!meeting) return true;
  let label = "";
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    /* not running in Tauri */
  }
  if (meetingEndRoute(label, state.overlayMeetingId === meeting.id) === "all_windows") {
    return endMeetingInAllWindows();
  }
  await state.endMeetingFlow();
  return true;
}

/**
 * Install the downloaded update now; NexQ exits and relaunches on the new
 * version. If a meeting is running, confirm first and end it in every window
 * before installing. Never installs if the meeting didn't end cleanly.
 */
export async function restartToUpdate(): Promise<void> {
  if (useMeetingStore.getState().activeMeeting) {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    const ok = await confirm(
      "Your meeting will be saved, then NexQ restarts on the new version.",
      {
        title: "End meeting and update?",
        kind: "warning",
        okLabel: "End & update",
        cancelLabel: "Cancel",
      },
    );
    if (!ok) return;

    if (!(await endMeetingInAllWindows())) {
      showToast("Couldn't finish saving the meeting. Update postponed.", "error");
      return;
    }
  }

  try {
    await installUpdateNow();
  } catch (err) {
    showToast(`Update not installed: ${errorMessage(err)}`, "error");
  }
}

export async function setAutoUpdate(enabled: boolean): Promise<void> {
  useUpdaterStore.getState().setAutoUpdate(enabled);
  await persist(AUTO_UPDATE_KEY, enabled);
  await broadcastPrefs();
}

/**
 * Skip a version: automatic checks stop offering it, it never becomes ready on
 * its own, and Rust won't install it on quit. A manual check still finds it.
 */
export async function skipVersion(version: string): Promise<void> {
  useUpdaterStore.getState().skip(version);
  await persist(SKIPPED_VERSION_KEY, version);
  await broadcastPrefs();
}

/** Runs the update loop. Mount once at the app root; active only in the launcher window. */
export function useUpdater(): void {
  useEffect(() => {
    let label = "";
    try {
      label = getCurrentWebviewWindow().label;
    } catch {
      label = "";
    }
    const isLauncher = label === "launcher";

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const keep = (fn: UnlistenFn) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };

    // Every window: keep preferences in sync (About can open in either window).
    onUpdaterPrefsChanged((prefs) => {
      const updater = useUpdaterStore.getState();
      updater.setAutoUpdate(prefs.autoUpdate);
      if (prefs.skippedVersion) updater.skip(prefs.skippedVersion);
      else updater.setSkippedVersion(undefined);
    }).then(keep);

    if (!isLauncher) {
      return () => {
        disposed = true;
        unlisteners.forEach((fn) => fn());
      };
    }

    hydrateUpdater();

    onUpdateDownloadProgress((e) => {
      useUpdaterStore.getState().addProgress(e.chunk_length, e.content_length);
    }).then(keep);

    // Downloads may be started from any window (e.g. About in the overlay).
    onUpdateDownloaded((info) => {
      useUpdaterStore.getState().setReady(info.version, info.body);
    }).then(keep);

    onUpdateDownloadFailed((e) => {
      if (useUpdaterStore.getState().phase === "downloading") {
        useUpdaterStore.getState().failDownload(e.message);
      }
    }).then(keep);

    const startupTimer = setTimeout(() => checkForUpdates(), STARTUP_DELAY_MS);
    const intervalId = setInterval(() => checkForUpdates(), CHECK_INTERVAL_MS);

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      clearTimeout(startupTimer);
      clearInterval(intervalId);
    };
  }, []);
}
