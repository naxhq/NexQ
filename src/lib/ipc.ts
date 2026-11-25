// ============================================================================
// NexQ IPC — Typed invoke() wrappers for all Tauri commands
// Each sub-PRD fills its section. Stubs return placeholder data.
// ============================================================================

import { invoke } from "@tauri-apps/api/core";
import type {
  BriefSettings, BriefSheet, ChatCapabilities, ItemPref, ChatItemPrefValue, ChatMeetingPref, DeleteWorkspaceMode, ContextReport, IndexStatus, LibraryItem, MeetingScope,
  MemoryItem, MemorySettings, NoteDoc, NoteEdit, NotetakerSettings, Passage, PassageKind, PointProgress, PointSaid,
  TalkingPoint, TalkingPointPatch, WorkspaceChat, WorkspaceChatPatch, WorkspaceDetail, WorkspaceInput, WorkspaceItemKind,
  WorkspaceMeetingPage, WorkspaceMessage, WorkspacePatch, WorkspaceSummary,
} from "./types";
import type {
  MeetingDetectionConfig,
  MeetingPromptInfo,
  StealthSupport,
  LogInfo,
  AllActionConfigs,
  AudioDeviceList,
  AudioSessionInfo,
  ContextResource,
  DeepgramConfig,
  GenerateAssistOptions,
  GroqConfig,
  IpolicyStatus,
  LocalSTTEngineInfo,
  Meeting,
  MeetingSummary,
  ModelInfo,
  OpenRouterModel,
  OllamaEmbeddingStatus,
  PartyAudioConfig,
  RagConfig,
  RagIndexStatus,
  RagSearchResult,
  RecordingInfo,
  TokenBudget,
  TranslationResult,
  TranslationLanguage,
  TranslationConnectionStatus,
  OpusMtModelStatus,
  TrayState,
  UpdateInfo,
  AgentSessionStatus,
  ClaudeCliConfig,
  ClaudeCliStatus,
  ClaudeModelInfo,
  CliAgentKind,
  CliAgentStatus,
  MeetingChatMessage,
  ClaudeCodeMcpServer,
  McpServer,
  McpServerForm,
  NotesFolderInfo,
  PersonalSourcesConfig,
  SourceToggles,
} from "./types";

// == IPC: Audio (Sub-PRD 3) ==

export async function listAudioDevices(): Promise<AudioDeviceList> {
  const result = await invoke<string>("list_audio_devices");
  return JSON.parse(result);
}

export async function startCapture(
  micDeviceId: string,
  systemDeviceId: string
): Promise<void> {
  return invoke("start_capture", {
    micDeviceId,
    systemDeviceId,
  });
}

/** `keepRecording`: a device change mid-meeting; the recording continues after the restart. */
export async function stopCapture(keepRecording = false): Promise<void> {
  return invoke("stop_capture", { keepRecording });
}

export async function getAudioLevel(): Promise<string> {
  return invoke("get_audio_level");
}

export async function testAudioDevice(deviceId: string): Promise<boolean> {
  return invoke("test_audio_device", { deviceId });
}

export async function startAudioTest(
  deviceId: string,
  isInput: boolean
): Promise<void> {
  return invoke("start_audio_test", { deviceId, isInput });
}

export async function stopAudioTest(): Promise<boolean> {
  return invoke("stop_audio_test");
}

export async function ensureIpolicyOverride(): Promise<IpolicyStatus> {
  const result = await invoke<string>("ensure_ipolicy_override");
  return JSON.parse(result);
}

/** Peak level (0–1) for one audio endpoint, from IAudioMeterInformation. */
export interface DevicePeakLevel {
  device_id: string;
  level: number;
}

/**
 * Return peak audio levels for ALL active audio endpoints simultaneously.
 * Uses Win32 IAudioMeterInformation — no capture streams opened.
 * Typically completes in 1–3 ms regardless of device count.
 */
export async function getAudioPeakLevels(): Promise<DevicePeakLevel[]> {
  return invoke("get_audio_peak_levels");
}

export async function setRecordingEnabled(enabled: boolean): Promise<void> {
  return invoke("set_recording_enabled", { enabled });
}

/** Start the Live Monitor background thread (pushes `device_levels` events at ~60 fps). */
export async function startDeviceMonitor(): Promise<void> {
  return invoke("start_device_monitor");
}

/** Stop the Live Monitor background thread. */
export async function stopDeviceMonitor(): Promise<void> {
  return invoke("stop_device_monitor");
}

export async function getAudioSessions(): Promise<AudioSessionInfo[]> {
  const result = await invoke<string>("get_audio_sessions");
  return JSON.parse(result);
}

export async function startCapturePerParty(
  youConfig: PartyAudioConfig,
  themConfig: PartyAudioConfig,
  options: { skipYouStt?: boolean } = {}
): Promise<void> {
  return invoke("start_capture_per_party", {
    youConfig: JSON.stringify(youConfig),
    themConfig: JSON.stringify(themConfig),
    skipYouStt: options.skipYouStt ?? false,
  });
}

/**
 * Change one side's transcription language by restarting only that side's speech-to-text;
 * the other side, the audio and the recording keep running. `config` is the side's whole
 * config with the new language. Resolves true when it was done, false when the caller has
 * to do a full `startCapturePerParty` (no capture, no Rust provider on that side).
 * Rejects with the Auto-detect refusal when the side can't detect the language.
 */
export async function setPartyLanguage(
  party: "you" | "them",
  config: PartyAudioConfig,
  options: { skipYouStt?: boolean } = {}
): Promise<boolean> {
  return invoke<boolean>("set_party_language", {
    party,
    config: JSON.stringify(config),
    skipYouStt: options.skipYouStt ?? false,
  });
}

/** Mute or unmute a specific audio source's STT feed. Audio levels + recording continue. */
export async function setSourceMuted(source: "you" | "them", muted: boolean): Promise<void> {
  return invoke("set_source_muted", { source, muted });
}

/** Echo cancellation for "You" (the speakers' sound removed from the mic). */
export async function setEchoCancellation(enabled: boolean): Promise<void> {
  return invoke("set_echo_cancellation", { enabled });
}

/** Get current mute status for both sources. */
export async function getMuteStatus(): Promise<{ you: boolean; them: boolean }> {
  const result = await invoke<string>("get_mute_status");
  return JSON.parse(result);
}

// == IPC: STT (Sub-PRD 4) ==

export async function setSTTProvider(provider: string): Promise<void> {
  return invoke("set_stt_provider", { provider });
}

