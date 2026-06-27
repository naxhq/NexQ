// ============================================================================
// NexQ TypeScript Types — Single source of truth
// All types mirror Rust structs. Other sub-PRDs IMPORT from here only.
// ============================================================================

// == AUDIO TYPES ==

export type AudioSource = "Mic" | "System" | "Room";

// == MEETING MODE TYPES ==

export type AudioMode = "online" | "in_person";
export type AIScenario = "team_meeting" | "lecture" | "interview" | "webinar" | "oral_exam" | "custom";
export type SpeakerSource = "fixed" | "diarization" | "room";

export interface AudioDevice {
  id: string;
  name: string;
  is_input: boolean;
  is_default: boolean;
}

export interface AudioDeviceList {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

export interface AudioLevel {
  source: AudioSource;
  level: number;
  peak: number;
}

export interface IpolicyStatus {
  active: boolean;
  was_drifted: boolean;
  current_device?: string;
}

// == TRANSCRIPT TYPES ==

export interface TranscriptSegment {
  id: string;
  text: string;
  speaker: Speaker;
  speaker_id?: string;
  timestamp_ms: number;
  is_final: boolean;
  confidence: number;
}

export type Speaker = "User" | "Interviewer" | "Them" | "Unknown";

// == MEETING TYPES ==

export interface Meeting {
  id: string;
  title: string;
  start_time: string; // ISO 8601
  end_time: string | null;
  duration_seconds: number | null;
  transcript: TranscriptSegment[];
  ai_interactions: AIInteraction[];
  summary: string | null;
  config_snapshot: MeetingConfig | null;
  audio_mode?: AudioMode;
  ai_scenario?: AIScenario;
  speakers?: SpeakerIdentity[];
  bookmarks?: MeetingBookmark[];
  topic_sections?: TopicSection[];
  action_items?: ActionItem[];
  noise_preset?: string;
}

export interface RecordingInfo {
  path: string;
  size_bytes: number;
  duration_ms: number;
  waveform_path: string;
  offset_ms: number;
  waveform_data?: WaveformData | null;
}

export interface WaveformData {
  sample_rate: number;
  duration_ms: number;
  peaks: [number, number][];
}

export interface MeetingConfig {
  stt_provider: string;
  llm_provider: string;
  llm_model: string;
  recording_enabled: boolean;
}

export interface MeetingSummary {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number | null;
  segment_count: number;
  has_summary: boolean;
  audio_mode?: AudioMode;
  ai_scenario?: AIScenario;
  speaker_count?: number;
}

// == SPEAKER TYPES ==

export interface SpeakerIdentity {
  id: string;
  display_name: string;
  source: SpeakerSource;
  color?: string;
  stats: SpeakerStats;
}

export interface SpeakerStats {
  segment_count: number;
  word_count: number;
  talk_time_ms: number;
  last_spoke_ms: number;
}

// == MEETING FEATURE TYPES ==

export interface MeetingBookmark {
  id: string;
  timestamp_ms: number;
  segment_id?: string;   // Optional anchor to a specific transcript segment
  note?: string;
  created_at: string;
}

export interface TopicSection {
  id: string;
  title: string;
  start_ms: number;
  end_ms?: number;
}

export interface ActionItem {
  id: string;
  text: string;
  assignee_speaker_id?: string;
  timestamp_ms: number;
  completed: boolean;
}

// == SCENARIO TYPES ==

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  summary_prompt: string;
  question_detection_prompt: string;
  is_custom: boolean;
}

export interface NoisePreset {
  id: string;
  name: string;
  vad_sensitivity: number;
  noise_gate_db: number;
  description: string;
}

// == AI/LLM TYPES ==

export interface AIInteraction {
  id: string;
  meeting_id: string;
  mode: IntelligenceMode;
  question_context: string;
  response: string;
  model: string;
  provider: string;
  latency_ms: number;
  timestamp: string;
}

export type IntelligenceMode =
  | "Assist"
  | "WhatToSay"
  | "Shorten"
  | "FollowUp"
  | "Recap"
  | "AskQuestion"
  | "MeetingSummary"
  | "ActionItemsExtraction"
  | "BookmarkSuggestions";

export interface StreamSource {
  title: string;
  url: string;
}

export interface AIResponse {
  id: string;
  content: string;
  mode: IntelligenceMode;
  timestamp: number;
  pinned: boolean;
  model: string;
  provider: string;
  latency_ms: number;
  sources?: StreamSource[];
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  context_window: number | null;
}

// == OPENROUTER ENRICHED MODEL ==

