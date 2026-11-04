// Resets every meeting-scoped Zustand store.
//
// Zustand stores are module singletons *per webview*, and NexQ runs two windows
// (launcher + overlay). Both windows must call this when a new meeting starts,
// otherwise the overlay keeps rendering the previous meeting's transcript, AI
// responses, speakers, bookmarks, etc.
//
// Anything that is per-meeting (not user config) belongs here. The mock for
// `meetingStore` itself is handled by the callers (they set activeMeeting etc.).

import type { AudioMode } from "../lib/types";
import { useConfigStore } from "./configStore";
import { useSpeakerStore } from "./speakerStore";

export async function resetMeetingScopedStores(): Promise<void> {
  const [
    { useTranscriptStore },
    { useStreamStore },
    { useDevLogStore },
    { useCallLogStore },
    { useBookmarkStore },
    { useActionItemStore },
    { useTopicSectionStore },
    { useSpeakerStore },
    { useTranslationStore },
    { useAudioPlayerStore },
    { useQuestionStore },
  ] = await Promise.all([
    import("./transcriptStore"),
    import("./streamStore"),
    import("./devLogStore"),
    import("./callLogStore"),
    import("./bookmarkStore"),
    import("./actionItemStore"),
    import("./topicSectionStore"),
    import("./speakerStore"),
    import("./translationStore"),
    import("./audioPlayerStore"),
    import("./questionStore"),
  ]);

  // Transcript + live streaming AI response
  useTranscriptStore.getState().clearSegments();
  useStreamStore.getState().resetForMeeting();

  // Meeting artifacts / panels
  useDevLogStore.getState().clear();
  useCallLogStore.getState().clearAll();
  useCallLogStore.getState().setOpen(false);
  useBookmarkStore.getState().clearBookmarks();
  useActionItemStore.getState().clearItems();
  useTopicSectionStore.getState().clearSections();
  useQuestionStore.getState().clear();

  // Speaker identity + stats
  useSpeakerStore.getState().reset();

  // Per-segment translations + any recording being replayed
  useTranslationStore.getState().clearTranslations();
  useAudioPlayerStore.getState().reset();
}

/**
 * Set up the speaker store for a new meeting: You/Them online; in person,
 * diarized speakers when the room's STT separates them, else a single Room.
 * Returns false when in-person speech can't be told apart.
 */
export function initMeetingSpeakers(mode: AudioMode): boolean {
  if (mode === "online") {
    useSpeakerStore.getState().initForOnline();
    return true;
  }
  const config = useConfigStore.getState();
  const provider = config.meetingAudioConfig?.you?.stt_provider ?? config.sttProvider;
  // Deepgram's Flux models detect turns but don't tell speakers apart.
  const fluxRoom = provider === "deepgram" && config.deepgramConfig.model.startsWith("flux-");
  const hasDiarization =
    config.diarizationEnabled && ["deepgram", "azure_speech"].includes(provider) && !fluxRoom;
  useSpeakerStore.getState().initForInPerson(hasDiarization);
  return hasDiarization;
}
