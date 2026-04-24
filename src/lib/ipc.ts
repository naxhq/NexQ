// ============================================================================
// NexQ IPC — Typed invoke() wrappers for all Tauri commands
// Each sub-PRD fills its section. Stubs return placeholder data.
// ============================================================================

import { invoke } from "@tauri-apps/api/core";
import type {
  AllActionConfigs,
  AudioDeviceList,
  AudioSessionInfo,
  ContextResource,
  DeepgramConfig,
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

export async function stopCapture(): Promise<void> {
  return invoke("stop_capture");
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
  themConfig: PartyAudioConfig
): Promise<void> {
  return invoke("start_capture_per_party", {
    youConfig: JSON.stringify(youConfig),
    themConfig: JSON.stringify(themConfig),
  });
}

/** Mute or unmute a specific audio source's STT feed. Audio levels + recording continue. */
export async function setSourceMuted(source: "you" | "them", muted: boolean): Promise<void> {
  return invoke("set_source_muted", { source, muted });
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

export async function generateAssist(mode: string, customQuestion?: string): Promise<void> {
  // Universal transcript: gather all final segments from the frontend store
  // (the single source of truth — every STT engine feeds into it).
  // The backend applies the per-action transcript window setting.
  const { useTranscriptStore } = await import("../stores/transcriptStore");
  const segments = useTranscriptStore.getState().segments
    .filter(s => s.is_final)
    .map(s => ({ text: s.text, speaker: s.speaker, timestamp_ms: s.timestamp_ms }));

  return invoke("generate_assist", {
    mode,
    customQuestion,
    transcriptSegments: JSON.stringify(segments),
  });
}

export async function cancelGeneration(): Promise<void> {
  return invoke("cancel_generation");
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
  filePath: string
): Promise<ContextResource> {
  const result = await invoke<string>("load_context_file", { filePath });
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
  title?: string
): Promise<Meeting> {
  const result = await invoke<string>("start_meeting", { title });
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
  llmModel?: string
): Promise<void> {
  return invoke("test_rag_answer", { query, llmProvider, llmModel });
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

export async function setStealthMode(enabled: boolean): Promise<void> {
  return invoke("set_stealth_mode", { enabled });
}

// == IPC: Updater ==

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("check_for_update");
}

export async function downloadAndInstallUpdate(): Promise<void> {
  return invoke("download_and_install_update");
}

export async function restartForUpdate(): Promise<void> {
  return invoke("restart_for_update");
}
