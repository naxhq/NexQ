pub mod action_config;
pub mod context_builder;
pub mod context_scope;
pub mod prompt_templates;
pub mod question_detector;
pub mod transcript_buffer;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use action_config::AllActionConfigs;
use context_builder::ContextBuilder;
use question_detector::{DetectedQuestion, QuestionDetector};
use transcript_buffer::TranscriptBuffer;

use crate::llm::provider::{CancelToken, GenerationParams};

/// Event payload for question detection events emitted to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionDetectedPayload {
    pub question: DetectedQuestion,
}

/// The generation currently in flight: its request id and cancel token.
type InFlight = Option<(String, Arc<CancelToken>)>;

/// RAII hold on the engine's "generating" state. Dropping it (on any exit path of
/// `generate_assist`, including early `?` returns) marks the engine idle again and
/// forgets the in-flight generation. Owns the fresh `CancelToken` of this generation.
pub struct GenerationGuard {
    is_generating: Arc<AtomicBool>,
    in_flight: Arc<Mutex<InFlight>>,
    cancel_token: Arc<CancelToken>,
}

impl GenerationGuard {
    /// Token that `cancel_generation` fires to stop this generation.
    pub fn cancel_token(&self) -> Arc<CancelToken> {
        self.cancel_token.clone()
    }
}

impl Drop for GenerationGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.in_flight.lock() {
            *slot = None;
        }
        self.is_generating.store(false, Ordering::SeqCst);
    }
}

/// Orchestrates: read transcript -> detect question -> load context -> build prompt -> LLM stream
pub struct IntelligenceEngine {
    pub transcript_buffer: TranscriptBuffer,
    question_detector: QuestionDetector,
    auto_trigger: AtomicBool,
    is_generating: Arc<AtomicBool>,
    /// Request id + cancel token of the generation in flight (for the cancelled end event).
    in_flight: Arc<Mutex<InFlight>>,
    last_detected_question: Option<DetectedQuestion>,
    action_configs: AllActionConfigs,
}

impl IntelligenceEngine {
    pub fn new() -> Self {
        Self {
            transcript_buffer: TranscriptBuffer::new(),
            question_detector: QuestionDetector::new(),
            auto_trigger: AtomicBool::new(true),
            is_generating: Arc::new(AtomicBool::new(false)),
            in_flight: Arc::new(Mutex::new(None)),
            last_detected_question: None,
            action_configs: AllActionConfigs::default(),
        }
    }

