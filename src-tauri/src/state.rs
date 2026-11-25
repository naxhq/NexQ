use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};

use crate::audio::AudioCaptureManager;
use crate::commands::updater_commands::PendingUpdate;
use crate::context::ContextManager;
use crate::tray::TrayManager;
use crate::credentials::CredentialManager;
use crate::db::DatabaseManager;
use crate::intelligence::IntelligenceEngine;
use crate::llm::cli_agent::manager::{AgentSessionManager, NoopStatusSink};
use crate::llm::cli_agent::settings::CliSettings;
use crate::llm::cli_agent::spawner::CliSpawner;
use crate::llm::cli_agent::routing::{CachedFallback, HealthTracker, MeetingSessions};
use crate::llm::gemini_cache::ScopedCache;
use crate::llm::openrouter_models::OpenRouterModelCache;
use crate::llm::LLMRouter;
use crate::rag::RagManager;
use crate::sources::config::{McpServer, PersonalSourcesConfig};
use crate::translation::TranslationRouter;
use crate::translation::opus_mt_manager::OpusMtManager;
use crate::stt::groq_whisper::GroqConfig;
use crate::stt::local_engines::ModelManager;
use crate::stt::provider::DualPassConfig;
use crate::stt::STTRouter;
use std::sync::RwLock;

/// Recording info captured when stop_capture runs, consumed by end_meeting
/// to trigger the post-meeting processing pipeline.
pub struct PendingRecording {
    /// Path to the raw WAV file
    pub wav_path: PathBuf,
    /// Unix epoch milliseconds when recording started
    pub start_time_ms: u64,
}

/// Active scenario prompts pushed from the frontend when a meeting starts.
/// The intelligence pipeline reads these instead of hardcoded prompt_templates.
pub struct ActiveScenario {
    pub system_prompt: String,
    pub summary_prompt: String,
    pub question_detection_prompt: String,
    pub speaker_context: String,
}

impl Default for ActiveScenario {
    fn default() -> Self {
        Self {
            system_prompt: String::new(),
            summary_prompt: String::new(),
            question_detection_prompt: String::new(),
            speaker_context: String::new(),
        }
    }
}