export async function setSTTLanguage(language: string): Promise<void> {
  return invoke("set_stt_language", { language });
}

export async function testSTTConnection(provider: string): Promise<boolean> {
  return invoke("test_stt_connection", { provider });
}

/** Test Azure MAI Streaming credentials before saving them to the credential store. */
export async function testAzureMaiConnection(key: string, region: string): Promise<boolean> {
  return invoke("test_azure_mai_connection", { key, region });
}

export async function getAvailableSTTProviders(): Promise<string[]> {
  const result = await invoke<string>("get_available_stt_providers");
  return JSON.parse(result);
}

// == IPC: LLM (Sub-PRD 5) ==

export async function setLLMProvider(provider: string): Promise<void> {
  return invoke("set_llm_provider", { provider });
}

export async function listModels(provider: string): Promise<ModelInfo[]> {
  const result = await invoke<string>("list_models", { provider });
  return JSON.parse(result);
}

export async function setActiveModel(
  provider: string,
  modelId: string
): Promise<void> {
  return invoke("set_active_model", { provider, modelId });
}

export async function testLLMConnection(provider: string): Promise<boolean> {
  return invoke("test_llm_connection", { provider });
}

export async function getLLMProviders(): Promise<string[]> {
  const result = await invoke<string>("get_llm_providers");
  return JSON.parse(result);
}

export async function listOpenRouterModels(
  forceRefresh: boolean
): Promise<OpenRouterModel[]> {
  const result = await invoke<string>("list_openrouter_models", {
    forceRefresh,
  });
  return JSON.parse(result);
}

// == IPC: Intelligence (Sub-PRD 6) ==

export async function generateAssist(
  mode: string,
  customQuestion?: string,
  opts: GenerateAssistOptions = {}
): Promise<void> {
  const requestId = opts.requestId ?? crypto.randomUUID();

  // Universal transcript: unless the caller supplies segments (past meetings),
  // snapshot the live transcript from the frontend store (the single source of
  // truth — every STT engine feeds into it). Interim text is labeled and is
  // never promoted to a final segment in the store.
  // The backend applies the per-action transcript window setting.
  let segments = opts.transcriptSegments;
  if (!segments) {
    const { useTranscriptStore } = await import("../stores/transcriptStore");
    const { useSpeakerStore } = await import("../stores/speakerStore");
    const { assistSpeakerLabel } = await import("./speakerLabels");
    // A diarized line goes by its person's name ("Erin" / "Speaker 2").
    const { speakers } = useSpeakerStore.getState();
    const nameOf = (key: string) => speakers[key]?.display_name;
    segments = useTranscriptStore.getState().segments
      .map((s) => {
        const pending = s.pending_text?.trim();
        const text = pending || s.text;
        const interim = !s.is_final || !!pending;
        const label = assistSpeakerLabel(s, nameOf);
        // The Claude session path keys on this suffix (routing::INTERIM_SUFFIX).
        const speaker = interim ? `${label === "User" ? "You" : label} (interim)` : label;
        return { id: s.id, text, speaker, timestamp_ms: s.timestamp_ms };
      })
      .filter((s) => s.text.trim().length > 0);
  }

  return invoke("generate_assist", {
    mode,
    customQuestion,
    transcriptSegments: JSON.stringify(segments),
    requestId,
    ...(opts.pastMeetingId ? { pastMeetingId: opts.pastMeetingId } : {}),
    // No `sources`: an automatic answer, which never uses personal sources.
    ...(opts.sources ? { sources: opts.sources } : {}),
    // No scope (or `default`): the backend keeps the action's own window.
    ...(opts.scope && opts.scope.kind !== "default" ? { scope: opts.scope } : {}),
    ...(opts.images && opts.images.length > 0 ? { images: opts.images } : {}),
  });
}

/** Stops the answer being generated; with `requestId`, only if that one is still running. */
export async function cancelGeneration(requestId?: string): Promise<void> {
  return invoke("cancel_generation", requestId ? { requestId } : {});
}

export async function setAutoTrigger(enabled: boolean): Promise<void> {
  return invoke("set_auto_trigger", { enabled });
}

export async function setContextWindowSeconds(seconds: number): Promise<void> {
  return invoke("set_context_window_seconds", { seconds });
}

export async function pushTranscript(
  text: string,
  speaker: string,
  timestampMs: number,
  isFinal: boolean
): Promise<void> {
  return invoke("push_transcript", { text, speaker, timestampMs, isFinal });
}

// == IPC: Action Configs ==

export async function updateActionConfigs(configs: AllActionConfigs): Promise<void> {
  return invoke("update_action_configs", { configsJson: JSON.stringify(configs) });
}

export async function getActionConfigs(): Promise<AllActionConfigs> {
  const result = await invoke<string>("get_action_configs");
  return JSON.parse(result);
}

// == IPC: Context (Sub-PRD 7) ==

export async function loadContextFile(
  filePath: string,
  /** The workspace the file joins with the library (omitted = it joins none on its own). */
  workspaceId?: string
): Promise<ContextResource> {
  const result = await invoke<string>("load_context_file", { filePath, ...(workspaceId ? { workspaceId } : {}) });
  return JSON.parse(result);
}

export async function removeContextFile(resourceId: string): Promise<void> {
  return invoke("remove_context_file", { resourceId });
}

export async function listContextResources(): Promise<ContextResource[]> {
  const result = await invoke<string>("list_context_resources");
  return JSON.parse(result);
}

export async function setCustomInstructions(
  instructions: string
): Promise<void> {
  return invoke("set_custom_instructions", { instructions });
}

export async function getAssembledContext(): Promise<string> {
  return invoke("get_assembled_context");
}

export async function getTokenBudget(): Promise<TokenBudget> {
  const result = await invoke<string>("get_token_budget");
  return JSON.parse(result);
}

// == IPC: Credentials (Sub-PRD 1) ==

export async function storeApiKey(
  provider: string,
  key: string
): Promise<void> {
  return invoke("store_api_key", { provider, key });
}

export async function getApiKey(provider: string): Promise<string | null> {
  return invoke("get_api_key", { provider });
}

export async function deleteApiKey(provider: string): Promise<void> {
  return invoke("delete_api_key", { provider });
}

export async function hasApiKey(provider: string): Promise<boolean> {
  return invoke("has_api_key", { provider });
}

// == IPC: Meetings (Sub-PRD 1/8) ==

