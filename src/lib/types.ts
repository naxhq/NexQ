// ============================================================================
// NexQ TypeScript Types — Single source of truth
// All types mirror Rust structs. Other sub-PRDs IMPORT from here only.
// ============================================================================

// == AUDIO TYPES ==

export type AudioSource = "Mic" | "System" | "Room";

// == MEETING MODE TYPES ==

export type AudioMode = "online" | "in_person";
export type AIScenario = "team_meeting" | "lecture" | "interview" | "webinar" | "oral_exam" | "custom" | `custom_${string}`;
/** "remote_tag": a person on the other side of an online call (id `them:S1`). */
export type SpeakerSource = "fixed" | "diarization" | "room" | "remote_tag";

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
  /**
   * Diarization tag of the line's speaker ("S1", "S2"...). On a remote-party
   * line of an online meeting, `speaker` stays "Them" and the tag tells the
   * people on the other side apart (named via `them:<tag>` speakers).
   */
  speaker_tag?: string;
  timestamp_ms: number;
  is_final: boolean;
  confidence: number;
  /**
   * Frontend only (never saved): while interim words extend a final line,
   * this is the displayed text. AI requests may snapshot it as interim;
   * `text` keeps the finalized words for persistence.
   */
  pending_text?: string;
  /**
   * Live events only (never saved): the STT provider's own turn detection
   * (Cartesia, Deepgram Flux). "eager_end": the speaker has probably
   * finished; "resumed": they kept talking after that; "end": they finished.
   * Absent for providers without turn detection.
   */
  turn?: TurnSignal;
}

/** Mirrors `TurnSignal` in src-tauri/src/stt/provider.rs. */
export type TurnSignal = "eager_end" | "resumed" | "end";

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
  /** Home workspace of the meeting ("general" when absent). */
  workspace_id?: string;
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
  /** Home workspace ("general" when absent). */
  workspace_id?: string;
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

