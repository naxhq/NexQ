// The language each side of the meeting is transcribed in, for any window that
// lets people change it (the meeting overlay). Reads and writes the same setting
// as Settings > Audio & Devices: `meetingAudioConfig[side].language`. The store
// persists it, the launcher window picks the change up, and its useAudioConfigSync
// restarts only that side's transcription (the other side and the recording keep
// running); a change of anything else restarts capture.

import { useCallback, useEffect, useRef, useState } from "react";
import { useConfigStore } from "../stores/configStore";
import { useMeetingStore } from "../stores/meetingStore";
import { skipYouStt } from "../lib/audioMode";
import { onCaptureWarning, onSTTConnectionStatus } from "../lib/events";
import { SAME_AS_SHARED_LANGUAGE, sideLanguage, type SideLanguageHint } from "../lib/sttLanguages";
import { languageLabel, sideLanguageProblems, sideNotice, updatePartyConfig } from "../lib/sideLanguage";

export type LanguageSide = "you" | "them";

/** Longest the "restarting" state lasts when the provider reports nothing back. */
export const RESTART_STATE_MS = 6000;

export interface SideLanguageInfo {
  side: LanguageSide;
  /** "You", "Them", or "Room" (the room microphone of an in-person meeting). */
  label: string;
  /** This side's own pick; SAME_AS_SHARED_LANGUAGE ("") follows the shared language. */
  value: string;
  /** The language actually transcribed: the pick, else the shared one. */
  effective: string;
  /** Name of the shared language, which "Default" stands for. */
  sharedLabel: string;
  /** Why the side's provider can't handle its language, or a tip. */
  notice: SideLanguageHint | null;
  /** This side's transcription is reconnecting after a language change (the other side keeps running). */
  restarting: boolean;
}

export interface SideLanguages {
  /** Null in an in-person meeting ("You" isn't transcribed) and before the config loads. */
  you: SideLanguageInfo | null;
  /** Null before the config loads. */
  them: SideLanguageInfo | null;
  /** Sets one side's language ("" for Default). While a meeting runs, only that side's transcription restarts, and it shows as restarting. */
  setLanguage: (side: LanguageSide, value: string) => void;
}

export function useSideLanguages(): SideLanguages {
  const config = useConfigStore((s) => s.meetingAudioConfig);
  const sharedLanguage = useConfigStore((s) => s.sttLanguage);
  const deepgramModel = useConfigStore((s) => s.deepgramConfig.model);
  const whisperModel = useConfigStore((s) => s.activeWhisperModel);
  const parakeetModel = useConfigStore((s) => s.activeModelPerEngine.parakeet_tdt);
  const inPerson = useMeetingStore((s) => skipYouStt(s.audioMode));
  const isRecording = useMeetingStore((s) => s.isRecording);

  const [restarting, setRestarting] = useState<Record<LanguageSide, boolean>>({ you: false, them: false });
  const timers = useRef<Partial<Record<LanguageSide, ReturnType<typeof setTimeout>>>>({});

  const finishRestart = useCallback((side: LanguageSide) => {
    clearTimeout(timers.current[side]);
    delete timers.current[side];
    setRestarting((r) => (r[side] ? { ...r, [side]: false } : r));
  }, []);

  // A side is back when its provider says it is connected (or failed), or capture warns.
  const anyRestarting = restarting.you || restarting.them;
  useEffect(() => {
    if (!anyRestarting) return;
    const offs: Array<() => void> = [];
    let gone = false;
    const keep = (off: () => void) => (gone ? off() : offs.push(off));
    onSTTConnectionStatus((e) => {
      // In-person capture names the provider's party "Room": that is the Them side.
      const raw = e.party.toLowerCase();
      const party = raw === "room" ? "them" : raw;
      if (e.status !== "connected" && e.status !== "error") return;
      if (party === "you" || party === "them") finishRestart(party);
    }).then(keep, () => {});
    onCaptureWarning(() => {
      finishRestart("you");
      finishRestart("them");
    }).then(keep, () => {});
    return () => {
      gone = true;
      offs.forEach((off) => off());
    };
  }, [anyRestarting, finishRestart]);

  // A meeting that ends leaves nothing to restart.
  useEffect(() => {
    if (!isRecording) {
      finishRestart("you");
      finishRestart("them");
    }
  }, [isRecording, finishRestart]);

  useEffect(() => () => Object.values(timers.current).forEach((t) => clearTimeout(t)), []);

  const setLanguage = useCallback(
    (side: LanguageSide, value: string) => {
      const state = useConfigStore.getState();
      const current = state.meetingAudioConfig;
      if (!current || (current[side].language ?? SAME_AS_SHARED_LANGUAGE) === value) return;
      state.setMeetingAudioConfig(updatePartyConfig(current, side, { language: value || undefined }));
      if (useMeetingStore.getState().isRecording) {
        setRestarting((r) => ({ ...r, [side]: true }));
        clearTimeout(timers.current[side]);
        timers.current[side] = setTimeout(() => finishRestart(side), RESTART_STATE_MS);
      }
    },
    [finishRestart],
  );

  if (!config) return { you: null, them: null, setLanguage };

  const models = { deepgram: deepgramModel, whisperCpp: whisperModel, parakeet: parakeetModel };
  const sharedLabel = languageLabel(sharedLanguage);
  const info = (side: LanguageSide, label: string): SideLanguageInfo => {
    const party = config[side];
    const effective = sideLanguage(party, sharedLanguage);
    return {
      side,
      label,
      value: party.language ?? SAME_AS_SHARED_LANGUAGE,
      effective,
      sharedLabel,
      notice: sideNotice(sideLanguageProblems(party, effective, models, label)),
      restarting: restarting[side],
    };
  };

  return {
    you: inPerson ? null : info("you", "You"),
    them: info("them", inPerson ? "Room" : "Them"),
    setLanguage,
  };
}