export async function startMeeting(
  title?: string,
  workspaceId?: string,
): Promise<Meeting> {
  const result = await invoke<string>("start_meeting", { title, ...(workspaceId ? { workspaceId } : {}) });
  return JSON.parse(result);
}

export async function endMeeting(meetingId: string): Promise<void> {
  return invoke("end_meeting", { meetingId });
}

export async function listMeetings(
  limit?: number,
  offset?: number
): Promise<MeetingSummary[]> {
  const result = await invoke<string>("list_meetings", { limit, offset });
  return JSON.parse(result);
}

export async function getMeeting(meetingId: string): Promise<Meeting> {
  const result = await invoke<string>("get_meeting", { meetingId });
  return JSON.parse(result);
}

export async function deleteMeeting(meetingId: string): Promise<void> {
  return invoke("delete_meeting", { meetingId });
}

export async function searchMeetings(query: string): Promise<MeetingSummary[]> {
  const result = await invoke<string>("search_meetings", { query });
  return JSON.parse(result);
}

export async function appendTranscriptSegment(
  meetingId: string,
  segment: string
): Promise<void> {
  return invoke("append_transcript_segment", { meetingId, segment });
}

export async function saveMeetingAiInteractions(
  meetingId: string,
  aiInteractionsJson: string
): Promise<void> {
  return invoke("save_meeting_ai_interactions", { meetingId, aiInteractionsJson });
}

export async function renameMeeting(meetingId: string, newTitle: string): Promise<void> {
  return invoke("rename_meeting", { meetingId, newTitle });
}

export async function updateMeetingSummary(meetingId: string, summary: string): Promise<void> {
  return invoke("update_meeting_summary", { meetingId, summary });
}

// == IPC: In-Person Meeting Mode ==

export async function saveMeetingSpeakers(meetingId: string, speakersJson: string): Promise<void> {
  return invoke("save_meeting_speakers", { meetingId, speakersJson });
}

export async function saveMeetingBookmarks(meetingId: string, bookmarksJson: string): Promise<void> {
  return invoke("save_meeting_bookmarks", { meetingId, bookmarksJson });
}

export async function addMeetingBookmark(bookmarkJson: string): Promise<void> {
  await invoke("add_meeting_bookmark", { bookmarkJson });
}

export async function updateMeetingBookmark(bookmarkId: string, note: string | null): Promise<void> {
  await invoke("update_meeting_bookmark", { bookmarkId, note });
}

export async function deleteMeetingBookmark(bookmarkId: string): Promise<void> {
  await invoke("delete_meeting_bookmark", { bookmarkId });
}

export async function saveMeetingActionItems(meetingId: string, itemsJson: string): Promise<void> {
  return invoke("save_meeting_action_items", { meetingId, itemsJson });
}

export async function updateActionItem(itemId: string, completed: boolean): Promise<void> {
  await invoke("update_action_item", { itemId, completed });
}

export async function deleteActionItem(itemId: string): Promise<void> {
  await invoke("delete_action_item", { itemId });
}

export async function saveMeetingTopicSections(meetingId: string, sectionsJson: string): Promise<void> {
  return invoke("save_meeting_topic_sections", { meetingId, sectionsJson });
}

export async function renameSpeaker(meetingId: string, speakerId: string, newName: string): Promise<void> {
  return invoke("rename_speaker", { meetingId, speakerId, newName });
}

export async function updateMeetingMode(meetingId: string, audioMode: string, aiScenario: string): Promise<void> {
  return invoke("update_meeting_mode", { meetingId, audioMode, aiScenario });
}

// == IPC: Scenario-Aware Intelligence ==

export async function setActiveScenario(
  systemPrompt: string,
  summaryPrompt: string,
  questionDetectionPrompt: string
): Promise<void> {
  return invoke("set_active_scenario", { systemPrompt, summaryPrompt, questionDetectionPrompt });
}

export async function updateSpeakerContext(speakerContext: string): Promise<void> {
  return invoke("update_speaker_context", { speakerContext });
}

// == IPC: Whisper Dual-Pass Config ==

export async function updateWhisperDualPassConfig(
  shortChunkSecs: number,
  longChunkSecs: number,
  pauseSecs: number
): Promise<void> {
  return invoke("update_whisper_dual_pass_config", {
    shortChunkSecs,
    longChunkSecs,
    pauseSecs,
  });
}

// == IPC: Local STT Models ==

export async function listLocalSTTEngines(): Promise<LocalSTTEngineInfo[]> {
  const result = await invoke<string>("list_local_stt_engines");
  const raw = JSON.parse(result);
  // Flatten the nested Rust structure for frontend convenience
  return raw.map((eng: any) => ({
    engine: eng.engine,
    name: eng.name,
    description: eng.description,
    models: eng.models.map((m: any) => ({
      id: m.definition.model_id,
      engine: m.definition.engine,
      name: m.definition.display_name,
      size_bytes: m.definition.size_bytes,
      accuracy_rating: m.definition.accuracy_rating,
      speed_rating: m.definition.speed_rating,
      is_streaming: m.definition.is_streaming,
      is_downloaded: m.is_downloaded,
    })),
  }));
}

export async function downloadLocalSTTModel(
  engine: string,
  modelId: string
): Promise<void> {
  return invoke("download_local_stt_model", { engine, modelId });
}

export async function cancelModelDownload(
  engine: string,
  modelId: string
): Promise<void> {
  return invoke("cancel_model_download", { engine, modelId });
}

export async function deleteLocalSTTModel(
  engine: string,
  modelId: string
): Promise<void> {
  return invoke("delete_local_stt_model", { engine, modelId });
}

// == IPC: Deepgram Config ==

export async function updateDeepgramConfig(config: DeepgramConfig): Promise<void> {
  return invoke("update_deepgram_config", { configJson: JSON.stringify(config) });
}

// == IPC: Groq Config ==

export async function updateGroqConfig(config: GroqConfig): Promise<void> {
  return invoke("update_groq_config", { configJson: JSON.stringify(config) });
}

// == IPC: Pause Threshold ==

export async function setPauseThreshold(ms: number): Promise<void> {
  return invoke("set_pause_threshold", { ms });
}

export async function getPauseThreshold(): Promise<number> {
  return invoke("get_pause_threshold");
}

// == IPC: Deepgram Cost Estimation ==

export async function estimateDeepgramCost(durationMinutes: number): Promise<{
  cost_usd: number;
  streams: number;
  rate_per_min: number;
}> {
  const result = await invoke<string>("estimate_deepgram_cost", { durationMinutes });
  return JSON.parse(result);
}