export interface OpenRouterModelPricing {
  prompt: number;              // USD per 1M tokens
  completion: number;
  image?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  provider_name: string;
  description: string;
  created: number;
  context_length: number | null;
  max_completion_tokens: number | null;
  pricing: OpenRouterModelPricing;
  is_free: boolean;
  modality: string;
  input_modalities: string[];
  output_modalities: string[];
  tokenizer: string;
  supports_tools: boolean;
  supports_reasoning: boolean;
  supports_web_search: boolean;
}

export interface CompletionStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
}

// == LLM PROVIDER TYPES ==

export type LLMProviderType =
  | "ollama"
  | "lm_studio"
  | "openai"
  | "anthropic"
  | "groq"
  | "gemini"
  | "openrouter"
  | "custom";

export interface LLMProviderConfig {
  type: LLMProviderType;
  name: string;
  base_url: string;
  requires_api_key: boolean;
  is_local: boolean;
}

// == DEEPGRAM CONFIG ==

export interface DeepgramConfig {
  /** Model: "nova-3" | "nova-2" | "nova" | "enhanced" | "base" | "whisper-large" | etc. */
  model: string;
  smart_format: boolean;
  interim_results: boolean;
  /** Endpointing silence threshold in ms (10–5000). null = disabled. */
  endpointing: number | null;
  punctuate: boolean;
  diarize: boolean;
  profanity_filter: boolean;
  numerals: boolean;
  dictation: boolean;
  vad_events: boolean;
  keyterms: string[];
}

// == GROQ CONFIG ==

export interface GroqConfig {
  /** Model ID: "whisper-large-v3" | "whisper-large-v3-turbo" */
  model: string;
  /** ISO 639-1 language code. Empty = auto-detect. */
  language: string;
  /** Sampling temperature (0.0–1.0). 0 = deterministic. */
  temperature: number;
  /** Response format: "json" | "verbose_json" | "text" */
  response_format: string;
  /** Timestamp granularities: ["segment"] | ["word"] | ["segment","word"] */
  timestamp_granularities: string[];
  /** Optional prompt to guide style/spelling (up to 224 tokens). */
  prompt: string;
  /** Batch segment duration in seconds (how much audio to accumulate). */
  segment_duration_secs: number;
}

// == STT PROVIDER TYPES ==

export type STTProviderType =
  | "whisper_cpp"
  | "deepgram"
  | "whisper_api"
  | "azure_speech"
  | "groq_whisper"
  | "web_speech"
  | "sherpa_onnx"
  | "ort_streaming"
  | "windows_native"
  | "parakeet_tdt";

// == LOCAL STT ENGINE TYPES ==

export type LocalSTTEngine = "whisper_cpp" | "sherpa_onnx" | "ort_streaming" | "parakeet_tdt" | "moonshine";

export interface LocalSTTModelInfo {
  id: string;
  engine: string;
  name: string;
  size_bytes: number;
  accuracy_rating: number;
  speed_rating: number;
  is_streaming: boolean;
  is_downloaded: boolean;
}

export interface LocalSTTEngineInfo {
  engine: string;
  name: string;
  description: string;
  models: LocalSTTModelInfo[];
}

export interface WhisperDualPassConfig {
  shortChunkSecs: number;
  longChunkSecs: number;
  pauseSecs: number;
}

export interface ModelDownloadProgress {
  engine: string;
  model_id: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  status: "downloading" | "verifying" | "extracting" | "complete" | "error" | "cancelled";
}

export interface STTProviderConfig {
  type: STTProviderType;
  name: string;
  requires_api_key: boolean;
  is_local: boolean;
}

// == TWO-PARTY AUDIO MODEL ==

export type PartyRole = "You" | "Them";

export interface PartyAudioConfig {
  role: PartyRole;
  device_id: string;
  is_input_device: boolean;
  stt_provider: STTProviderType;
  local_model_id?: string;
}

export interface MeetingAudioConfig {
  you: PartyAudioConfig;
  them: PartyAudioConfig;
  recording_enabled: boolean;
  preset_name: string | null;
  audio_mode?: AudioMode;
  noise_preset?: string;
}

export interface AudioSessionInfo {
  pid: number;
  process_name: string;
  display_name: string;
  device_name: string;
  is_active: boolean;
}

// == CONTEXT TYPES ==

export interface ContextResource {
  id: string;
  name: string;
  file_type: ContextFileType;
  file_path: string;
  size_bytes: number;
  token_count: number;
  preview: string;
  loaded_at: string;
  chunk_count?: number;
  index_status?: string;
  last_indexed_at?: string;
}

