// ============================================================================
// NexQ Events — Typed listen() wrappers for all IPC events
// ============================================================================

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { NOTES_UPDATE_EVENT } from "./hotkeys";
import type {
  BriefSettings, BriefSheetEvent, MemorySettings, BriefState, NotetakerSettings, MemoryChangedEvent, NotetakerDocEvent, NotetakerState,
  WorkspaceChatActivityEvent, WorkspaceChatApprovalEvent, WorkspaceChatApprovalClosedEvent, WorkspaceChatApprovalRefusedEvent, WorkspaceChatContextEvent, WorkspaceChatEndEvent,
  WorkspaceChatErrorEvent, WorkspaceChatStartEvent, WorkspaceChatTokenEvent, WorkspaceIndexProgressEvent,
  WorkspacesChangedEvent,
  DbIntegrityFinding,
} from "./types";
import type {
  AIScenario,
  MeetingPromptInfo,
  AgentSessionStatus,
  AgentFallbackEvent,
  AudioCaptureStatus,
  AudioLevelEvent,
  BatchTranslationProgress,
  ModelDownloadProgress,
  OllamaPullProgressEvent,
  QuestionDetectedEvent,
  RagIndexProgressEvent,
  StreamActivityEvent,
  StreamEndEvent,
  StreamErrorEvent,
  StreamSourcesEvent,
  StreamStartEvent,
  StreamThinkingEvent,
  StreamTokenEvent,
  TranscriptIndexedEvent,
  TranscriptUpdateEvent,
  TranslationResult,
  UpdateDownloadProgress,
  UpdateInfo,
  UpdateDownloadFailed,
  UpdaterPrefsChangedEvent,
  WindowMeetingEndedEvent,
  OverlayMeetingReadyEvent,
} from "./types";

// == TRANSCRIPT EVENTS ==

export function onTranscriptUpdate(
  handler: (event: TranscriptUpdateEvent) => void
): Promise<UnlistenFn> {
  return listen<TranscriptUpdateEvent>("transcript_update", (e) =>
    handler(e.payload)
  );
}

export function onTranscriptFinal(
  handler: (event: TranscriptUpdateEvent) => void
): Promise<UnlistenFn> {
  return listen<TranscriptUpdateEvent>("transcript_final", (e) =>
    handler(e.payload)
  );
}

// == LLM STREAM EVENTS ==

export function onStreamStart(
  handler: (event: StreamStartEvent) => void
): Promise<UnlistenFn> {
  return listen<StreamStartEvent>("llm_stream_start", (e) =>
    handler(e.payload)
  );
}

export function onStreamToken(
  handler: (event: StreamTokenEvent) => void
): Promise<UnlistenFn> {
  return listen<StreamTokenEvent>("llm_stream_token", (e) =>
    handler(e.payload)
  );
}

export function onStreamEnd(
  handler: (event: StreamEndEvent) => void
): Promise<UnlistenFn> {
  return listen<StreamEndEvent>("llm_stream_end", (e) => handler(e.payload));
}

/** The model started thinking before its first words (once per request). */
export function onStreamThinking(
  handler: (event: StreamThinkingEvent) => void
): Promise<UnlistenFn> {
  return listen<StreamThinkingEvent>("llm_stream_thinking", (e) =>
    handler(e.payload)
  );
}

/** A line about the sources an answer is using, or why they were not (`llm_stream_activity`). */
export function onStreamActivity(
  handler: (event: StreamActivityEvent) => void
): Promise<UnlistenFn> {
  return listen<StreamActivityEvent>("llm_stream_activity", (e) =>
    handler(e.payload)
  );
}

export function onStreamSources(
  handler: (event: StreamSourcesEvent) => void
): Promise<UnlistenFn> {
  return listen<StreamSourcesEvent>("llm_stream_sources", (e) =>
    handler(e.payload)
  );
}

export function onStreamError(
  handler: (event: StreamErrorEvent) => void
): Promise<UnlistenFn> {
  return listen<StreamErrorEvent>("llm_stream_error", (e) =>
    handler(e.payload)
  );
}

// == QUESTION DETECTION EVENTS ==

export function onQuestionDetected(
  handler: (event: QuestionDetectedEvent) => void
): Promise<UnlistenFn> {
  return listen<QuestionDetectedEvent>("question_detected", (e) =>
    handler(e.payload)
  );
}

// == AUDIO EVENTS ==

export function onAudioLevel(
  handler: (event: AudioLevelEvent) => void
): Promise<UnlistenFn> {
  return listen<AudioLevelEvent>("audio_level", (e) => handler(e.payload));
}

export function onAudioDeviceChange(
  handler: () => void
): Promise<UnlistenFn> {
  return listen("audio_device_change", () => handler());
}

// == MEETING EVENTS ==