// == IPC: RAG (Context Intelligence) ==

export async function rebuildRagIndex(): Promise<void> {
  return invoke("rebuild_rag_index");
}

export async function rebuildFileIndex(resourceId: string): Promise<void> {
  return invoke("rebuild_file_index", { resourceId });
}

export async function clearRagIndex(): Promise<void> {
  return invoke("clear_rag_index");
}

export async function getRagStatus(): Promise<RagIndexStatus> {
  const result = await invoke<string>("get_rag_status");
  return JSON.parse(result);
}

export async function testRagSearch(query: string): Promise<RagSearchResult[]> {
  const result = await invoke<string>("test_rag_search", { query });
  return JSON.parse(result);
}

export async function getRagConfig(): Promise<RagConfig> {
  const result = await invoke<string>("get_rag_config");
  return JSON.parse(result);
}

export async function updateRagConfig(config: RagConfig): Promise<void> {
  return invoke("update_rag_config", { configJson: JSON.stringify(config) });
}

export async function testOllamaEmbeddingConnection(): Promise<OllamaEmbeddingStatus> {
  const result = await invoke<string>("test_ollama_embedding_connection");
  return JSON.parse(result);
}

export async function pullEmbeddingModel(model: string): Promise<void> {
  return invoke("pull_embedding_model", { model });
}

export async function testRagAnswer(
  query: string,
  llmProvider?: string,
  llmModel?: string,
  requestId?: string
): Promise<void> {
  return invoke("test_rag_answer", { query, llmProvider, llmModel, requestId });
}

export async function removeFileRagIndex(resourceId: string): Promise<void> {
  return invoke("remove_file_rag_index", { resourceId });
}

// == IPC: Settings (Sub-PRD 1) ==

export async function getConfig(key: string): Promise<string | null> {
  return invoke("get_config", { key });
}

export async function setConfig(key: string, value: string): Promise<void> {
  return invoke("set_config", { key, value });
}

// == IPC: Recording (Sub-PRD 5) ==

export async function getRecordingInfo(meetingId: string): Promise<RecordingInfo | null> {
  return invoke<RecordingInfo | null>("get_recording_info", { meetingId });
}

export async function getRecordingFileUrl(meetingId: string): Promise<string> {
  return invoke<string>("get_recording_file_url", { meetingId });
}

export async function deleteRecording(meetingId: string): Promise<void> {
  return invoke("delete_recording", { meetingId });
}

// == IPC: Translation ==

export async function setTranslationProvider(provider: string, region?: string): Promise<void> {
  return invoke("set_translation_provider", { provider, region });
}

export async function translateText(text: string, targetLang: string, sourceLang?: string): Promise<TranslationResult> {
  return invoke<TranslationResult>("translate_text", { text, targetLang, sourceLang });
}

export async function translateSegments(segmentIds: string[], texts: string[], meetingId: string, targetLang: string, sourceLang?: string): Promise<void> {
  return invoke("translate_segments", { segmentIds, texts, meetingId, targetLang, sourceLang });
}

export async function translateBatch(meetingId: string, targetLang: string): Promise<{ total: number; alreadyDone: number; newlyTranslated: number }> {
  return invoke("translate_batch", { meetingId, targetLang });
}

export async function detectLanguage(text: string): Promise<{ lang: string; confidence: number }> {
  return invoke("detect_language", { text });
}

export async function testTranslationConnection(provider: string): Promise<TranslationConnectionStatus> {
  return invoke<TranslationConnectionStatus>("test_translation_connection", { provider });
}

export async function getTranslationLanguages(): Promise<TranslationLanguage[]> {
  return invoke<TranslationLanguage[]>("get_translation_languages");
}

export async function getMeetingTranslations(meetingId: string, targetLang: string): Promise<TranslationResult[]> {
  return invoke<TranslationResult[]>("get_meeting_translations", { meetingId, targetLang });
}

export async function getAllMeetingTranslations(meetingId: string): Promise<TranslationResult[]> {
  return invoke<TranslationResult[]>("get_all_meeting_translations", { meetingId });
}

export async function exportTranslatedTranscript(meetingId: string, targetLang: string, format: string): Promise<string> {
  return invoke<string>("export_translated_transcript", { meetingId, targetLang, format });
}

export async function setTranslationLanguages(targetLang: string, sourceLang?: string): Promise<void> {
  return invoke("set_translation_languages", { targetLang, sourceLang });
}

// == IPC: OPUS-MT Models ==

export async function listOpusMtModels(): Promise<OpusMtModelStatus[]> {
  const result = await invoke<string>("list_opus_mt_models");
  return JSON.parse(result);
}

export async function downloadOpusMtModel(modelId: string): Promise<void> {
  return invoke("download_opus_mt_model", { modelId });
}

export async function cancelOpusMtDownload(modelId: string): Promise<void> {
  return invoke("cancel_opus_mt_download", { modelId });
}

export async function deleteOpusMtModel(modelId: string): Promise<void> {
  return invoke("delete_opus_mt_model", { modelId });
}

export async function activateOpusMtModel(modelId: string): Promise<void> {
  return invoke("activate_opus_mt_model", { modelId });
}

// == IPC: Tray ==

export async function setTrayState(state: TrayState): Promise<void> {
  return invoke("set_tray_state", { state });
}

export async function setMeetingStartTime(started: boolean): Promise<void> {
  return invoke("set_meeting_start_time", { started });
}

export async function rebuildTrayMenu(meetingActive: boolean): Promise<void> {
  return invoke("rebuild_tray_menu", { meetingActive });
}

/** Stealth mode: keep every NexQ window out of screen sharing, recordings and screenshots. */
export async function setStealthMode(enabled: boolean): Promise<void> {
  return invoke("set_stealth_mode", { enabled });
}

/** Meeting detection: apply the user's settings in the backend detector. */
export async function setMeetingDetectionConfig(config: MeetingDetectionConfig): Promise<void> {
  return invoke("set_meeting_detection_config", { config });
}

/** The call the meeting prompt is about, if one is in progress. */
export async function getDetectedMeeting(): Promise<MeetingPromptInfo | null> {
  return invoke<MeetingPromptInfo | null>("get_detected_meeting");
}

/** Close the meeting prompt (dismissed, timed out or started). */
export async function dismissMeetingPrompt(): Promise<void> {
  return invoke("dismiss_meeting_prompt");
}

/**
 * The screen under the mouse pointer as a PNG (at most 1568 px on the long
 * edge). Held in memory only: nothing is saved. Rejects with a sentence to show
 * (asked outside the overlay or a meeting, black or protected screen, capture failure).
 */