export type ContextFileType = "pdf" | "txt" | "md" | "docx";

export interface TokenBudget {
  total: number;
  limit: number;
  segments: TokenBudgetSegment[];
}

export interface TokenBudgetSegment {
  label: string;
  tokens: number;
  color: string;
  category: "resume" | "jd" | "notes" | "transcript" | "system" | "headroom";
}

// == QUESTION DETECTION ==

export interface DetectedQuestion {
  text: string;
  confidence: number;
  timestamp_ms: number;
  source: Speaker;
}

// == CONFIG TYPES ==

export type ThemeMode = "dark" | "light" | "system";

export interface AppConfig {
  theme: ThemeMode;
  stt_provider: STTProviderType;
  llm_provider: LLMProviderType;
  llm_model: string;
  mic_device_id: string | null;
  system_device_id: string | null;
  recording_enabled: boolean;
  auto_trigger: boolean;
  auto_summary: boolean;
  context_window_seconds: number;
  start_on_login: boolean;
  data_directory: string;
  first_run_completed: boolean;
  hotkeys: HotkeyConfig;
}

export interface HotkeyConfig {
  toggle_assist: string;
  start_end_meeting: string;
  show_hide: string;
  open_settings: string;
  escape: string;
  mode_assist: string;
  mode_say: string;
  mode_shorten: string;
  mode_followup: string;
  mode_recap: string;
  mode_ask: string;
}

// == APP STATE TYPES ==

export type AppView = "launcher" | "overlay" | "wizard" | "settings";

export interface StreamState {
  isStreaming: boolean;
  currentContent: string;
  currentMode: IntelligenceMode | null;
  error: string | null;
  latency_ms: number | null;
}

// == IPC EVENT PAYLOAD TYPES ==

export interface TranscriptUpdateEvent {
  segment: TranscriptSegment;
}

export interface StreamTokenEvent {
  token: string;
}

export interface StreamStartEvent {
  mode: IntelligenceMode;
  model: string;
  provider: string;
  system_prompt: string;
  user_prompt: string;
  include_transcript: boolean;
  include_rag: boolean;
  include_instructions: boolean;
  include_question: boolean;
  // Enriched metadata
  temperature: number;
  rag_query: string | null;
  rag_chunks: RagChunkInfo[];
  rag_chunks_filtered: number;
  rag_total_candidates: number;
  transcript_window_seconds: number;
  transcript_segments_count: number;
  transcript_segments_total: number;
}

export interface StreamEndEvent {
  total_tokens: number;
  latency_ms: number;
}

export interface StreamSourcesEvent {
  sources: StreamSource[];
}

export type QuestionDetectedEvent = DetectedQuestion;

export interface AudioLevelEvent {
  source: AudioSource;
  level: number;
  peak: number;
}

// == AI CALL LOG TYPES ==

export type LogEntryStatus =
  | "sending"
  | "streaming"
  | "complete"
  | "error"
  | "cancelled";

export type LogFilterKind = IntelligenceMode | "all" | "errors";

export interface LogEntry {
  id: string;
  timestamp: number;
  mode: IntelligenceMode;
  provider: string;
  model: string;
  status: LogEntryStatus;
  // Lifecycle timestamps
  startedAt: number;
  firstTokenAt: number | null;
  completedAt: number | null;
  // Token accounting
  totalTokens: number | null;
  latencyMs: number | null;
  // Content
  responseContent: string;
  responseContentClean: string;
  // Actual prompt data (from backend stream start event)
  actualSystemPrompt: string;
  actualUserPrompt: string;
  // Context source flags (from backend)
  includeTranscript: boolean;
  includeRag: boolean;
  includeInstructions: boolean;
  includeQuestion: boolean;
  // Enriched metadata (from StreamStartEvent)
  temperature: number | null;
  ragQuery: string | null;
  ragChunks: RagChunkInfo[];
  ragChunksFiltered: number;
  ragTotalCandidates: number;
  transcriptWindowSeconds: number | null;
  transcriptSegmentsCount: number | null;
  transcriptSegmentsTotal: number | null;
  // Legacy fields (kept for backward compat, empty for new entries)
  snapshotTranscript: string;
  snapshotContext: string;
  reconstructedSystemPrompt: string;
  // Error
  errorMessage: string | null;
}

// == RAG / CONTEXT INTELLIGENCE TYPES ==

export type ContextStrategy = "stuffing" | "local_rag" | "gemini_cache";