export function onMeetingStarted(
  handler: (meetingId: string) => void
): Promise<UnlistenFn> {
  return listen<string>("meeting_started", (e) => handler(e.payload));
}

export function onMeetingEnded(
  handler: (meetingId: string) => void
): Promise<UnlistenFn> {
  return listen<string>("meeting_ended", (e) => handler(e.payload));
}

// == MODEL DOWNLOAD EVENTS ==

export function onModelDownloadProgress(
  handler: (event: ModelDownloadProgress) => void
): Promise<UnlistenFn> {
  return listen<ModelDownloadProgress>("model_download_progress", (e) =>
    handler(e.payload)
  );
}

// == RAG EVENTS ==

export function onRagIndexProgress(
  handler: (event: RagIndexProgressEvent) => void
): Promise<UnlistenFn> {
  return listen<RagIndexProgressEvent>("rag_index_progress", (e) =>
    handler(e.payload)
  );
}

export function onOllamaPullProgress(
  handler: (event: OllamaPullProgressEvent) => void
): Promise<UnlistenFn> {
  return listen<OllamaPullProgressEvent>("ollama_pull_progress", (e) =>
    handler(e.payload)
  );
}

export function onTranscriptIndexed(
  handler: (event: TranscriptIndexedEvent) => void
): Promise<UnlistenFn> {
  return listen<TranscriptIndexedEvent>("transcript_indexed", (e) =>
    handler(e.payload)
  );
}

// == STT STATUS EVENTS ==

export interface STTConnectionStatusEvent {
  provider: string;
  party: string;
  status: string; // "connecting", "connected", "error", "disconnected", "reconnecting", "paused" (muted)
  message?: string;
}

export interface STTDebugEvent {
  level: string; // "info", "warn", "error"
  source: string;
  message: string;
  timestamp_ms: number;
  /** When set, the frontend updates the last entry with this key in-place. */
  replace_key?: string;
}

export function onSTTConnectionStatus(
  handler: (event: STTConnectionStatusEvent) => void
): Promise<UnlistenFn> {
  return listen<STTConnectionStatusEvent>("stt_connection_status", (e) =>
    handler(e.payload)
  );
}

export function onSTTDebug(
  handler: (event: STTDebugEvent) => void
): Promise<UnlistenFn> {
  return listen<STTDebugEvent>("stt_debug", (e) => handler(e.payload));
}

// == TOPIC DETECTION EVENTS ==

export function onTopicDetected(
  handler: (payload: import("./types").TopicSection) => void
): Promise<UnlistenFn> {
  return listen<import("./types").TopicSection>("topic_detected", (event) =>
    handler(event.payload)
  );
}


// == SPEAKER DETECTION EVENTS ==

export interface SpeakerDetectedEvent {
  speaker_id: string;
  meeting_id: string;
}

export function onSpeakerDetected(
  handler: (payload: SpeakerDetectedEvent) => void
): Promise<UnlistenFn> {
  return listen<SpeakerDetectedEvent>("speaker_detected", (event) =>
    handler(event.payload)
  );
}

// == RECORDING EVENTS ==

export interface RecordingReadyEvent {
  meeting_id: string;
  recording_path: string;
  recording_size: number;
  waveform_path: string;
}

export function onRecordingReady(
  handler: (event: RecordingReadyEvent) => void
): Promise<UnlistenFn> {
  return listen<RecordingReadyEvent>("recording_ready", (e) => handler(e.payload));
}

export function onRecordingError(
  handler: (event: string) => void
): Promise<UnlistenFn> {
  return listen<string>("recording_error", (e) => handler(e.payload));
}

// == Events: Translation ==

export function onTranslationResult(handler: (result: TranslationResult) => void): Promise<UnlistenFn> {
  return listen<TranslationResult>("translation_result", (e) => handler(e.payload));
}

export function onTranslationError(handler: (error: { segment_id?: string; error: string }) => void): Promise<UnlistenFn> {
  return listen<{ segment_id?: string; error: string }>("translation_error", (e) => handler(e.payload));
}

export function onBatchTranslationProgress(handler: (progress: BatchTranslationProgress) => void): Promise<UnlistenFn> {
  return listen<BatchTranslationProgress>("batch_translation_progress", (e) => handler(e.payload));
}

// == UPDATER EVENTS ==

export function onUpdateDownloadProgress(
  handler: (event: UpdateDownloadProgress) => void
): Promise<UnlistenFn> {
  return listen<UpdateDownloadProgress>("update_download_progress", (e) =>
    handler(e.payload)
  );
}

export function onUpdateDownloaded(
  handler: (info: UpdateInfo) => void
): Promise<UnlistenFn> {
  return listen<UpdateInfo>("update_downloaded", (e) => handler(e.payload));
}