export async function captureScreenUnderCursor(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("capture_screen_under_cursor");
}

export async function getStealthSupport(): Promise<StealthSupport> {
  return invoke<StealthSupport>("get_stealth_support");
}

/** Diagnostics: where the app log lives and whether verbose logging is on. */
export async function getLogInfo(): Promise<LogInfo> {
  return invoke<LogInfo>("get_log_info");
}

export async function setVerboseLogging(enabled: boolean): Promise<void> {
  return invoke("set_verbose_logging", { enabled });
}

export async function openLogFolder(): Promise<void> {
  return invoke("open_log_folder");
}

/** The last `maxLines` lines of the app log (API keys already removed). */
export async function getRecentLogs(maxLines?: number): Promise<string> {
  return invoke<string>("get_recent_logs", { maxLines });
}

// == IPC: Gemini Context Cache ==

export interface GeminiCacheInfo {
  name: string;
  model: string;
  expire_time: string;
  total_token_count: number;
}

export async function createGeminiContextCache(
  model: string,
  ttlSecs: number,
  systemPrompt?: string
): Promise<GeminiCacheInfo> {
  const result = await invoke<string>("create_gemini_context_cache", {
    model,
    ttlSecs,
    systemPrompt,
  });
  return JSON.parse(result);
}

export async function deleteGeminiContextCache(): Promise<void> {
  return invoke("delete_gemini_context_cache");
}

export async function getGeminiCacheStatus(): Promise<GeminiCacheInfo | null> {
  const result = await invoke<string | null>("get_gemini_cache_status");
  if (!result) return null;
  return JSON.parse(result);
}

// == IPC: Updater ==

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("check_for_update");
}

/** Download the update in the background; Rust keeps the bytes until install. */
export async function downloadUpdate(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("download_update");
}

/** Install the downloaded update. The app exits and relaunches on the new version. */
export async function installUpdateNow(): Promise<void> {
  return invoke("install_update_now");
}

export async function getPendingUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("get_pending_update");
}

/** True while a quit is deferred (waiting for the last recording to save). */
export async function isQuitPending(): Promise<boolean> {
  return invoke<boolean>("is_quit_pending");
}

// == IPC: Claude CLI (subscription) ==

/** Detect `claude.exe`, its version and login state (no model call). */
export async function claudeCliStatus(): Promise<ClaudeCliStatus> {
  return invoke<ClaudeCliStatus>("claude_cli_status");
}

/**
 * The models the Claude CLI offers (no model call). Cached by the backend;
 * `refresh` asks the CLI again.
 */
export async function claudeCliModels(refresh = false): Promise<ClaudeModelInfo[]> {
  return invoke<ClaudeModelInfo[]>("claude_cli_models", { refresh });
}

/** Give the backend the saved model catalog until (or unless) a probe answers. */
export async function seedClaudeCliModels(models: ClaudeModelInfo[]): Promise<boolean> {
  return invoke<boolean>("seed_claude_cli_models", { models });
}

/** Replace the Fast/Deep model settings; applies to sessions started afterwards. */
export async function setClaudeCliConfig(config: ClaudeCliConfig): Promise<void> {
  return invoke("set_claude_cli_config", { config });
}

// == IPC: CLI agents (Claude / Antigravity / Codex subscription providers) ==
// `kind` is the provider id: "claude_cli", "antigravity_cli" or "codex_cli".

/**
 * Detect the CLI, its version and login state (no model call). For Antigravity
 * the login check also lists its models (the backend catalog is filled).
 */
export async function cliAgentStatus(kind: CliAgentKind): Promise<CliAgentStatus> {
  return invoke<CliAgentStatus>("cli_agent_status", { kind });
}

/** The models the CLI offers (no model call). Cached by the backend; `refresh` asks the CLI again. */
export async function cliAgentModels(kind: CliAgentKind, refresh = false): Promise<ClaudeModelInfo[]> {
  return invoke<ClaudeModelInfo[]>("cli_agent_models", { kind, refresh });
}

/** Give the backend the saved model catalog of `kind` until (or unless) a probe answers. */
export async function seedCliAgentModels(kind: CliAgentKind, models: ClaudeModelInfo[]): Promise<boolean> {
  return invoke<boolean>("seed_cli_agent_models", { kind, models });
}

/** Replace the Fast/Deep model settings of `kind`; applies to sessions started afterwards. */
export async function setCliAgentConfig(kind: CliAgentKind, config: ClaudeCliConfig): Promise<void> {
  return invoke("set_cli_agent_config", { kind, config });
}

/** Open a visible terminal running the CLI's login (`claude`, `codex login`, `agy`). */
export async function openCliLoginTerminal(kind: CliAgentKind): Promise<void> {
  return invoke("open_cli_login_terminal", { kind });
}

/** Status of every open CLI agent session. */
export async function getAgentSessions(): Promise<AgentSessionStatus[]> {
  return invoke<AgentSessionStatus[]>("get_agent_sessions");
}

/** Open a visible terminal running `claude` so the user can log in. */
export async function openClaudeLoginTerminal(): Promise<void> {
  return invoke("open_claude_login_terminal");
}

/** Start the Claude session of a past meeting (no-op unless Claude CLI is active). */
export async function startPastMeetingSession(meetingId: string): Promise<void> {
  return invoke("start_past_meeting_session", { meetingId });
}

/** Close the Claude session of a past meeting (meeting view left). */
export async function closePastMeetingSession(meetingId: string): Promise<void> {
  return invoke("close_past_meeting_session", { meetingId });
}

// == IPC: Personal sources (notes folders + MCP servers) ==

/** Whether a folder exists, how many notes it holds, and why it can't be a notes folder (`problem`). */
export async function inspectNotesFolder(path: string): Promise<NotesFolderInfo> {
  return invoke<NotesFolderInfo>("inspect_notes_folder", { path });
}

/**
 * Add the servers in pasted `mcpServers` JSON. Secret values are stored in
 * Credential Manager and are not in the returned servers. New keys avoid the
 * keys the backend has saved (see `setPersonalSources`).
 */
export async function importMcpServersJson(json: string): Promise<McpServer[]> {
  return invoke<McpServer[]>("import_mcp_servers_json", { json });
}

/**
 * Save the add/edit server form; secrets go to Credential Manager, the result
 * holds names only. An edit (`form.id`) must name a server the backend has
 * saved (`setPersonalSources`): its key comes from there, `form.key` is
 * ignored. If the edit changes the command, arguments, URL or plain
 * environment, stored secrets are not kept: it rejects with "Enter the secrets
 * again: ..." until every secret is typed in the form.
 */