/// Central application state managed by Tauri.
/// Each manager is wrapped in Option<Arc<Mutex<>>> so sub-PRDs can
/// initialize their own managers independently.
///
/// Audio uses Arc<Mutex<Option<...>>> so commands can always acquire the lock
/// and then check/initialize the manager within.
pub struct AppState {
    pub database: Option<Arc<Mutex<DatabaseManager>>>,
    pub audio: Arc<Mutex<Option<AudioCaptureManager>>>,
    pub stt: Option<Arc<Mutex<STTRouter>>>,
    pub llm: Option<Arc<Mutex<LLMRouter>>>,
    pub intelligence: Option<Arc<Mutex<IntelligenceEngine>>>,
    pub context: Option<Arc<Mutex<ContextManager>>>,
    pub credentials: Option<Arc<Mutex<CredentialManager>>>,
    pub model_manager: Option<Arc<Mutex<ModelManager>>>,
    pub rag: Option<Arc<Mutex<RagManager>>>,
    pub translation: Option<Arc<Mutex<TranslationRouter>>>,
    pub opus_mt_manager: Option<Arc<Mutex<OpusMtManager>>>,
    pub whisper_config: Arc<RwLock<DualPassConfig>>,
    /// Shared Groq Whisper config — read by running providers on each API call,
    /// written by IPC commands. Allows live config updates mid-meeting.
    pub shared_groq_config: Arc<RwLock<GroqConfig>>,
    /// Universal pause threshold for transcript line-breaking (ms).
    /// Read lock-free by the system STT task; written by the settings IPC.
    pub pause_threshold_ms: Arc<AtomicU64>,
    /// Stop signal for the Live Monitor background thread.
    /// true = thread is running (keep looping); false = thread should stop.
    pub device_monitor_running: Arc<AtomicBool>,
    /// Per-party mute flags — when true, audio is NOT forwarded to the STT engine.
    /// Audio levels + recording continue unaffected.
    pub you_muted: Arc<AtomicBool>,
    pub them_muted: Arc<AtomicBool>,
    /// Remove the other side's voice that the mic picks up from the speakers
    /// (audio::echo_cancel). Read per chunk, so it applies mid-meeting.
    pub echo_cancellation: Arc<AtomicBool>,
    /// Original default capture endpoint ID saved before IPolicyConfig override.
    /// Set when Web Speech / Windows Speech uses a non-default device; restored on stop.
    pub original_default_device: Arc<Mutex<Option<String>>>,
    /// Resolved Windows endpoint ID of the IPolicyConfig target device.
    /// Set alongside original_default_device; used by ensure_ipolicy_override
    /// to verify the OS default hasn't drifted.
    pub ipolicy_target_endpoint: Arc<Mutex<Option<String>>>,
    /// Active scenario prompts — pushed by the frontend at meeting start.
    /// Intelligence pipeline reads these for scenario-aware prompt assembly.
    pub active_scenario: Arc<RwLock<ActiveScenario>>,
    /// Recording info stored by stop_capture, consumed by end_meeting.
    /// This bridges the gap: frontend calls stopCapture() then endMeeting()
    /// in sequence; by the time end_meeting runs the recorder is stopped and
    /// the WAV path + start time are waiting here.
    pub pending_recording: Arc<Mutex<Option<PendingRecording>>>,
    /// The Auto-detect refusal each side (You, Them) is running under, if any:
    /// a side that couldn't detect the language started without speech-to-text.
    /// A swap that gets the same refusal again isn't news. Cleared when capture stops.
    pub auto_refusals: Mutex<[Option<String>; 2]>,
    /// Where a language change for one side reaches the running audio loop
    /// (audio::side_swap). Replaced at every capture start; None before the first.
    pub side_swap: Mutex<Option<crate::audio::side_swap::SideSwapSender>>,
    /// Completion signal for an active MAI capture's provider and transcript drain.
    /// Stop/restart waits for this before emitting stopped or persisting the recording.
    pub mai_capture_drain: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    /// In-memory cache for OpenRouter model catalog (TTL: 4 hours).
    pub openrouter_cache: Arc<Mutex<Option<OpenRouterModelCache>>>,
    /// Tray icon manager — initialized after the tray handle is available.
    pub tray_manager: Arc<Mutex<Option<TrayManager>>>,
    /// Active Gemini context cache for the current meeting session.
    /// Set when the user creates a cache; cleared on delete or meeting end.
    /// The cache and the scope fingerprint it was built from, in one value: a
    /// request uses it only when its scope has the same fingerprint, so a cache
    /// built from one workspace's documents never answers for another.
    pub gemini_cache: Arc<Mutex<Option<ScopedCache>>>,
    /// The app handle, set once at startup (for events from code that has none).
    pub app_handle: std::sync::OnceLock<tauri::AppHandle>,
    /// Settings files that could not be read at start (shown to the user once).
    pub store_findings: Mutex<Vec<crate::store_guard::StoreRecovery>>,
    /// Restarts caused by grants wait and coalesce (see `workspace::restart`).
    pub restarts: Arc<crate::workspace::restart::Restarts>,
    /// Meetings (or "default") the user was already told their workspace
    /// material could not be read for: told once per meeting.
    pub material_warned: Mutex<std::collections::HashSet<String>>,
    /// Downloaded update waiting to be installed (on Restart or on quit).
    pub pending_update: Arc<Mutex<Option<PendingUpdate>>>,
    /// True while `download_update` is running; prevents parallel downloads.
    pub update_downloading: Arc<AtomicBool>,
    /// True between `start_meeting` and `end_meeting`. Updates never install
    /// on quit while a meeting is active.
    pub meeting_active: Arc<AtomicBool>,
    /// Post-meeting recording pipelines still running (WAV → Opus + DB update).
    pub recording_jobs: Arc<AtomicUsize>,
    /// CLI agent sessions (live / past meeting / utility) of the active
    /// provider (Claude, Antigravity or Codex). `setup` replaces this with one
    /// that emits `agent_session_status` to the app.
    pub agent_sessions: Arc<AgentSessionManager>,
    /// Workspace chat: request guard, session fingerprints, search indexer.
    pub workspace_chat: Arc<crate::workspace_chat::ChatHub>,
    /// Per-CLI model settings and catalogs (one of each per CLI agent), read
    /// whenever a session is spawned, and which CLI is active.
    pub cli_settings: Arc<CliSettings>,
    /// Whether the active CLI agent can take requests (else they go to the fallback).
    pub claude_health: Arc<HealthTracker>,
    /// What each open meeting session was given, for restarts.
    pub meeting_sessions: Arc<MeetingSessions>,
    /// The running meeting (set by `start_meeting`, cleared by `end_meeting`).
    pub live_meeting: Arc<Mutex<Option<LiveMeeting>>>,
    /// The fallback provider client last built (reused while unchanged).
    pub claude_fallback: Arc<Mutex<Option<CachedFallback>>>,
    /// Notes folders and MCP servers the user set up (`set_personal_sources`).
    pub personal_sources: Arc<RwLock<PersonalSourcesConfig>>,
    /// Bumped when the saved secrets of an enabled MCP server change (they
    /// are not in `personal_sources`, so its fingerprint can't see them).
    pub sources_secrets_rev: Arc<AtomicU64>,
    /// Servers an import or the form returned that the webview has not saved
    /// yet (newest last, at most `PENDING_SERVERS_MAX`), with when each was
    /// handed over. A Check or an edit finds them here by id. Each reserves its
    /// key for `PENDING_KEY_HOLD` (so two servers added together get different
    /// keys); one the webview never saves stops reserving it then, so a
    /// discarded server doesn't push the real one to `name-2`.
    pub pending_servers: Arc<Mutex<Vec<(McpServer, std::time::Instant)>>>,
    /// The sources (and secrets revision) the with-sources sessions were last
    /// started or restarted for.
    pub sources_applied: Arc<Mutex<(PersonalSourcesConfig, u64)>>,
    /// A with-sources session that just failed to start: answers skip it for
    /// a while instead of waiting on it again.
    pub sources_cooldown: Arc<crate::llm::cli_agent::routing::SourcesCooldown>,
    /// The one service chat, notes, brief, recap and memory calls go through
    /// (set in `setup`, once the session manager exists).
    pub ai_runs: Option<Arc<crate::ai_runs::AiRuns>>,
}