export interface RagConfig {
  enabled: boolean;
  embedding_model: string;
  ollama_url: string;
  batch_size: number;
  chunk_size: number;
  chunk_overlap: number;
  splitting_strategy: string;
  top_k: number;
  search_mode: string;
  similarity_threshold: number;
  semantic_weight: number;
  include_transcript: boolean;
  embedding_dimensions: number;
}

export interface RagIndexStatus {
  total_files: number;
  indexed_files: number;
  total_chunks: number;
  total_tokens: number;
  last_indexed_at: string | null;
}

export interface RagSearchResult {
  chunk_id: string;
  text: string;
  score: number;
  normalized_score: number;
  source_file: string;
  chunk_index: number;
  source_type: string;
}

export interface RagChunkInfo {
  source: string;
  chunk_index: number;
  text: string;
  normalized_score: number;
  raw_score: number;
}

export interface OllamaEmbeddingStatus {
  connected: boolean;
  models: string[];
}

export interface RagIndexProgressEvent {
  file_id?: string;
  file_name?: string;
  chunks_done?: number;
  chunks_total?: number;
  files_done?: number;
  files_total?: number;
  status: string;
}

export interface OllamaPullProgressEvent {
  status: string;
  total: number;
  completed: number;
}

export interface TranscriptIndexedEvent {
  chunks_added: number;
}

// == AI ACTION CONFIG TYPES ==

export interface ActionConfig {
  id: string;
  name: string;
  mode: string;
  visible: boolean;
  systemPrompt: string;
  isDefaultPrompt: boolean;

  includeTranscript: boolean;
  includeRagChunks: boolean;
  includeCustomInstructions: boolean;
  includeDetectedQuestion: boolean;
  webSearch: boolean;

  transcriptWindowSeconds: number | null; // null = use global default
  ragTopK: number | null;
  temperature: number | null;

  isBuiltIn: boolean;
}

export interface GlobalDefaults {
  transcriptWindowSeconds: number;
  temperature: number;
  autoTrigger: boolean;
}

export interface InstructionPresets {
  tone: string | null;
  format: string | null;
  length: string | null;
  opinion: string | null;
}

export interface AllActionConfigs {
  globalDefaults: GlobalDefaults;
  customInstructions: string;
  instructionPresets: InstructionPresets;
  actions: Record<string, ActionConfig>;
}

// == STT CONNECTION STATUS ==

export interface STTConnectionStatusEvent {
  provider: string;
  party: string;
  status: "connecting" | "connected" | "error" | "disconnected" | "reconnecting";
  message?: string;
}

// == Translation ==

export type TranslationProviderType = "microsoft" | "google" | "deepl" | "opus-mt" | "llm";

export type TranslationDisplayMode = "inline" | "hover";

export interface TranslationResult {
  segment_id?: string;
  original_text: string;
  translated_text: string;
  source_lang: string;
  target_lang: string;
  provider: string;
}

export interface TranslationLanguage {
  code: string;
  name: string;
  native_name?: string;
}

export interface TranslationConnectionStatus {
  connected: boolean;
  language_count: number;
  response_ms: number;
  error?: string;
}

export interface BatchTranslationProgress {
  meetingId: string;
  completed: number;
  total: number;
  targetLang: string;
}

export interface TranslationConfig {
  provider: TranslationProviderType;
  targetLang: string;
  sourceLang: string;
  displayMode: TranslationDisplayMode;
  autoTranslateEnabled: boolean;
  selectionToolbarEnabled: boolean;
  cacheEnabled: boolean;
}

// == OPUS-MT Models ==

export interface OpusMtModelDefinition {
  model_id: string;
  display_name: string;
  source_lang: string;
  source_name: string;
  target_lang: string;
  target_name: string;
  size_bytes: number;
  encoder_url: string;
  decoder_url: string;
  tokenizer_url: string;
  config_url: string;
  quality_rating: number;
  target_prefix: string;
}

export interface OpusMtModelStatus {
  definition: OpusMtModelDefinition;
  is_downloaded: boolean;
  is_active: boolean;
}

// == TRAY TYPES ==

export type TrayState = "idle" | "recording" | "muted" | "stealth" | "ai_processing" | "indexing";

export interface RecentMeeting {
  id: string;
  title: string;
  startTime: string;
  duration: number;
}

// == UPDATER TYPES ==

export interface UpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
}

export interface UpdateDownloadProgress {
  chunk_length: number;
  content_length: number | null;
}

export interface UpdateReadyEvent {
  version: string;
}