export async function saveMcpServerForm(form: McpServerForm): Promise<McpServer> {
  return invoke<McpServer>("save_mcp_server_form", { form });
}

/** The user-scope MCP servers in Claude Code's config (read only when called). */
export async function listClaudeCodeMcpServers(): Promise<ClaudeCodeMcpServer[]> {
  return invoke<ClaudeCodeMcpServer[]>("list_claude_code_mcp_servers");
}

/** Copy the named Claude Code servers into NexQ (OAuth ones come back off, `needs_sign_in`). */
export async function importClaudeCodeMcpServers(names: string[]): Promise<McpServer[]> {
  return invoke<McpServer[]>("import_claude_code_mcp_servers", { names });
}

/**
 * Start a server like a session would and list its tools (up to 60 s). The
 * backend runs the server it has saved under `serverId` (call
 * `setPersonalSources` first when it was just added) with its stored secrets.
 * To check an unsaved or edited form instead, pass `draft`: it runs with the
 * secrets typed in it, and stored secrets only if the draft starts the same
 * thing as the saved server. A failing server does not reject: the result's
 * `last_check` has `ok: false` and the `error`.
 */
export async function checkMcpServer(serverId: string | null, draft: McpServerForm | null = null): Promise<McpServer> {
  return invoke<McpServer>("check_mcp_server", { serverId, draft });
}

/**
 * Which environment variable names hold a secret (so their values are hidden
 * and kept in Credential Manager). The backend decides; there is no copy of
 * the rule here.
 */
export async function classifySecretNames(names: string[]): Promise<boolean[]> {
  return invoke<boolean[]>("classify_secret_names", { names });
}

/** The webview dropped servers the backend handed it without saving them: free their keys. */
export async function discardPendingMcpServers(ids: string[]): Promise<void> {
  return invoke("discard_pending_mcp_servers", { ids });
}

/** Forget the saved secrets of a saved server that is being removed (call before saving the removal). */
export async function deleteMcpSecrets(serverId: string): Promise<void> {
  return invoke("delete_mcp_secrets", { serverId });
}

/**
 * Give the backend the sources the user set up. Call it at startup and after
 * every change: it is the saved config the other commands look servers up in
 * (keys, checks, secrets), and it restarts the with-sources Claude session
 * when something that goes into it changed. Removing a server here forgets
 * its saved secrets. Rejects on an invalid or duplicate server key.
 */
/** The items the user just added, filed in a workspace: exactly these ids, never inferred. */
export interface SourcesFiling {
  workspace_id: string;
  items: Array<{ kind: "folder" | "server"; ref_id: string }>;
}

export async function setPersonalSources(config: PersonalSourcesConfig, filing?: SourcesFiling): Promise<void> {
  return invoke("set_personal_sources", { config, ...(filing ? { filing } : {}) });
}

/** After a folder or server was removed from the saved sources: it leaves every workspace. */
export async function removeLibraryItem(kind: WorkspaceItemKind, refId: string): Promise<void> {
  return invoke("remove_library_item", { kind, refId });
}

/** Mirrors Rust `WorkspacesStatus`: false when the upgrade failed and the app runs on General alone. */
export interface WorkspacesStatus {
  available: boolean;
  error: string | null;
}
export async function getWorkspacesStatus(): Promise<WorkspacesStatus> {
  return invoke<WorkspacesStatus>("get_workspaces_status");
}

/**
 * Try the with-sources Claude session again now (from its error state). After
 * a failed start, answers with a pill on use the plain session for about 2
 * minutes (their notice says when the next try is), then one retry runs on its
 * own. This forgets the failure and restarts the session at once.
 */
export async function retrySourcesSession(): Promise<void> {
  return invoke("retry_sources_session");
}

/** Open a note with the default app; only a file inside an enabled notes folder. */
export async function openSourceFile(path: string): Promise<void> {
  return invoke("open_source_file", { path });
}

// == IPC: Ask this meeting ==

/**
 * Ask a question about a past meeting. The answer streams through the
 * `llm_stream_*` events tagged with `requestId` — subscribe before calling.
 * Resolves once the answer is saved (stop with `cancelGeneration`).
 */
export async function askMeeting(
  meetingId: string,
  question: string,
  requestId: string,
  sources?: SourceToggles,
): Promise<void> {
  return invoke("ask_meeting", { meetingId, question, requestId, ...(sources ? { sources } : {}) });
}

/** The meeting's saved "Ask this meeting" chat, oldest first. */
export async function listMeetingChat(meetingId: string): Promise<MeetingChatMessage[]> {
  return invoke<MeetingChatMessage[]>("list_meeting_chat", { meetingId });
}

// == IPC: Workspaces (spec section 9). Rust params are snake_case, Tauri takes camelCase ==

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return invoke<WorkspaceSummary[]>("list_workspaces");
}
export async function getWorkspace(id: string): Promise<WorkspaceDetail> {
  return invoke<WorkspaceDetail>("get_workspace", { id });
}
export async function createWorkspace(input: WorkspaceInput): Promise<WorkspaceDetail> {
  return invoke<WorkspaceDetail>("create_workspace", { input });
}
export async function updateWorkspace(id: string, patch: WorkspacePatch): Promise<WorkspaceDetail> {
  return invoke<WorkspaceDetail>("update_workspace", { id, patch });
}
/** Copies name, look, instructions, library memberships and talking points; not meetings, chats, memory or secrets. */
export async function cloneWorkspace(id: string, name: string): Promise<WorkspaceDetail> {
  return invoke<WorkspaceDetail>("clone_workspace", { id, name });
}
export async function archiveWorkspace(id: string, archived: boolean): Promise<void> {
  return invoke("archive_workspace", { id, archived });
}
export async function deleteWorkspace(id: string, mode: DeleteWorkspaceMode): Promise<void> {
  return invoke("delete_workspace", { id, mode });
}
export async function setDefaultWorkspace(id: string): Promise<void> {
  return invoke("set_default_workspace", { id });
}
export async function reorderWorkspaces(ids: string[]): Promise<void> {
  return invoke("reorder_workspaces", { ids });
}
export async function addWorkspaceItem(
  id: string,
  kind: WorkspaceItemKind,
  refId: string,
  label?: string,
): Promise<void> {
  return invoke("add_workspace_item", { id, kind, refId, label });
}
export async function updateWorkspaceItem(
  id: string,
  kind: WorkspaceItemKind,
  refId: string,
  patch: { label?: string | null; pinned?: boolean; index_opt_in?: boolean },
): Promise<void> {
  return invoke("update_workspace_item", { id, kind, refId, patch });
}
export async function removeWorkspaceItem(id: string, kind: WorkspaceItemKind, refId: string): Promise<void> {
  return invoke("remove_workspace_item", { id, kind, refId });
}
export async function listLibrary(): Promise<LibraryItem[]> {
  return invoke<LibraryItem[]>("list_library");
}
/** The display path of a file inside a Library folder, checked by the backend (rejects when it is outside the folder or gone). */
export async function getLibraryFilePath(folderId: string, subPath: string): Promise<string> {
  return invoke<string>("get_library_file_path", { folderId, subPath });
}
/** Shows that file in the file manager. The backend decides what may be revealed. */
export async function revealLibraryFile(folderId: string, subPath: string): Promise<void> {
  return invoke("reveal_library_file", { folderId, subPath });
}