export function onUpdateDownloadFailed(
  handler: (event: UpdateDownloadFailed) => void
): Promise<UnlistenFn> {
  return listen<UpdateDownloadFailed>("update_download_failed", (e) =>
    handler(e.payload)
  );
}

/** Frontend-to-frontend: keep updater preferences in sync across windows. */
export function emitUpdaterPrefsChanged(prefs: UpdaterPrefsChangedEvent): Promise<void> {
  return emit("updater_prefs_changed", prefs);
}

export function onUpdaterPrefsChanged(
  handler: (prefs: UpdaterPrefsChangedEvent) => void
): Promise<UnlistenFn> {
  return listen<UpdaterPrefsChangedEvent>("updater_prefs_changed", (e) =>
    handler(e.payload)
  );
}

// == MEETING WINDOW SYNC ==

export function onWindowMeetingEnded(
  handler: (event: WindowMeetingEndedEvent) => void
): Promise<UnlistenFn> {
  return listen<WindowMeetingEndedEvent>("nexq:meeting_ended", (e) => handler(e.payload));
}

/** Overlay -> launcher: the overlay has the meeting and will persist its data. */
export function emitOverlayMeetingReady(meetingId: string): Promise<void> {
  const payload: OverlayMeetingReadyEvent = { meetingId };
  return emit("nexq:overlay_meeting_ready", payload);
}

export function onOverlayMeetingReady(
  handler: (event: OverlayMeetingReadyEvent) => void
): Promise<UnlistenFn> {
  return listen<OverlayMeetingReadyEvent>("nexq:overlay_meeting_ready", (e) =>
    handler(e.payload)
  );
}

/** Ask every window to end the meeting (same path as the tray's Stop). */
export function emitStopMeeting(): Promise<void> {
  return emit("tray_stop_meeting");
}

// == CLAUDE CLI EVENTS ==

/** A Claude session changed state (starting / ready / busy / error / closed). */
export function onAgentSessionStatus(
  handler: (status: AgentSessionStatus) => void
): Promise<UnlistenFn> {
  return listen<AgentSessionStatus>("agent_session_status", (e) => handler(e.payload));
}

/** Claude became unavailable; requests now go to the fallback provider (once per outage). */
export function onAgentFallback(
  handler: (event: AgentFallbackEvent) => void
): Promise<UnlistenFn> {
  return listen<AgentFallbackEvent>("agent_fallback", (e) => handler(e.payload));
}

// Tray events are handled via raw listen() calls in App.tsx

/** Audio capture started with the mic only: the other party couldn't be captured. */
export function onCaptureWarning(handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>("capture_warning", (e) => handler(e.payload));
}

/** A capture side is reconnecting its device, got it back, or gave up. */
export function onAudioCaptureStatus(handler: (status: AudioCaptureStatus) => void): Promise<UnlistenFn> {
  return listen<AudioCaptureStatus>("audio_capture_status", (e) => handler(e.payload));
}

/** Every capture side has stopped (End, or a device change restarting capture): drop what was shown about reconnecting. */
export function onAudioCaptureStopped(handler: () => void): Promise<UnlistenFn> {
  return listen("audio_capture_stopped", () => handler());
}

/** Another app started a call (the meeting prompt shows it). */
export function onMeetingDetected(handler: (info: MeetingPromptInfo) => void): Promise<UnlistenFn> {
  return listen<MeetingPromptInfo>("meeting_detected", (e) => handler(e.payload));
}

/** The detected call ended. */
export function onDetectedMeetingEnded(handler: () => void): Promise<UnlistenFn> {
  return listen("detected_meeting_ended", () => handler());
}

/** Prompt -> launcher: start a NexQ meeting for the detected call. */
export interface StartDetectedMeetingEvent {
  title: string;
  scenario: AIScenario;
  /** The workspace to file it in; omitted = the default workspace. */
  workspace_id?: string;
}

export function emitStartDetectedMeeting(payload: StartDetectedMeetingEvent): Promise<void> {
  return emit("nexq:start_detected_meeting", payload);
}

export function onStartDetectedMeeting(handler: (e: StartDetectedMeetingEvent) => void): Promise<UnlistenFn> {
  return listen<StartDetectedMeetingEvent>("nexq:start_detected_meeting", (e) => handler(e.payload));
}