/// The meeting between `start_meeting` and `end_meeting`.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveMeeting {
    pub id: String,
    /// Start time, Unix epoch milliseconds (transcript times are relative to it).
    pub start_ms: i64,
}

impl AppState {
    pub fn new() -> Self {
        let cli_settings = Arc::new(CliSettings::new());
        Self {
            database: None,
            audio: Arc::new(Mutex::new(Some(AudioCaptureManager::new()))),
            stt: None,
            llm: None,
            intelligence: None,
            context: None,
            credentials: None,
            model_manager: None,
            rag: None,
            translation: None,
            opus_mt_manager: None,
            whisper_config: Arc::new(RwLock::new(DualPassConfig::default())),
            shared_groq_config: Arc::new(RwLock::new(GroqConfig::default())),
            pause_threshold_ms: Arc::new(AtomicU64::new(3000)),
            device_monitor_running: Arc::new(AtomicBool::new(false)),
            you_muted: Arc::new(AtomicBool::new(false)),
            them_muted: Arc::new(AtomicBool::new(false)),
            echo_cancellation: Arc::new(AtomicBool::new(true)),
            original_default_device: Arc::new(Mutex::new(None)),
            ipolicy_target_endpoint: Arc::new(Mutex::new(None)),
            active_scenario: Arc::new(RwLock::new(ActiveScenario::default())),
            pending_recording: Arc::new(Mutex::new(None)),
            auto_refusals: Mutex::new([None, None]),
            side_swap: Mutex::new(None),
            mai_capture_drain: tokio::sync::Mutex::new(None),
            openrouter_cache: Arc::new(Mutex::new(None)),
            tray_manager: Arc::new(Mutex::new(None)),
            gemini_cache: Arc::new(Mutex::new(None)),
            store_findings: Mutex::new(Vec::new()),
            restarts: Arc::new(Default::default()),
            app_handle: std::sync::OnceLock::new(),
            material_warned: Mutex::new(std::collections::HashSet::new()),
            pending_update: Arc::new(Mutex::new(None)),
            update_downloading: Arc::new(AtomicBool::new(false)),
            meeting_active: Arc::new(AtomicBool::new(false)),
            recording_jobs: Arc::new(AtomicUsize::new(0)),
            workspace_chat: crate::workspace_chat::ChatHub::new(),
            agent_sessions: Arc::new(AgentSessionManager::new(
                Arc::new(CliSpawner),
                Arc::new(NoopStatusSink),
                cli_settings.clone(),
            )),
            cli_settings,
            claude_health: Arc::new(HealthTracker::default()),
            meeting_sessions: Arc::new(MeetingSessions::default()),
            live_meeting: Arc::new(Mutex::new(None)),
            claude_fallback: Arc::new(Mutex::new(None)),
            personal_sources: Arc::new(RwLock::new(PersonalSourcesConfig::default())),
            sources_secrets_rev: Arc::new(AtomicU64::new(0)),
            sources_applied: Arc::new(Mutex::new((PersonalSourcesConfig::default(), 0))),
            sources_cooldown: Arc::new(Default::default()),
            pending_servers: Arc::new(Mutex::new(Vec::new())),
            ai_runs: None,
        }
    }
}

// Safety: AppState is only accessed through Tauri's managed state with proper synchronization
unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}