/** Mirrors Rust `MeetingChatMessage`: one saved "Ask this meeting" message. */
export interface MeetingChatMessage {
  id: string;
  meeting_id: string;
  role: "user" | "assistant";
  content: string;
  /** The model that answered (assistant rows). */
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Unix milliseconds. */
  created_at: number;
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
  | "BookmarkSuggestions"
  | "MeetingAsk";

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
  /** Click → last token, measured in the UI (ms). */
  total_ms?: number;
  /** Click → first visible words (ms). */
  first_token_ms?: number;
  /** The transcript scope the answer was asked with, when not the default. */
  scope_label?: string | null;
  /** Notes and tools the answer used, shown as chips at its end (see `SourceChip`). */
  source_chips?: SourceChip[];
  /** Why sources were not used, or only partly, shown with the answer. */
  source_notices?: string[];
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
  | "custom"
  | "claude_cli"
  | "antigravity_cli"
  | "codex_cli";

/**
 * How much a provider's model thinks before answering. "auto" sends nothing
 * (the provider's own default); the others map to each API's own parameter.
 */
export type ThinkingSetting = "auto" | "off" | "low" | "high";

/** Auth mode for a user-supplied (custom) LLM endpoint. */
export type CustomLlmAuthType = "none" | "bearer" | "api_key";

export interface LLMProviderConfig {
  type: LLMProviderType;
  name: string;
  base_url: string;
  requires_api_key: boolean;
  is_local: boolean;
}

// == CLI AGENT (SUBSCRIPTION) TYPES: Claude, Antigravity, Codex ==

/** The CLI agent providers; serialised as the provider id (Rust `CliAgentKind`). */
export type CliAgentKind = "claude_cli" | "antigravity_cli" | "codex_cli";

/**
 * Mirrors Rust `ClaudeAuthStatus`: the account of a CLI agent. For Claude the
 * output of `claude auth status`; for Codex `auth_method` is "chatgpt" or
 * "api_key" and `subscription_type` the ChatGPT plan; Antigravity reports
 * "google" with no email or plan.
 */
export interface ClaudeAuthStatus {
  logged_in: boolean;
  auth_method: string;
  subscription_type: string | null;
  email: string | null;
  /** How the login is billed: only a claude.ai login with a plan uses the subscription. */
  login: ClaudeLogin;
}

/** Mirrors Rust `ClaudeLogin`. */
export type ClaudeLogin = "logged_out" | "subscription" | "api_billed";

/** Mirrors Rust `ClaudeCliStatus` (`claude_cli_status` command). */
export interface ClaudeCliStatus {
  installed: boolean;
  binary_path: string | null;
  /** null when not installed or the `--version` probe failed. */
  version: string | null;
  /** null when not installed or the `auth status` probe failed. */
  auth: ClaudeAuthStatus | null;
  /** Not installed, but an npm install (`claude.cmd`) was found: NexQ needs the native installer. */
  npm_only: boolean;
  /**
   * Claude only: the oldest Claude Code NexQ can launch ("2.1.259"), set only
   * when it is installed, its version is known and older than that. null
   * otherwise, and always for Codex and Antigravity.
   */
  required_version: string | null;
}

/**
 * Mirrors Rust `CliAgentStatus` (`cli_agent_status` command): what a CLI agent's
 * installation and login look like. `ClaudeCliStatus` is its Claude shape.
 */
export interface CliAgentStatus extends ClaudeCliStatus {
  kind: CliAgentKind;
}

/**
 * Mirrors Rust `ClaudeCliConfig` (`set_claude_cli_config` / `set_cli_agent_config`):
 * the model settings of one CLI agent. Antigravity ignores the efforts (they are part
 * of its model ids) and both thinking flags; Codex ignores the thinking flags, takes
 * efforts up to "ultra" where its model offers them, and an empty model means "the
 * first one the CLI lists".
 */
export interface ClaudeCliConfig {
  fast_model: string;
  /** "low" | "medium" | "high" | "xhigh" | "max" ("ultra" too for Codex) */
  fast_effort: string;
  deep_model: string;
  deep_effort: string;
  /** Extended thinking on the Fast tier (and utility calls). Off = fastest replies. */
  fast_thinking: boolean;
  /** Extended thinking on the Deep tier. */
  deep_thinking: boolean;
  /** Provider id used when Claude is unavailable; null = no fallback. */
  fallback_provider: string | null;
  /** Model used on the fallback provider; null = its first listed model. */
  fallback_model: string | null;
}

/**
 * Mirrors Rust `ClaudeModelInfo`: one model a CLI agent offers (`claude_cli_models`,
 * `cli_agent_models`). Shared by all three CLI agents: Antigravity lists one entry per
 * model id with no effort; Codex lists its own efforts and `default_effort`.
 */
export interface ClaudeModelInfo {
  /** What `--model` takes: an alias ("sonnet") or a pinned id ("claude-opus-4-8"). */
  value: string;
  /** The model id the value resolves to today. */
  resolved_model: string;
  display_name: string;
  description: string;
  supports_effort: boolean;
  /** Accepted efforts, lowest first; empty without effort support. */
  effort_levels: string[];
  /** The effort the model uses when none is asked for (Codex reports one); absent otherwise. */
  default_effort?: string;
}

/** Mirrors Rust `AgentFallbackPayload` (payload of `agent_fallback`). */
export interface AgentFallbackEvent {
  /** Short reason, e.g. "not logged in", "usage limit reached". */
  reason: string;
  /** Display name of the provider now answering, e.g. "Ollama"; empty when a
   *  usage limit was hit and no fallback provider is configured. */
  provider: string;
}

/** Mirrors Rust `SessionUsage`: cumulative estimate for one session scope. */
export interface SessionUsage {
  /** Uncached prompt tokens. */
  input_tokens: number;
  /** Prompt tokens read from the prompt cache. */
  cache_read_tokens: number;
  /** Prompt tokens written to the prompt cache. */
  cache_write_tokens: number;
  /** Output tokens, thinking included. */
  output_tokens: number;
  /** The part of `output_tokens` spent thinking. */
  thinking_tokens: number;
  cost_usd: number;
  /** Answered requests. */
  requests: number;
  /** Sum of every request's wall time (ms). */
  total_latency_ms: number;
  /** Sum of every request's time to its first words (ms). */
  total_first_token_ms: number;
  last_latency_ms: number;
  /** When the last answered request started (ms since epoch); 0 = none yet. */
  last_request_at_ms: number;
}

/** Mirrors Rust `AgentSessionStatus` (payload of `agent_session_status`). */
export interface AgentSessionStatus {
  scope: "live" | "past" | "utility";
  meeting_id: string | null;
  tier: "fast" | "deep";
  state: "starting" | "ready" | "busy" | "error" | "closed";
  model: string;
  /** Readable reason for `error`. */
  detail: string | null;
  /**
   * Classified cause of `detail`: "rate_limited" | "not_logged_in" |
   * "not_installed" | "outdated" | "context_overflow" | "crashed" | "other".
   * Set with `detail`.
   */
  error_kind: string | null;
  /** The with-sources session (notes folders, MCP tools), not the plain one. */
  with_sources: boolean;
  /**
   * For a running with-sources session that came up without something: the
   * servers that did not start and the sources left out ("Mira didn't start,
   * so its tools aren't available"). `null` when all is in.
   */
  sources_notice: string | null;
  /** Cumulative usage of the whole scope (all tiers). */
  usage: SessionUsage;
}

// == DEEPGRAM CONFIG ==

export interface DeepgramConfig {
  /**
   * Model: "nova-3" | "nova-2" | "nova" | "enhanced" | "base" | "whisper-large" | etc.,
   * or a Flux model ("flux-general-en", "flux-general-multi") with turn detection.
   */
  model: string;
  smart_format: boolean;
  interim_results: boolean;
  /** Endpointing silence threshold in ms (10–5000). null = disabled. */
  endpointing: number | null;
  punctuate: boolean;
  /** Tell remote speakers apart (diarization; only on the remote party / room audio, never the You mic). */
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
  | "azure_mai_streaming"
  | "groq_whisper"
  | "cartesia"
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
  /**
   * Transcription language for this side only (an STT_LANGUAGES value, "auto"
   * included). Absent means the shared transcription language, as in configs
   * saved before this setting.
   */
  language?: string;
}

export interface MeetingAudioConfig {
  you: PartyAudioConfig;
  them: PartyAudioConfig;
  recording_enabled: boolean;
  preset_name: string | null;
  audio_mode?: AudioMode;
  noise_preset?: string;
}

/** Which side of a meeting a capture belongs to (`audio_capture_status`). */
export type CaptureSide = "you" | "them";

/** Rust `CaptureState`: reconnecting, back (maybe on another device), or gone for now (it keeps trying). */
export type CaptureState = "recovering" | "recovered" | "lost";

/**
 * A capture side lost its device mid-meeting and reconnects on its own
 * (Rust `CaptureStatus`, event `audio_capture_status`). `message` is empty
 * when there is nothing to tell the user.
 */
export interface AudioCaptureStatus {
  side: CaptureSide;
  state: CaptureState;
  device: string;
  message: string;
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
  /** `missing` = the file is gone (the row is kept); `loading` = text is still being read. */
  status?: "ready" | "loading" | "missing";
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

/** In-meeting action keys (the global shortcuts are separate settings). */
export interface HotkeyConfig {
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

// Every llm_stream_* payload carries the request_id of the generation it
// belongs to, so listeners only react to their own stream.

export interface StreamTokenEvent {
  token: string;
  request_id: string | null;
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
  request_id: string | null;
  /** The Claude session that answered ("live:<meeting>:fast"...); null on the stateless path. */
  session_key: string | null;
  /** The transcript scope the user picked ("Last 5 min"...); null for the action's default. */
  scope_label: string | null;
}

export interface StreamEndEvent {
  total_tokens: number;
  latency_ms: number;
  request_id: string | null;
  /** True when the user stopped the stream; a normal stop, not an error. */
  cancelled: boolean;
  /** The request's actual token usage, when the provider reported it. */
  usage?: StreamUsage | null;
}

/** Mirrors Rust `StreamUsage`: actual token usage of one request. */
export interface StreamUsage {
  /** Uncached prompt tokens (all prompt tokens for providers without a cache). */
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Output tokens, thinking included. */
  output_tokens: number;
  thinking_tokens: number;
  /** This request's cost estimate, when known. */
  cost_usd: number | null;
  /** From the request's start until its first words (ms), when measured. */
  first_token_ms: number | null;
}

/** Payload of `llm_stream_thinking`: the model is thinking before it answers (once per request). */
export interface StreamThinkingEvent {
  request_id: string | null;
}

export interface StreamErrorEvent {
  message: string;
  request_id: string | null;
}

export interface StreamSourcesEvent {
  sources: StreamSource[];
  request_id: string | null;
}

/** Transcript segment sent with generate_assist. */
export interface AssistTranscriptSegment {
  /**
   * Stable segment id. A Claude session sends each segment once by id, and
   * bookmark suggestions cite it. Missing only for legacy callers.
   */
  id?: string;
  text: string;
  speaker: string;
  timestamp_ms: number;
}

export interface GenerateAssistOptions {
  /** Identifies the stream; defaults to crypto.randomUUID(). */
  requestId?: string;
  /** Segments to use instead of the live transcript store. */
  transcriptSegments?: AssistTranscriptSegment[];
  /** Past meeting this generation belongs to: routes it to that meeting's Claude session. */
  pastMeetingId?: string;
  /** Transcript scope picked by the user; omitted (or `default`) keeps the action's own window. */
  scope?: ResolvedScope | null;
  /** Images pasted into Ask; only a Claude (subscription) answer can use them. */
  images?: ImageAttachment[];
  /**
   * The Notes / Tools pills as they are when the user asks. Leave it out for an
   * automatic answer (Auto-Answer, summaries, action items, bookmark
   * suggestions): those never use sources.
   */
  sources?: SourceToggles;
}

/** One image sent with a question. Mirrors Rust `cli_agent::protocol::ImageAttachment`. */
export interface ImageAttachment {
  /** `image/png`, `image/jpeg`, `image/gif` or `image/webp`. */
  media_type: string;
  /** Base64 of the file, without a `data:` prefix. */
  data: string;
}

// == CONTEXT SCOPE (which part of the meeting a user action focuses on) ==

/** Mirrors Rust `context_scope::ScopeKind`. */
export type ContextScopeKind = "default" | "since_last_any" | "since_last_same" | "minutes" | "all";

/** The scope selected in the overlay picker (persisted in configStore). */
export interface ContextScopeSetting {
  kind: ContextScopeKind;
  /** Minutes for `minutes` (1–120); kept while another kind is selected. */
  minutes: number;
}

/** A scope resolved at request time. Mirrors Rust `context_scope::ResolvedScope`. */
export interface ResolvedScope {
  kind: ContextScopeKind;
  /** Epoch ms of the first segment to focus on (`since_*`, `minutes`). */
  since_ms: number | null;
  minutes?: number;
  label: string;
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
  /** Actual usage from the stream end, when the provider reported it. */
  usage?: StreamUsage | null;
  /** The Claude session that answered ("live:<meeting>:fast"...); null on the stateless path. */
  sessionKey?: string | null;
  /** The transcript scope the user picked ("Last 5 min"...); null for the action default. */
  scopeLabel?: string | null;
  /** Nothing has arrived for a long time; late tokens or the end still revive the entry. */
  stalled?: boolean;
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
  questionDetection: boolean;
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

/** Meeting detection settings (mirrors `MeetingDetectionConfig` in meeting_detect/rules.rs). */
export interface MeetingDetectionConfig {
  enabled: boolean;
  zoom: boolean;
  teams: boolean;
  google_meet: boolean;
  webex: boolean;
  slack: boolean;
  discord: boolean;
  /** Seconds before an unanswered prompt goes away (0 = until the call ends). */
  auto_dismiss_secs: number;
  /** AI scenario for meetings started from the prompt. */
  default_scenario: AIScenario;
  /** Seconds between checks (1–60, default 3). */
  check_interval_secs: number;
}

/** A call in progress in another app (mirrors `DetectedMeeting`). */
export interface DetectedMeeting {
  /** "zoom" | "teams" | "google_meet" | "webex" | "slack" | "discord" */
  app: string;
  app_name: string;
  title: string | null;
}

/** Payload of `meeting_detected` / `get_detected_meeting` (mirrors `MeetingPromptInfo`). */
export interface MeetingPromptInfo {
  meeting: DetectedMeeting;
  auto_dismiss_secs: number;
  default_scenario: AIScenario;
}

/** Mirrors `LogInfo` in log_commands.rs. */
export interface LogInfo {
  /** Folder holding nexq.log and its rotated copies. */
  dir: string;
  /** Full path of the current log file. */
  file: string;
  verbose: boolean;
}

/** Mirrors `StealthSupport` in stealth_commands.rs. */
export interface StealthSupport {
  supported: boolean;
  /** Caveat to show next to the toggle, if any. */
  note: string | null;
}

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

export interface UpdateDownloadFailed {
  message: string;
}

/** Frontend-only event: updater preferences changed in some window. */
export interface UpdaterPrefsChangedEvent {
  autoUpdate: boolean;
  skippedVersion: string | null;
}

/** Frontend-only event: the overlay window took over the active meeting. */
export interface OverlayMeetingReadyEvent {
  meetingId: string;
}

/** Frontend-only event: a window finished `endMeetingFlow`. */
export interface WindowMeetingEndedEvent {
  window: string;
}

// == PERSONAL SOURCES (notes folders + MCP servers) ==
// Mirror `src-tauri/src/sources/config.rs` and `commands/sources_commands.rs`
// field for field. Secret values never live in these: a secret env var or
// header has no value here and sits in Windows Credential Manager.

/** Which sources one answer may use: the two overlay pills. */
export interface SourceToggles {
  notes: boolean;
  tools: boolean;
}

export interface NotesFolder {
  id: string;
  label: string;
  path: string;
  enabled: boolean;
}

export type McpTransport =
  | { type: "stdio"; command: string; args: string[] }
  | { type: "http"; url: string; header_names: string[] };

export interface EnvVar {
  name: string;
  /** `null` exactly when `secret`. */
  value: string | null;
  secret: boolean;
}

export interface McpTool {
  /** The server's own tool name, e.g. `kb_search`. */
  name: string;
  /** `mcp__<key>__<name>`. */
  full_name: string;
  allowed: boolean;
  /** The server marks the tool read-only (it may then run without asking). */
  read_only_hint?: boolean;
  /** The server marks the tool as one that can destroy or overwrite things. */
  destructive_hint?: boolean;
}

export interface McpCheckStatus {
  ok: boolean;
  tool_count: number;
  error: string | null;
  checked_at_ms: number;
}

export interface McpServer {
  id: string;
  /** Fixed at creation: the server's name in the generated mcp-config. */
  key: string;
  label: string;
  transport: McpTransport;
  enabled: boolean;
  env: EnvVar[];
  tools: McpTool[];
  last_check: McpCheckStatus | null;
  needs_sign_in: boolean;
}

export interface PersonalSourcesConfig {
  notes_folders: NotesFolder[];
  mcp_servers: McpServer[];
  /** The one-time note about tool permissions was shown. */
  mcp_notice_seen: boolean;
}

export interface NotesFolderInfo {
  exists: boolean;
  md_count: number;
  /** The walk stopped at its entry limit: `md_count` is a lower bound. */
  truncated: boolean;
  /** Why this folder can't be a notes folder (a whole drive, NexQ's private files, the user's home). */
  problem: string | null;
}

/** One name/value row of the server form (an env var or an HTTP header). */
export interface FormPair {
  name: string;
  /** A secret left blank on an existing server keeps its saved value. */
  value: string;
}

export interface McpServerForm {
  /** `null` for a new server. */
  id: string | null;
  /** The existing server's key; `null` for a new server. */
  key: string | null;
  label: string;
  /** For HTTP only the `url` is read: header names come from `headers`. */
  transport: McpTransport;
  env: FormPair[];
  headers: FormPair[];
}

/** A server in Claude Code's own config, for the import picker. */
export interface ClaudeCodeMcpServer {
  name: string;
  /** `node s.js`, or the URL. */
  summary: string;
  /** `"stdio"` | `"http"`; `"unsupported"` when it can't be imported. */
  transport: string;
  /** An OAuth server Claude Code signs in to itself: imported off. */
  needs_sign_in: boolean;
  /** Why it can't be imported at all (SSE, a malformed entry). */
  unsupported: string | null;
}

/** Mirrors Rust `sources::activity::SourceKind`. */
export type SourceKind = "notes" | "tool" | "notice";

/** A source an answer used, shown as a chip at its end. */
export interface SourceChip {
  kind: SourceKind;
  label: string;
  /** The full path of a note, so the chip can open it (`openSourceFile`). */
  path: string | null;
}

/** One line about the sources while an answer streams, with the chip it leaves. */
export interface SourceActivity {
  kind: SourceKind;
  label: string;
  chip: SourceChip | null;
  /** Only the chip is new: the tool call it belongs to ended well. No line of its own. */
  chip_only?: boolean;
}

/**
 * `llm_stream_activity`: an activity line of the answer `request_id`. It can
 * arrive before that answer's `llm_stream_start` (a notice that the sources
 * could not be used), so hold it by request id.
 */
export interface StreamActivityEvent {
  request_id: string | null;
  activity: SourceActivity;
}

// ============================================================================
// Workspaces (mirrors Rust `workspace/types.rs`; spec 2026-11-24-workspaces-design.md)
// Timestamps are Unix epoch milliseconds unless a field says otherwise.
// ============================================================================

/** What a workspace points at in the library. */
export type WorkspaceItemKind = "document" | "folder" | "server";

/** Library row health: `missing` = file gone (row is kept), `off` = switched off globally in Settings. */
export type LibraryStatus = "ready" | "indexing" | "missing" | "off" | "error";

/** A workspace in the rail: counts and last activity included. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  /** Optional emoji or icon key; the voiceprint is the real mark. */
  icon: string | null;
  /** One of the `WORKSPACE_HUES` ids (src/ui/hues), null = neutral. */
  color: string | null;
  description: string;
  include_general: boolean;
  keep_separate: boolean;
  default_scenario: AIScenario | null;
  /** The workspace new meetings start in (exactly one). */
  is_default: boolean;
  pinned: boolean;
  archived: boolean;
  sort: number;
  meeting_count: number;
  chat_count: number;
  item_count: number;
  /** Newest meeting, chat or edit; null when empty. */
  last_activity: number | null;
  created_at: number;
  updated_at: number;
}

/** One library entry as a workspace sees it (name, health and size resolved). */
export interface WorkspaceItem {
  workspace_id: string;
  kind: WorkspaceItemKind;
  ref_id: string;
  /** User label override; null = use `name`. */
  label: string | null;
  /** Resolved display name (file name, folder path, server name). */
  name: string;
  pinned: boolean;
  status: LibraryStatus;
  /** Why it is missing/off/errored, for the row's second line. */
  detail: string | null;
  tokens: number | null;
  /** Folders only: the user allowed indexing the folder text. */
  index_opt_in?: boolean;
  added_at: number;
}

/** A workspace with everything its settings and Library panel need. */
export interface WorkspaceDetail extends WorkspaceSummary {
  /** Added to the AI instructions after the custom instructions. */
  instructions: string;
  /** "Prepare recaps with AI" (off by default). */
  recaps_with_ai: boolean;
  /** "Suggest after meetings" for memory (off by default). */
  suggest_memory: boolean;
  /** The live brief runs in this workspace's meetings (off by default). */
  brief_enabled?: boolean;
  items: WorkspaceItem[];
}

export interface WorkspaceInput {
  /** Client-made UUID so the mark shown while creating is the real one (the backend makes one when absent). */
  id?: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  description?: string;
  instructions?: string;
  /** New workspaces start with false. */
  include_general?: boolean;
  keep_separate?: boolean;
  default_scenario?: AIScenario | null;
}

export type WorkspacePatch = Partial<WorkspaceInput> & {
  pinned?: boolean;
  recaps_with_ai?: boolean;
  suggest_memory?: boolean;
  brief_enabled?: boolean;
};

/** Deleting a workspace: move its meetings, chats and talking points to General, or delete them. */
export type DeleteWorkspaceMode = "move" | "delete";

/** A document, folder or MCP server, once, with the workspaces that use it. */
export interface LibraryItem {
  kind: WorkspaceItemKind;
  ref_id: string;
  name: string;
  status: LibraryStatus;
  detail: string | null;
  tokens: number | null;
  workspace_ids: string[];
  /** In no workspace (never added anywhere on its own). */
  unfiled: boolean;
}

/** Where a meeting's material comes from. `effective` is computed by Rust `scope_for` only. */
export interface MeetingScope {
  meeting_id: string;
  home: string;
  borrowed: string[];
  /** Workspaces whose material is used: home + borrowed + General when allowed. */
  effective: string[];
}

export interface WorkspaceMeetingPage {
  meetings: MeetingSummary[];
  total: number;
}

/** `workspaces_changed` */
export interface WorkspacesChangedEvent {
  workspace_id?: string | null;
}

// -- Search and index --------------------------------------------------------

export type PassageKind = "transcript" | "document" | "folder" | "talking_point";

export interface Passage {
  id: number;
  kind: PassageKind;
  ref_id: string;
  sub_ref: string | null;
  title: string;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
  tokens: number;
  occurred_at: number | null;
  /** Fused rank, higher is better. */
  score: number;
  /** 0..1, how well it matches the query (newer backends). */
  relevance?: number;
  /** A short excerpt around the match. */
  snippet?: string;
  /** [start, end) pairs in `snippet`, in UTF-16 offsets. */
  match_ranges?: Array<[number, number]>;
}

export interface SkippedFile {
  path: string;
  /** "too large", "secret-looking name", "hidden", "limit reached" ... */
  reason: string;
}

export interface IndexStatus {
  workspace_id: string;
  state: "idle" | "indexing" | "paused";
  done: number;
  total: number;
  passages: number;
  skipped: SkippedFile[];
  last_indexed_at: number | null;
}

/** `workspace_index_progress` */
export interface WorkspaceIndexProgressEvent {
  workspace_id: string;
  done: number;
  total: number;
  current: string | null;
  skipped: number;
}

// -- Context ladder ------------------------------------------------------------

/** The five layers of what an answer saw, in drawing order. */
export type ContextLayer = "instructions" | "meetings" | "documents" | "folders" | "conversation";

/** One item of the context: bar width is `tokens`, height is `relevance`. */
export interface ContextBar {
  id: string;
  layer: ContextLayer;
  title: string;
  tokens: number;
  /** 0..1 */
  relevance: number;
  pinned: boolean;
  /** false = found but cut by the budget. */
  included: boolean;
}

export type ContextDepth = "lean" | "balanced" | "deep";

/** What was (or would be) sent for a question. Stored with every answer. */
export interface ContextReport {
  strategy: "full" | "ladder";
  depth: ContextDepth;
  /** Token budget used for this report: min(depth budget, 60% of window). */
  budget: number;
  /** The model's real context window in tokens. */
  window: number;
  used: number;
  bars: ContextBar[];
  /** Items left out (not drawn individually when small). */
  omitted: number;
  /** "Earlier messages condensed", window under 8k, pinned cut ... */
  notices: string[];
  /** true = estimate before sending, false = what was sent. */
  estimate: boolean;
}

// -- Workspace chat ----------------------------------------------------------------

export interface WorkspaceChat {
  id: string;
  workspace_id: string;
  title: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  depth: ContextDepth;
  include_meetings: boolean;
  /** Messages up to this id are condensed (shows "Earlier messages condensed"). */
  condensed_upto: number | null;
  /** Saved messages (0 = an empty chat). Absent from older backends. */
  message_count?: number;
  created_at: number;
  updated_at: number;
}

/** One meeting's switch for a chat (`list_chat_meeting_prefs`): false = left out of this chat. */
export interface ChatMeetingPref {
  meeting_id: string;
  included: boolean;
}

/** Per chat: pin an item so it is always sent, exclude it, or go back to the default (`set_chat_item_pref`). */
export type ChatItemPrefValue = "pin" | "exclude" | "default";

export type WorkspaceChatPatch = Partial<
  Pick<WorkspaceChat, "title" | "provider" | "model" | "effort" | "depth" | "include_meetings">
>;

/** `[S1]` in the answer text points at one of these. */
export interface WorkspaceCitation {
  /** "S1" without brackets. */
  tag: string;
  kind: PassageKind;
  ref_id: string;
  sub_ref: string | null;
  title: string;
  start_ms: number | null;
  /** Text of the passage; for a source that is gone (empty `ref_id`), why in plain words. */
  snippet: string;
}

export interface WorkspaceMessage {
  id: number;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  citations: WorkspaceCitation[];
  context: ContextReport | null;
  input_tokens: number;
  output_tokens: number;
  created_at: number;
}

/** Common to every `workspace_chat_*` event. */
interface WorkspaceChatEventBase {
  chat_id: string;
  request_id: string;
}
export interface WorkspaceChatStartEvent extends WorkspaceChatEventBase {
  model: string | null;
}
export interface WorkspaceChatTokenEvent extends WorkspaceChatEventBase {
  token: string;
}
export interface WorkspaceChatActivityEvent extends WorkspaceChatEventBase {
  activity: SourceActivity;
}
export interface WorkspaceChatContextEvent extends WorkspaceChatEventBase {
  report: ContextReport;
}
export interface WorkspaceChatEndEvent extends WorkspaceChatEventBase {
  message: WorkspaceMessage;
  cancelled: boolean;
}
/** Why an answer failed, as the backend names it. Absent from older backends. */
export type WorkspaceChatErrorKind = "no_key" | "rate_limited" | "unavailable" | "too_long" | "preempted" | "other" | "internal";

export interface WorkspaceChatErrorEvent extends WorkspaceChatEventBase {
  error: string;
  error_kind?: WorkspaceChatErrorKind;
}

/** `workspace_chat_approval_refused`: a tool was not run and no question was asked (for example it can't be answered safely). */
export interface WorkspaceChatApprovalRefusedEvent {
  chat_id: string;
  request_id?: string | null;
  reason: string;
}

/** A pin or exclusion saved for a chat (`list_chat_item_prefs`). */
export interface ItemPref {
  /** The first two parts of a context bar id: `<kind>:<ref>`. */
  kind: string;
  ref_id: string;
  pref: ChatItemPrefValue;
}

/** `get_chat_capabilities`: what this chat's model can do right now, and what is off and why. */
export interface ChatCapabilities {
  /** This CLI can ask the user before it runs a tool. It does NOT say whether the chat can run: Codex, Antigravity, API and local models are false and chat normally. */
  can_ask: boolean;
  tools_off: Array<{ tool: string; reason: string }>;
  notes: string[];
}

/** `workspace_chat_approval`: a tool that is not read-only asks first (auto-denied after 60 s). */
export interface WorkspaceChatApprovalEvent extends WorkspaceChatEventBase {
  approval_id: string;
  server: string;
  tool: string;
  /** Pretty JSON, secrets redacted, cut at 4000 characters. */
  args: unknown;
  /** The arguments were cut: not everything is shown. */
  truncated?: boolean;
  /** Secrets were replaced in `args`: what is shown is not exactly what runs. */
  redacted?: boolean;
}

/** `workspace_chat_approval_closed`: the question is over (answered elsewhere, timed out, cancelled). */
export interface WorkspaceChatApprovalClosedEvent {
  chat_id: string;
  approval_id: string;
  reason: "answered" | "timeout" | "cancelled" | string;
}

// -- Live notes ---------------------------------------------------------------------

export type NoteBlockType = "topic" | "summary" | "bullet" | "decision" | "task" | "question";

/** Stable id for the life of the meeting (talking-point "said it" and edits rely on it). */
export interface NoteBlock {
  id: string;
  type: NoteBlockType;
  /** Parent topic id, null for topics. */
  parent: string | null;
  /** Text with inline entities `{{p:Name}} {{l:Place}} {{o:Org}} {{d:Date}} {{n:Number}}`. */
  text: string;
  /** Meeting time in ms the block belongs to. */
  t: number | null;
  /** The user edited it; the AI never changes or removes it. */
  edited: boolean;
  pinned: boolean;
}

export interface NoteDoc {
  version: number;
  blocks: NoteBlock[];
}

export type NotetakerStatus = "off" | "idle" | "running" | "paused" | "capped" | "error" | "finished";

export interface NotetakerSettings {
  enabled: boolean;
  /** "This meeting" or "Every meeting" when turning on. */
  scope: "meeting" | "every";
  provider: string | null;
  model: string | null;
  effort: string | null;
  update_mode: "automatic" | "manual";
  detail: "brief" | "standard" | "detailed";
  /** "meeting" follows the meeting language. */
  language: string;
  /** Tokens per meeting (default 120000). */
  cap: number;
  colors: boolean;
}

/** `notetaker_state` */
export interface NotetakerState {
  meeting_id: string;
  status: NotetakerStatus;
  tokens_used: number;
  cap: number;
  next_in_ms?: number | null;
  /** All tokens the run has seen, when counted apart from `tokens_used`. */
  total_tokens?: number | null;
  /** Why it paused (plan limit, three failures ...). */
  reason?: string | null;
}

/** `notetaker_doc` */
export interface NotetakerDocEvent {
  meeting_id: string;
  version: number;
  doc: NoteDoc;
}

/** A user edit of the saved notes (ids are the block ids). */
export type NoteEdit =
  | { op: "update"; id: string; text?: string; type?: NoteBlockType; pinned?: boolean }
  | { op: "add"; id: string; type: NoteBlockType; parent: string | null; text: string; after?: string | null }
  | { op: "delete"; id: string };

// -- Brief ---------------------------------------------------------------------------

export interface BriefFact {
  text: string;
  /** Title of the cited passage (chip label). */
  source: string;
  passage_id?: number | null;
  /** Where the fact comes from, to open it directly. */
  sources?: BriefSource[];
}

export interface BriefSource {
  kind: PassageKind;
  ref_id: string;
  sub_ref: string | null;
  title: string;
  start_ms: number | null;
}

/** A short sheet of facts about what is being discussed now. */
export interface BriefSheet {
  now: string;
  facts: BriefFact[];
  earlier: string[];
  generated_at: number;
}

export type BriefStatus = "off" | "idle" | "running" | "paused" | "capped" | "error";

export interface BriefState {
  meeting_id: string;
  status: BriefStatus;
  tokens_used: number;
  cap: number;
  reason?: string | null;
}

export interface BriefSettings {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  effort: string | null;
  cap: number;
}

/** `brief_sheet`: `sheet` is null when a topic change hid the old one. */
export interface BriefSheetEvent {
  meeting_id: string;
  sheet: BriefSheet | null;
}

// -- Memory ------------------------------------------------------------------------------

export type MemoryKind = "person" | "decision" | "open_item" | "fact" | "preference";
export type MemoryStatus = "suggested" | "saved" | "dismissed";

/** Which AI proposes memory after a meeting; nothing set = the cheapest model automatically. */
export interface MemorySettings {
  provider: string | null;
  model: string | null;
  effort: string | null;
}

export interface MemoryItem {
  /** A suggestion the transcript does not support: shown as "Not found in the transcript". */
  unsupported?: boolean;
  id: string;
  workspace_id: string;
  kind: MemoryKind;
  title: string;
  text: string;
  source_meeting: string | null;
  source_ms: number | null;
  status: MemoryStatus;
  created_at: number;
  updated_at: number;
}

/** `memory_changed` */
export interface MemoryChangedEvent {
  workspace_id: string;
}

// -- Talking points ---------------------------------------------------------------------------

export interface TalkingPoint {
  id: string;
  workspace_id: string;
  title: string;
  /** TipTap document as JSON text. */
  doc_json: string;
  markdown: string;
  plain_text: string;
  /** "Use as AI context". */
  in_context: boolean;
  sort: number;
  created_at: number;
  updated_at: number;
}

/** Fields of a note to change; absent fields stay as they are. */
export type TalkingPointPatch = Partial<Pick<TalkingPoint, "title" | "doc_json" | "markdown" | "plain_text" | "in_context">>;

/** One block (by stable id) the user has said or ticked. */
export interface PointSaid {
  block_id: string;
  /** "voice" = detected, "manual" = the user's own choice (wins over voice). */
  by: "voice" | "manual";
  ticked: boolean;
}

/** "Said it" state of one note in one meeting. */
export interface PointProgress {
  meeting_id: string;
  point_id: string;
  said: PointSaid[];
}