/** Stealth mode was switched from the tray (the backend already applied it). */
export function onStealthModeChanged(handler: (enabled: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("stealth_mode_changed", (e) => handler(e.payload));
}

/** Window -> window: this window showed the pending `agent_fallback` notice. */
export function emitAgentFallbackShown(): Promise<void> {
  return emit("nexq:agent_fallback_shown");
}

export function onAgentFallbackShown(handler: () => void): Promise<UnlistenFn> {
  return listen("nexq:agent_fallback_shown", () => handler());
}

// == WORKSPACE EVENTS (spec section 9) ==

export function onWorkspacesChanged(handler: (e: WorkspacesChangedEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspacesChangedEvent>("workspaces_changed", (e) => handler(e.payload ?? {}));
}
export function onDbIntegrityProblem(handler: (e: DbIntegrityFinding) => void): Promise<UnlistenFn> {
  return listen<DbIntegrityFinding>("db_integrity_problem", (e) => handler(e.payload));
}
export function onWorkspaceIndexProgress(handler: (e: WorkspaceIndexProgressEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceIndexProgressEvent>("workspace_index_progress", (e) => handler(e.payload));
}

export function onWorkspaceChatStart(handler: (e: WorkspaceChatStartEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatStartEvent>("workspace_chat_start", (e) => handler(e.payload));
}
export function onWorkspaceChatToken(handler: (e: WorkspaceChatTokenEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatTokenEvent>("workspace_chat_token", (e) => handler(e.payload));
}
export function onWorkspaceChatActivity(handler: (e: WorkspaceChatActivityEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatActivityEvent>("workspace_chat_activity", (e) => handler(e.payload));
}
export function onWorkspaceChatContext(handler: (e: WorkspaceChatContextEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatContextEvent>("workspace_chat_context", (e) => handler(e.payload));
}
export function onWorkspaceChatEnd(handler: (e: WorkspaceChatEndEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatEndEvent>("workspace_chat_end", (e) => handler(e.payload));
}
export function onWorkspaceChatError(handler: (e: WorkspaceChatErrorEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatErrorEvent>("workspace_chat_error", (e) => handler(e.payload));
}
/** A tool that is not read-only asks for a click (answer with `answerWorkspaceApproval`). */
export function onWorkspaceChatApproval(handler: (e: WorkspaceChatApprovalEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatApprovalEvent>("workspace_chat_approval", (e) => handler(e.payload));
}
/** A tool was refused without asking (nothing to click). */
export function onWorkspaceChatApprovalRefused(handler: (e: WorkspaceChatApprovalRefusedEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatApprovalRefusedEvent>("workspace_chat_approval_refused", (e) => handler(e.payload));
}
/** The approval question ended without a click here (answered elsewhere, timeout, cancelled). */
export function onWorkspaceChatApprovalClosed(handler: (e: WorkspaceChatApprovalClosedEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceChatApprovalClosedEvent>("workspace_chat_approval_closed", (e) => handler(e.payload));
}

export function onNotetakerState(handler: (e: NotetakerState) => void): Promise<UnlistenFn> {
  return listen<NotetakerState>("notetaker_state", (e) => handler(e.payload));
}
export function onNotetakerDoc(handler: (e: NotetakerDocEvent) => void): Promise<UnlistenFn> {
  return listen<NotetakerDocEvent>("notetaker_doc", (e) => handler(e.payload));
}
export function onBriefState(handler: (e: BriefState) => void): Promise<UnlistenFn> {
  return listen<BriefState>("brief_state", (e) => handler(e.payload));
}
/** `workspace_material_unavailable`: a file or tool could not be used for this meeting. */
export interface WorkspaceMaterialUnavailableEvent {
  meeting_id: string | null;
  message: string;
}
export function onWorkspaceMaterialUnavailable(handler: (e: WorkspaceMaterialUnavailableEvent) => void): Promise<UnlistenFn> {
  return listen<WorkspaceMaterialUnavailableEvent>("workspace_material_unavailable", (e) => handler(e.payload));
}
export function onNotetakerSettingsChanged(handler: (e: NotetakerSettings) => void): Promise<UnlistenFn> {
  return listen<NotetakerSettings>("notetaker_settings_changed", (e) => handler(e.payload));
}
export function onBriefSettingsChanged(handler: (e: BriefSettings) => void): Promise<UnlistenFn> {
  return listen<BriefSettings>("brief_settings_changed", (e) => handler(e.payload));
}
export function onBriefSheet(handler: (e: BriefSheetEvent) => void): Promise<UnlistenFn> {
  return listen<BriefSheetEvent>("brief_sheet", (e) => handler(e.payload));
}
export function onMemorySettingsChanged(handler: (e: MemorySettings) => void): Promise<UnlistenFn> {
  return listen<MemorySettings>("memory_settings_changed", (e) => handler(e.payload));
}
export function onMemoryChanged(handler: (e: MemoryChangedEvent) => void): Promise<UnlistenFn> {
  return listen<MemoryChangedEvent>("memory_changed", (e) => handler(e.payload));
}

/** In-window DOM event the `N` key raises: "update notes now" (the notes panel listens). */
export { NOTES_UPDATE_EVENT };
export function onNotesUpdateRequested(handler: () => void): () => void {
  window.addEventListener(NOTES_UPDATE_EVENT, handler);
  return () => window.removeEventListener(NOTES_UPDATE_EVENT, handler);
}