/** Deletes every meeting of a workspace in one call; what went and what did not. */
export async function deleteWorkspaceMeetings(id: string): Promise<{ deleted: number; failed: Array<{ id: string; reason: string }> }> {
  return invoke("delete_workspace_meetings", { id });
}
export async function moveMeeting(meetingId: string, workspaceId: string): Promise<void> {
  return invoke("move_meeting", { meetingId, workspaceId });
}
export async function listWorkspaceMeetings(
  id: string,
  query: string | null,
  limit: number,
  offset: number,
): Promise<WorkspaceMeetingPage> {
  return invoke<WorkspaceMeetingPage>("list_workspace_meetings", { id, query, limit, offset });
}
export async function getMeetingScope(meetingId: string): Promise<MeetingScope> {
  return invoke<MeetingScope>("get_meeting_scope", { meetingId });
}
/** Refuses keep-separate combinations with a clear message (the promise rejects with it). */
export async function setMeetingScope(meetingId: string, borrowed: string[]): Promise<MeetingScope> {
  return invoke<MeetingScope>("set_meeting_scope", { meetingId, borrowed });
}
/** Saves Markdown as a document in the workspace; resolves to the document id. */
export async function addWorkspaceText(id: string, title: string, markdown: string): Promise<string> {
  return invoke<string>("add_workspace_text", { id, title, markdown });
}

// == IPC: Workspace search and index ==

export async function searchWorkspace(
  id: string,
  query: string,
  kinds: PassageKind[] | null,
  limit: number,
): Promise<Passage[]> {
  return invoke<Passage[]>("search_workspace", { id, query, kinds, limit });
}
export async function getIndexStatus(id: string): Promise<IndexStatus> {
  return invoke<IndexStatus>("get_index_status", { id });
}
export async function rescanWorkspace(id: string): Promise<void> {
  return invoke("rescan_workspace", { id });
}

// == IPC: Workspace chat ==

export async function listWorkspaceChats(workspaceId: string): Promise<WorkspaceChat[]> {
  return invoke<WorkspaceChat[]>("list_workspace_chats", { workspaceId });
}
export async function createWorkspaceChat(workspaceId: string): Promise<WorkspaceChat> {
  return invoke<WorkspaceChat>("create_workspace_chat", { workspaceId });
}
export async function updateWorkspaceChat(id: string, patch: WorkspaceChatPatch): Promise<WorkspaceChat> {
  return invoke<WorkspaceChat>("update_workspace_chat", { id, patch });
}
export async function deleteWorkspaceChat(id: string): Promise<void> {
  return invoke("delete_workspace_chat", { id });
}
export async function listWorkspaceMessages(chatId: string): Promise<WorkspaceMessage[]> {
  return invoke<WorkspaceMessage[]>("list_workspace_messages", { chatId });
}
/** `chatId` null = the workspace default for new chats. */
export async function setChatMeetingIncluded(
  workspaceId: string,
  chatId: string | null,
  meetingId: string,
  included: boolean,
): Promise<void> {
  return invoke("set_chat_meeting_included", { workspaceId, chatId, meetingId, included });
}
/** Which meetings this chat leaves out (the saved truth; the pane also keeps a local mirror). */
export async function listChatMeetingPrefs(workspaceId: string, chatId: string): Promise<ChatMeetingPref[]> {
  return invoke<ChatMeetingPref[]>("list_chat_meeting_prefs", { workspaceId, chatId });
}
/** `kind` and `refId` are the two first parts of a `ContextBar.id` ("<kind>:<ref>[:<sub>]"). */
export async function setChatItemPref(chatId: string, kind: string, refId: string, pref: ChatItemPrefValue): Promise<void> {
  return invoke("set_chat_item_pref", { chatId, kind, refId, pref });
}
/** Pins and exclusions saved for this chat, so the context panel shows them after a reload. */
export async function listChatItemPrefs(chatId: string): Promise<ItemPref[]> {
  return invoke<ItemPref[]>("list_chat_item_prefs", { chatId });
}
/** What this chat's model can use now; `tools_off` says which tools are off and why. */
export async function getChatCapabilities(chatId: string): Promise<ChatCapabilities> {
  return invoke<ChatCapabilities>("get_chat_capabilities", { chatId });
}
/** The estimate shown before sending. */
export async function previewChatContext(chatId: string, question?: string): Promise<ContextReport> {
  return invoke<ContextReport>("preview_chat_context", { chatId, question });
}
/** Resolves once the answer is saved; `deeper` re-asks with the deep budget ("Search deeper"). */
export async function askWorkspace(
  chatId: string,
  question: string,
  requestId: string,
  deeper = false,
): Promise<void> {
  return invoke("ask_workspace", { chatId, question, requestId, deeper });
}
export async function cancelWorkspaceRequest(requestId: string): Promise<void> {
  return invoke("cancel_workspace_request", { requestId });
}
export async function saveAnswerToLibrary(messageId: number, title: string): Promise<string> {
  return invoke<string>("save_answer_to_library", { messageId, title });
}
export async function answerWorkspaceApproval(approvalId: string, allow: boolean): Promise<void> {
  return invoke("answer_workspace_approval", { approvalId, allow });
}

// == IPC: Live notes ==