    /// Push a transcript segment into the buffer and run question detection.
    /// Returns detected questions (if any) so the caller can emit events.
    pub fn push_transcript(
        &mut self,
        text: String,
        speaker: String,
        timestamp_ms: u64,
        is_final: bool,
    ) -> Vec<DetectedQuestion> {
        self.transcript_buffer
            .push_segment(text.clone(), speaker.clone(), timestamp_ms, is_final);

        // Only detect questions on final segments
        if !is_final {
            return Vec::new();
        }

        let questions = self
            .question_detector
            .detect_questions(&text, timestamp_ms, &speaker);

        // Store the most recent high-confidence question
        if let Some(q) = questions.iter().max_by(|a, b| {
            a.confidence
                .partial_cmp(&b.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        }) {
            self.last_detected_question = Some(q.clone());
        }

        questions
    }

    /// Main entry point: generate AI assistance in the given mode.
    /// Orchestrates the full pipeline: transcript -> question -> context -> prompt -> LLM stream.
    ///
    /// This is called from the Tauri command layer. The LLMRouter and ContextManager
    /// are passed in because they live in AppState under separate locks.
    pub async fn generate_assist(
        system_prompt: &str,
        mode: &str,
        custom_question: Option<&str>,
        transcript_text: String,
        last_question: Option<DetectedQuestion>,
        context_text: String,
        include_context: bool,
        include_transcript: bool,
        include_question: bool,
        include_rag: bool,
        include_instructions: bool,
        llm_provider: Arc<tokio::sync::Mutex<Box<dyn crate::llm::provider::LLMProvider>>>,
        model: String,
        provider_name: String,
        params: GenerationParams,
        // New metadata fields for StreamStartEvent
        temperature: f64,
        rag_query: Option<String>,
        rag_chunks: Vec<crate::llm::provider::RagChunkInfo>,
        rag_chunks_filtered: usize,
        rag_total_candidates: usize,
        transcript_window_seconds: u64,
        transcript_segments_count: usize,
        transcript_segments_total: usize,
        scope_label: Option<String>,
        app_handle: tauri::AppHandle,
        cancel_token: Arc<CancelToken>,
    ) -> Result<(), String> {
        // The token is created by `begin_generation` (before the guard is handed out),
        // so a Stop pressed while the prompt is still being assembled is not lost.
        let params = GenerationParams {
            cancel: Some(cancel_token.clone()),
            ..params
        };

        // Build the prompt using configurable flags.
        // The system prompt IS the only instruction (per-action editable + composed instructions).
        // The user message contains only togglable data sections (transcript, RAG, questions).
        let builder = ContextBuilder::new();
        let messages = builder.build_prompt_with_config(
            system_prompt,
            &transcript_text,
            last_question.as_ref(),
            &context_text,
            custom_question,
            include_context,
            include_transcript,
            include_question,
        );

        // Check for cancellation before starting
        if cancel_token.is_cancelled() {
            return Ok(());
        }

        // Extract actual messages for the call log
        let system_msg = messages.iter()
            .find(|m| m.role == "system")
            .map(|m| m.content.clone())
            .unwrap_or_default();
        let user_msg = messages.iter()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_default();

        // Emit stream start with actual prompt data
        let _ = app_handle.emit(
            "llm_stream_start",
            crate::llm::provider::StreamStartPayload {
                mode: mode.to_string(),
                model: model.clone(),
                provider: provider_name.clone(),
                system_prompt: system_msg,
                user_prompt: user_msg,
                include_transcript,
                include_rag,
                include_instructions,
                include_question,
                temperature,
                rag_query,
                rag_chunks,
                rag_chunks_filtered,
                rag_total_candidates,
                transcript_window_seconds,
                transcript_segments_count,
                transcript_segments_total,
                request_id: params.request_id.clone(),
                session_key: None,
                scope_label,
            },
        );

        // Call the LLM provider's stream_completion
        let provider_guard = llm_provider.lock().await;
        let result = provider_guard
            .stream_completion(messages, &model, params, app_handle.clone(), None)
            .await;

        // The provider already emitted llm_stream_end / llm_stream_error for this request.
        // A cancelled stream is a normal stop: `cancel_generation` emitted the end event.
        // An error that merely surfaced because the stream was stopped is not a failure.
        match result {
            Ok(_) | Err(crate::llm::provider::LLMError::Cancelled) => Ok(()),
            Err(_) if cancel_token.is_cancelled() => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Claim the engine for a new generation. Returns `None` if one is already running.
    /// Creates a fresh cancel token and records it with `request_id` so `cancel_generation`
    /// can stop it and address its cancelled end event. The guard releases the engine on drop.
    pub fn begin_generation(&self, request_id: &str) -> Option<GenerationGuard> {
        self.is_generating
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        let cancel_token = Arc::new(CancelToken::new());
        if let Ok(mut slot) = self.in_flight.lock() {
            *slot = Some((request_id.to_string(), cancel_token.clone()));
        }
        Some(GenerationGuard {
            is_generating: self.is_generating.clone(),
            in_flight: self.in_flight.clone(),
            cancel_token,
        })
    }

    /// Ask the in-flight generation to stop. Returns its request id when one is running
    /// (consuming it, so the cancelled end event is emitted once).
    pub fn cancel(&self) -> Option<String> {
        let (request_id, token) = self.in_flight.lock().ok()?.take()?;
        token.cancel();
        Some(request_id)
    }

    /// Like `cancel`, but only when `request_id` is the generation in flight,
    /// so stopping one answer can never stop another that took its place.
    pub fn cancel_request(&self, request_id: &str) -> Option<String> {
        let mut slot = self.in_flight.lock().ok()?;
        if slot.as_ref().map(|(id, _)| id.as_str()) != Some(request_id) {
            return None;
        }
        let (request_id, token) = slot.take()?;
        token.cancel();
        Some(request_id)
    }

    /// Check if currently generating.
    pub fn is_generating(&self) -> bool {
        self.is_generating.load(Ordering::SeqCst)
    }

    /// Toggle auto-detection of questions.
    pub fn set_auto_trigger(&self, enabled: bool) {
        self.auto_trigger.store(enabled, Ordering::SeqCst);
    }

    /// Check if auto-trigger is enabled.
    pub fn auto_trigger_enabled(&self) -> bool {
        self.auto_trigger.load(Ordering::SeqCst)
    }

    /// Set the transcript buffer context window size.
    pub fn set_context_window(&mut self, seconds: u64) {
        self.transcript_buffer.set_window_seconds(seconds);
    }

    /// Get the most recently detected question.
    pub fn last_detected_question(&self) -> Option<&DetectedQuestion> {
        self.last_detected_question.as_ref()
    }

    /// Get recent transcript text within the configured window.
    pub fn get_recent_transcript(&self) -> String {
        let window = self.transcript_buffer.window_seconds();
        self.transcript_buffer.get_recent_text(window)
    }

    /// Get all transcript text (for Recap mode with window=0).
    pub fn get_all_transcript(&self) -> String {
        self.transcript_buffer.get_all_text()
    }

    /// Set action configs (called from IPC when frontend syncs).
    pub fn set_action_configs(&mut self, configs: AllActionConfigs) {
        self.action_configs = configs;
    }

    /// Get action configs.
    pub fn get_action_configs(&self) -> &AllActionConfigs {
        &self.action_configs
    }

    /// Get a specific action config by mode key.
    pub fn get_action_config(&self, mode: &str) -> Option<&action_config::ActionConfig> {
        self.action_configs.actions.get(mode)
    }

    /// Reset per-meeting state so the next meeting starts clean.
    /// Clears the transcript buffer and last detected question.
    pub fn clear_session(&mut self) {
        self.transcript_buffer.clear();
        self.last_detected_question = None;
        log::info!("[intelligence] session cleared for new meeting");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_blocks_second_generation_until_dropped() {
        let engine = IntelligenceEngine::new();
        let guard = engine.begin_generation("req-1").expect("first claim succeeds");
        assert!(engine.is_generating());
        assert!(engine.begin_generation("req-2").is_none());
        drop(guard);
        assert!(!engine.is_generating());
        assert!(engine.begin_generation("req-3").is_some());
    }

    #[test]
    fn guard_releases_on_early_error_return() {
        fn failing(engine: &IntelligenceEngine) -> Result<(), String> {
            let _guard = engine.begin_generation("req-1").ok_or("busy")?;
            Err("no active provider".to_string())
        }
        let engine = IntelligenceEngine::new();
        assert!(failing(&engine).is_err());
        assert!(!engine.is_generating());
        assert!(engine.begin_generation("req-2").is_some());
    }

    #[test]
    fn cancel_returns_request_id_once_and_fires_token() {
        let engine = IntelligenceEngine::new();
        assert_eq!(engine.cancel(), None); // nothing running
        let guard = engine.begin_generation("req-1").unwrap();
        let token = guard.cancel_token();
        assert!(!token.is_cancelled());
        assert_eq!(engine.cancel(), Some("req-1".to_string()));
        assert!(token.is_cancelled());
        assert_eq!(engine.cancel(), None);
    }

    #[test]
    fn cancelling_a_named_request_leaves_any_other_running() {
        let engine = IntelligenceEngine::new();
        assert_eq!(engine.cancel_request("auto-1"), None); // nothing running
        let guard = engine.begin_generation("yours").unwrap();
        // An automatic answer that already ended must not stop yours.
        assert_eq!(engine.cancel_request("auto-1"), None);
        assert!(!guard.cancel_token().is_cancelled());
        assert_eq!(engine.cancel_request("yours"), Some("yours".to_string()));
        assert!(guard.cancel_token().is_cancelled());
        assert_eq!(engine.cancel_request("yours"), None);
    }

    #[test]
    fn each_generation_gets_a_fresh_cancel_token() {
        let engine = IntelligenceEngine::new();
        let first = engine.begin_generation("req-1").unwrap();
        engine.cancel();
        assert!(first.cancel_token().is_cancelled());
        drop(first);
        let second = engine.begin_generation("req-2").unwrap();
        assert!(!second.cancel_token().is_cancelled());
    }
}
