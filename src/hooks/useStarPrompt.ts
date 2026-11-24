// When the one-time star card may appear, and remembering that it did.
//
// Trigger: the launcher hears that a meeting ended (both windows send the
// event, and a demo sends it too), waits a moment, reads the saved meetings
// and asks starPrompt.ts whether this was the user's fifth finished one just
// now. If so the card is "armed" and shows as soon as nothing else has the
// screen. A meeting or demo starting drops it at once. A card that was on
// screen and not answered comes back after the next meeting in the same
// session; a card that was never seen is simply offered again by the trigger.
//
// Persistence: `starPromptShown` in nexq-settings.json, written once the card
// has been on screen for 2 s or the moment the user acts. If the setting
// can't be read the card is not shown (never nag). Nothing leaves the machine.

import { useCallback, useEffect, useRef, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useMeetingStore } from "../stores/meetingStore";
import { useConfigStore } from "../stores/configStore";
import { useDemoStore } from "../demo/demoStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { listMeetings } from "../lib/ipc";
import { onWindowMeetingEnded } from "../lib/events";
import {
  MEETINGS_TO_READ,
  SHOWN_AFTER_MS,
  STAR_PROMPT_SHOWN_KEY,
  TRIGGER_DELAY_MS,
  shouldOfferStarPrompt,
  starPromptWaiting,
} from "../lib/starPrompt";

const STORE_NAME = "nexq-settings.json";

function settingsStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} });
}

/** True/false, or a throw when the setting can't be read. A missing key is "not shown". */
async function readShown(): Promise<boolean> {
  const store = await settingsStore();
  return (await store.get<boolean>(STAR_PROMPT_SHOWN_KEY)) === true;
}

async function writeShown(): Promise<void> {
  try {
    const store = await settingsStore();
    await store.set(STAR_PROMPT_SHOWN_KEY, true);
  } catch (err) {
    console.warn("[starPrompt] Could not save that the card was shown:", err);
  }
}

function isLauncherWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === "launcher";
  } catch {
    return false;
  }
}

export interface StarPromptControls {
  visible: boolean;
  /** The user acted: remember it for good (the card may stay up, e.g. to say thanks). */
  acknowledge: () => void;
  /** Take the card away for good. */
  close: () => void;
}

export function useStarPrompt(): StarPromptControls {
  const [armed, setArmedState] = useState(false);
  const armedRef = useRef(false);
  const setArmed = useCallback((value: boolean) => {
    armedRef.current = value;
    setArmedState(value);
  }, []);
  // Was on screen and not answered: the saved flag must not stop its return after the next meeting.
  const unansweredRef = useRef(false);
  const acknowledgedRef = useRef(false);

  const meetingActive = useMeetingStore((s) => !!s.activeMeeting || s.meetingStarting);
  const demoActive = useDemoStore((s) => s.isDemoActive);
  const onLauncher = useMeetingStore((s) => s.currentView === "launcher" && !s.settingsOpen);
  const wizard = useConfigStore((s) => !s.firstRunCompleted);
  const updateDialogOpen = useUpdaterStore((s) => s.dialogOpen);
  const updateToastShowing = useUpdaterStore((s) => s.readyToastVisible);
  const installing = useUpdaterStore((s) => s.installing);

  const busy = meetingActive || demoActive;
  const waiting = starPromptWaiting({
    wizard,
    notOnLauncher: !onLauncher,
    updateDialogOpen,
    updateToastShowing,
    installing,
  });
  const visible = armed && !busy && !waiting;

  // A meeting or demo started: drop the card at once. The next meeting's end offers it again.
  useEffect(() => {
    if (busy && armedRef.current) setArmed(false);
  }, [busy, setArmed]);

  // Once the user has acted, a card that gets covered is finished, not parked.
  useEffect(() => {
    if (acknowledgedRef.current && armedRef.current && waiting) setArmed(false);
  }, [waiting, setArmed]);

  // On screen long enough to count as shown.
  useEffect(() => {
    if (!visible) return;
    unansweredRef.current = true;
    const timer = setTimeout(() => void writeShown(), SHOWN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  // The trigger.
  useEffect(() => {
    if (!isLauncherWindow()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: UnlistenFn | undefined;

    async function evaluate() {
      if (armedRef.current) return;
      let alreadyShown: boolean;
      let meetings;
      try {
        alreadyShown = await readShown();
        meetings = await listMeetings(MEETINGS_TO_READ, 0);
      } catch (err) {
        console.warn("[starPrompt] Not showing the card, could not read the data:", err);
        return;
      }
      if (disposed || armedRef.current) return;

      // Read the stores now: they may have changed while the data loaded.
      const meeting = useMeetingStore.getState();
      const offer = shouldOfferStarPrompt({
        alreadyShown: alreadyShown && !unansweredRef.current,
        meetings,
        nowMs: Date.now(),
        demoActive: useDemoStore.getState().isDemoActive,
        hasActiveMeeting: !!meeting.activeMeeting,
        meetingStarting: meeting.meetingStarting,
      });
      if (offer) {
        acknowledgedRef.current = false;
        setArmed(true);
      }
    }

    onWindowMeetingEnded(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void evaluate(), TRIGGER_DELAY_MS);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.warn("[starPrompt] Could not listen for finished meetings:", err));

    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [setArmed]);

  const acknowledge = useCallback(() => {
    acknowledgedRef.current = true;
    unansweredRef.current = false;
    void writeShown();
  }, []);

  const close = useCallback(() => {
    acknowledge();
    setArmed(false);
  }, [acknowledge, setArmed]);

  return { visible, acknowledge, close };
}