export async function getMeetingNotes(meetingId: string): Promise<NoteDoc | null> {
  return invoke<NoteDoc | null>("get_meeting_notes", { meetingId });
}
export async function saveMeetingNotesEdit(meetingId: string, edit: NoteEdit): Promise<NoteDoc> {
  return invoke<NoteDoc>("save_meeting_notes_edit", { meetingId, edit });
}
export async function notetakerStart(meetingId: string): Promise<void> {
  return invoke("notetaker_start", { meetingId });
}
export async function notetakerStop(meetingId: string): Promise<void> {
  return invoke("notetaker_stop", { meetingId });
}
export async function notetakerUpdateNow(meetingId: string): Promise<void> {
  return invoke("notetaker_update_now", { meetingId });
}
/** "Keep going": adds the same amount to the cap. */
export async function notetakerContinue(meetingId: string): Promise<void> {
  return invoke("notetaker_continue", { meetingId });
}
export async function getNotetakerSettings(): Promise<NotetakerSettings> {
  return invoke<NotetakerSettings>("get_notetaker_settings");
}
/** A patch: only the fields present change. Returns the merged settings. */
export async function setNotetakerSettings(patch: Partial<NotetakerSettings>): Promise<NotetakerSettings> {
  return invoke<NotetakerSettings>("set_notetaker_settings", { patch });
}

// == IPC: Brief ==

export async function getMeetingBrief(meetingId: string): Promise<BriefSheet | null> {
  return invoke<BriefSheet | null>("get_meeting_brief", { meetingId });
}
export async function briefStart(meetingId: string): Promise<void> {
  return invoke("brief_start", { meetingId });
}
export async function briefStop(meetingId: string): Promise<void> {
  return invoke("brief_stop", { meetingId });
}
export async function briefRefresh(meetingId: string): Promise<void> {
  return invoke("brief_refresh", { meetingId });
}
export async function briefContinue(meetingId: string): Promise<void> {
  return invoke("brief_continue", { meetingId });
}
export async function getBriefSettings(): Promise<BriefSettings> {
  return invoke<BriefSettings>("get_brief_settings");
}
/** A patch: only the fields present change. Returns the merged settings. */
export async function setBriefSettings(patch: Partial<BriefSettings>): Promise<BriefSettings> {
  return invoke<BriefSettings>("set_brief_settings", { patch });
}

// == IPC: Workspace memory ==

export async function getMemorySettings(): Promise<MemorySettings> {
  return invoke<MemorySettings>("get_memory_settings");
}
/** A patch: only the fields present change. Returns the merged settings. */
export async function setMemorySettings(patch: Partial<MemorySettings>): Promise<MemorySettings> {
  return invoke<MemorySettings>("set_memory_settings", { patch });
}

export async function listMemory(workspaceId: string): Promise<MemoryItem[]> {
  return invoke<MemoryItem[]>("list_memory", { workspaceId });
}
/** A new item under a new id; `status` is "saved" when absent (the person typed it). */
export interface MemoryCreate {
  workspace_id: string;
  kind: MemoryItem["kind"];
  title: string;
  text: string;
  source_meeting?: string | null;
  source_ms?: number | null;
  status?: MemoryItem["status"];
}
export async function createMemory(input: MemoryCreate): Promise<MemoryItem> {
  return invoke<MemoryItem>("create_memory", { input });
}
/** Changes an item that exists; a forgotten id rejects with "not_found". */
export async function updateMemory(
  id: string,
  patch: Partial<Pick<MemoryItem, "kind" | "title" | "text" | "status">>,
): Promise<MemoryItem> {
  return invoke<MemoryItem>("update_memory", { id, patch });
}
export async function deleteMemory(id: string): Promise<void> {
  return invoke("delete_memory", { id });
}
/** One AI call proposing up to 8 items (status "suggested"); nothing is saved until resolved. */
export async function suggestMemory(workspaceId: string, meetingId: string): Promise<MemoryItem[]> {
  return invoke<MemoryItem[]>("suggest_memory", { workspaceId, meetingId });
}
export async function resolveMemory(
  id: string,
  action: "save" | "dismiss",
  patch?: Partial<Pick<MemoryItem, "kind" | "title" | "text">>,
): Promise<void> {
  return invoke("resolve_memory", { id, action, patch });
}

// == IPC: Talking points ==

export async function listTalkingPoints(workspaceId: string): Promise<TalkingPoint[]> {
  return invoke<TalkingPoint[]>("list_talking_points", { workspaceId });
}
/** Everything a new note starts with, in one call (nothing is ever on for a moment and then turned off). */
export interface TalkingPointContent {
  doc_json: string;
  markdown: string;
  plain_text: string;
  in_context: boolean;
}
/** Creates a note in one atomic call, with the AI-context flag explicit. */
export async function createTalkingPoint(workspaceId: string, title: string, content: TalkingPointContent): Promise<TalkingPoint> {
  return invoke<TalkingPoint>("create_talking_point", { workspaceId, title, content });
}
/**
 * Changes only the fields given. With `expectedUpdatedAt` the backend refuses ("conflict")
 * when the note changed since; a note deleted elsewhere is refused with "not_found".
 */
export async function patchTalkingPoint(
  id: string,
  patch: TalkingPointPatch,
  expectedUpdatedAt?: number,
): Promise<TalkingPoint> {
  return invoke<TalkingPoint>("patch_talking_point", { id, patch, expectedUpdatedAt });
}
export async function deleteTalkingPoint(id: string): Promise<void> {
  return invoke("delete_talking_point", { id });
}
export async function copyTalkingPoint(id: string, workspaceId: string): Promise<TalkingPoint> {
  return invoke<TalkingPoint>("copy_talking_point", { id, workspaceId });
}
export async function reorderTalkingPoints(workspaceId: string, ids: string[]): Promise<void> {
  return invoke("reorder_talking_points", { workspaceId, ids });
}
export async function getPointProgress(meetingId: string, pointId: string): Promise<PointProgress | null> {
  return invoke<PointProgress | null>("get_point_progress", { meetingId, pointId });
}
export async function savePointProgress(meetingId: string, pointId: string, said: PointSaid[]): Promise<void> {
  return invoke("save_point_progress", { meetingId, pointId, said });
}
/** The "only this meeting" copy of a note's document (TipTap JSON text), or null. */
export async function getMeetingPointEdit(meetingId: string, pointId: string): Promise<string | null> {
  return invoke<string | null>("get_meeting_point_edit", { meetingId, pointId });
}
/** `doc` null removes the meeting-only copy. */
export async function saveMeetingPointEdit(
  meetingId: string,
  pointId: string,
  doc: string | null,
): Promise<void> {
  return invoke("save_meeting_point_edit", { meetingId, pointId, doc });
}
