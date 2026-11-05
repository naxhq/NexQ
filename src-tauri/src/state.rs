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
use crate::llm::cli_agent::manager::{
    AgentSessionManager, ClaudeCliConfig, ClaudeSpawner, NoopStatusSink,
};
use crate::llm::cli_agent::models::ModelCatalog;
use crate::llm::cli_agent::routing::{CachedFallback, HealthTracker, MeetingSessions};
use crate::llm::gemini_cache::CachedContent;
use crate::llm::openrouter_models::OpenRouterModelCache;
use crate::llm::LLMRouter;
use crate::rag::RagManager;
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
    /// In-memory cache for OpenRouter model catalog (TTL: 4 hours).
    pub openrouter_cache: Arc<Mutex<Option<OpenRouterModelCache>>>,
    /// Tray icon manager — initialized after the tray handle is available.
    pub tray_manager: Arc<Mutex<Option<TrayManager>>>,
    /// Active Gemini context cache for the current meeting session.
    /// Set when the user creates a cache; cleared on delete or meeting end.
    pub gemini_cache: Arc<Mutex<Option<CachedContent>>>,
    /// Downloaded update waiting to be installed (on Restart or on quit).
    pub pending_update: Arc<Mutex<Option<PendingUpdate>>>,
    /// True while `download_update` is running; prevents parallel downloads.
    pub update_downloading: Arc<AtomicBool>,
    /// True between `start_meeting` and `end_meeting`. Updates never install
    /// on quit while a meeting is active.
    pub meeting_active: Arc<AtomicBool>,
    /// Post-meeting recording pipelines still running (WAV → Opus + DB update).
    pub recording_jobs: Arc<AtomicUsize>,
    /// Claude CLI sessions (live / past meeting / utility). `setup` replaces
    /// this with one that emits `agent_session_status` to the app.
    pub agent_sessions: Arc<AgentSessionManager>,
    /// Claude CLI model settings, read whenever a session is spawned.
    pub claude_cli_config: Arc<RwLock<ClaudeCliConfig>>,
    /// Last model catalog the Claude CLI reported (`claude_cli_models`).
    pub claude_models: Arc<ModelCatalog>,
    /// Whether Claude can take requests (else they go to the fallback).
    pub claude_health: Arc<HealthTracker>,
    /// What each open meeting session was given, for restarts.
    pub meeting_sessions: Arc<MeetingSessions>,
    /// The running meeting (set by `start_meeting`, cleared by `end_meeting`).
    pub live_meeting: Arc<Mutex<Option<LiveMeeting>>>,
    /// The fallback provider client last built (reused while unchanged).
    pub claude_fallback: Arc<Mutex<Option<CachedFallback>>>,
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
        let claude_cli_config = Arc::new(RwLock::new(ClaudeCliConfig::default()));
        let claude_models = ModelCatalog::global();
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
            openrouter_cache: Arc::new(Mutex::new(None)),
            tray_manager: Arc::new(Mutex::new(None)),
            gemini_cache: Arc::new(Mutex::new(None)),
            pending_update: Arc::new(Mutex::new(None)),
            update_downloading: Arc::new(AtomicBool::new(false)),
            meeting_active: Arc::new(AtomicBool::new(false)),
            recording_jobs: Arc::new(AtomicUsize::new(0)),
            agent_sessions: Arc::new(AgentSessionManager::new(
                Arc::new(ClaudeSpawner),
                Arc::new(NoopStatusSink),
                claude_cli_config.clone(),
            )
            .with_catalog(claude_models.clone())),
            claude_cli_config,
            claude_models,
            claude_health: Arc::new(HealthTracker::default()),
            meeting_sessions: Arc::new(MeetingSessions::default()),
            live_meeting: Arc::new(Mutex::new(None)),
            claude_fallback: Arc::new(Mutex::new(None)),
        }
    }
}

// Safety: AppState is only accessed through Tauri's managed state with proper synchronization
unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}
