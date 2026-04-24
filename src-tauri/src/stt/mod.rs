pub mod deepgram;
pub mod fbank;
pub mod local_engines;
pub mod provider;
pub mod whisper_cpp;
pub mod windows_native;
pub mod word_diff;
// Sub-PRD 9: Additional providers
pub mod azure_speech;
pub mod groq_whisper;
pub mod whisper_api;
// STT Engine Overhaul: New streaming providers
pub mod sherpa_sidecar;
pub mod sherpa_offline;
pub mod ort_streaming;
// Pause-based segment merging for all STT providers
pub mod segment_accumulator;

use provider::{STTProvider, STTProviderType, TranscriptResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::audio::{AudioChunk, AudioSource};

/// Emit an STT debug event to the frontend and log it.
/// Use this for pipeline diagnostics that should appear in the DevLog panel.
pub fn emit_stt_debug(app_handle: &tauri::AppHandle, level: &str, source: &str, message: &str) {
    emit_stt_debug_ex(app_handle, level, source, message, None);
}

/// Emit an STT debug event with optional replace_key for update-in-place entries.
/// When `replace_key` is Some, the frontend will update the last entry with that key
/// instead of appending a new log line. Use this for periodic stats that would spam the log.
pub fn emit_stt_debug_ex(
    app_handle: &tauri::AppHandle,
    level: &str,
    source: &str,
    message: &str,
    replace_key: Option<&str>,
) {
    match level {
        "error" => log::error!("[{}] {}", source, message),
        "warn" => log::warn!("[{}] {}", source, message),
        _ => log::info!("[{}] {}", source, message),
    }
    let mut payload = serde_json::json!({
        "level": level,
        "source": source,
        "message": message,
        "timestamp_ms": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    if let Some(key) = replace_key {
        payload["replace_key"] = serde_json::json!(key);
    }
    let _ = tauri::Emitter::emit(app_handle, "stt_debug", &payload);
}

/// IPC event payload for transcript updates.
#[derive(Debug, Clone, Serialize)]
struct TranscriptEventPayload {
    segment: TranscriptSegmentPayload,
}

/// Mirrors the frontend TranscriptSegment type from types.ts.
#[derive(Debug, Clone, Serialize)]
struct TranscriptSegmentPayload {
    id: String,
    text: String,
    speaker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    speaker_id: Option<String>,
    timestamp_ms: u64,
    is_final: bool,
    confidence: f32,
}

/// Routes audio chunks to the active STT provider and emits IPC events.
///
/// The STTRouter manages:
/// - The active STT provider (Windows Native, Deepgram, Whisper API, Azure Speech, Groq Whisper)
/// - Dual audio streams (mic -> "User", system -> "Interviewer")
/// - IPC event emission for transcript_update (interim) and transcript_final
/// - Provider switching at runtime
pub struct STTRouter {
    /// The currently active STT provider
    active_provider: Option<Box<dyn STTProvider>>,
    /// The provider type currently active
    active_type: Option<STTProviderType>,
    /// Whether processing is currently active
    is_processing: bool,
    /// Channel sender for feeding audio to the processing loop
    audio_tx: Option<mpsc::Sender<AudioChunk>>,
    /// Language setting
    pub(crate) language: String,
    /// Deepgram API key (cached from credential store)
    pub(crate) deepgram_api_key: Option<String>,
    /// Deepgram feature/model configuration
    pub(crate) deepgram_config: deepgram::DeepgramConfig,
    /// OpenAI API key for Whisper API (cached from credential store)
    pub(crate) whisper_api_key: Option<String>,
    /// Azure Speech subscription key (cached from credential store)
    pub(crate) azure_speech_key: Option<String>,
    /// Azure Speech region (e.g., "eastus", "westeurope")
    pub(crate) azure_speech_region: Option<String>,
    /// Groq API key for Groq Whisper (cached from credential store)
    pub(crate) groq_whisper_api_key: Option<String>,
    /// Groq Whisper configuration (model, temperature, etc.)
    pub(crate) groq_config: groq_whisper::GroqConfig,
    /// Counter for generating unique segment IDs
    segment_counter: u64,
    /// Reference to the Tauri app handle for emitting events
    app_handle: Option<AppHandle>,
}

impl STTRouter {
    pub fn new() -> Self {
        Self {
            active_provider: None,
            active_type: None,
            is_processing: false,
            audio_tx: None,
            language: "en-US".to_string(),
            deepgram_api_key: None,
            deepgram_config: deepgram::DeepgramConfig::default(),
            whisper_api_key: None,
            azure_speech_key: None,
            azure_speech_region: None,
            groq_whisper_api_key: None,
            groq_config: groq_whisper::GroqConfig::default(),
            segment_counter: 0,
            app_handle: None,
        }
    }

    /// Set the Tauri AppHandle for emitting IPC events.
    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    /// Set the active STT provider type.
    /// If currently processing, stops the current provider before switching.
    pub async fn set_provider(
        &mut self,
        provider_type: STTProviderType,
    ) -> Result<(), String> {
        // If same provider is already active, no-op
        if self.active_type.as_ref() == Some(&provider_type) {
            return Ok(());
        }

        // Stop current processing if active
        if self.is_processing {
            self.stop_processing().await?;
        }

        log::info!(
            "STTRouter: Switching provider to {}",
            provider_type.as_str()
        );

        // Create the new provider
        let provider: Box<dyn STTProvider> = match provider_type {
            STTProviderType::WebSpeech => {
                // WebSpeech is frontend-only — no Rust provider to instantiate.
                // Just record the type so the pipeline knows to skip Rust STT.
                self.active_provider = None;
                self.active_type = Some(provider_type);
                log::info!("STTRouter: WebSpeech selected (frontend-only, no Rust provider)");
                return Ok(());
            }
            STTProviderType::WhisperCpp => {
                // WhisperCpp is created per-party with a specific model path.
                // In the legacy single-provider path, just record the type.
                self.active_provider = None;
                self.active_type = Some(provider_type);
                log::info!("STTRouter: WhisperCpp selected (provider created per-party)");
                return Ok(());
            }
            STTProviderType::WindowsNative => {
                let mut p = windows_native::WindowsNativeSTT::new();
                p.set_language(&self.language);
                Box::new(p)
            }
            STTProviderType::Deepgram => {
                let mut p = deepgram::DeepgramSTT::new();
                if let Some(ref key) = self.deepgram_api_key {
                    p.set_api_key(key);
                }
                p.set_language(&self.language);
                p.set_config(self.deepgram_config.clone());
                Box::new(p)
            }
            STTProviderType::WhisperApi => {
                let mut p = whisper_api::WhisperApiSTT::new();
                if let Some(ref key) = self.whisper_api_key {
                    p.set_api_key(key);
                }
                p.set_language(&self.language);
                Box::new(p)
            }
            STTProviderType::AzureSpeech => {
                let mut p = azure_speech::AzureSpeechSTT::new();
                if let Some(ref key) = self.azure_speech_key {
                    p.set_subscription_key(key);
                }
                if let Some(ref region) = self.azure_speech_region {
                    p.set_region(region);
                }
                p.set_language(&self.language);
                Box::new(p)
            }
            STTProviderType::GroqWhisper => {
                let mut p = groq_whisper::GroqWhisperSTT::new();
                if let Some(ref key) = self.groq_whisper_api_key {
                    p.set_api_key(key);
                }
                p.set_config(self.groq_config.clone());
                p.set_language(&self.language); // must be after set_config — set_config overwrites language
                Box::new(p)
            }
            STTProviderType::SherpaOnnx | STTProviderType::OrtStreaming | STTProviderType::ParakeetTdt => {
                // These are created per-party in start_capture_per_party, not via STTRouter.
                self.active_provider = None;
                log::info!("STTRouter: {:?} selected (provider created per-party)", provider_type);
                self.active_type = Some(provider_type);
                return Ok(());
            }
        };

        self.active_provider = Some(provider);
        self.active_type = Some(provider_type);

        log::info!("STTRouter: Provider switched successfully");
        Ok(())
    }

    /// Start processing audio chunks through the active STT provider.
    /// After calling this, use `feed_audio()` to send audio chunks to the provider.
    pub async fn start_processing(&mut self) -> Result<(), String> {
        if self.is_processing {
            return Err("STT processing already active".to_string());
        }

        let provider = self
            .active_provider
            .as_mut()
            .ok_or("No STT provider configured")?;

        // Create the result channel (provider -> router)
        let (result_tx, mut result_rx) = mpsc::channel::<TranscriptResult>(256);

        // Start the provider's recognition stream
        provider
            .start_stream(result_tx)
            .await
            .map_err(|e| format!("Failed to start STT stream: {}", e))?;

        // Spawn the result processing task that emits IPC events
        // TranscriptResults from the provider are forwarded as Tauri events
        let app_handle = self.app_handle.clone();
        let segment_counter_start = self.segment_counter;
        tokio::spawn(async move {
            let mut counter = segment_counter_start;

            while let Some(result) = result_rx.recv().await {
                counter += 1;

                let raw_speaker = result
                    .speaker
                    .clone()
                    .unwrap_or_else(|| "Unknown".to_string());

                // Separate party label from diarized speaker ID.
                // Deepgram sets speaker to "speaker_N" when diarization is active.
                // Keep "speaker_N" as speaker_id; use party label ("Them"/"User") as speaker.
                let (speaker, speaker_id) = if raw_speaker.starts_with("speaker_") {
                    // Diarized: use "Them" as the party label, actual ID as speaker_id
                    ("Them".to_string(), Some(raw_speaker))
                } else {
                    (raw_speaker, None)
                };

                let segment = TranscriptSegmentPayload {
                    id: format!("seg_{}", counter),
                    text: result.text.clone(),
                    speaker,
                    speaker_id,
                    timestamp_ms: result.timestamp_ms,
                    is_final: result.is_final,
                    confidence: result.confidence,
                };

                let payload = TranscriptEventPayload { segment };

                if let Some(ref handle) = app_handle {
                    let event_name = if result.is_final {
                        "transcript_final"
                    } else {
                        "transcript_update"
                    };

                    if let Err(e) = handle.emit(event_name, &payload) {
                        log::error!("STTRouter: Failed to emit {}: {}", event_name, e);
                    }
                }
            }

            log::info!("STTRouter: Result processing task exiting");
        });

        self.is_processing = true;
        log::info!("STTRouter: Processing started — use feed_audio() to send chunks");

        Ok(())
    }

    /// Stop processing and clean up.
    pub async fn stop_processing(&mut self) -> Result<(), String> {
        if !self.is_processing {
            return Ok(());
        }

        log::info!("STTRouter: Stopping processing");

        // Drop the audio sender to signal tasks to stop
        self.audio_tx = None;

        // Stop the provider's stream
        if let Some(ref mut provider) = self.active_provider {
            provider
                .stop_stream()
                .await
                .map_err(|e| format!("Failed to stop STT stream: {}", e))?;
        }

        self.is_processing = false;
        log::info!("STTRouter: Processing stopped");
        Ok(())
    }

    /// Feed an audio chunk directly to the active provider.
    /// This is used when the processing loop is managed externally.
    pub async fn feed_audio(&mut self, chunk: AudioChunk) -> Result<(), String> {
        if let Some(ref mut provider) = self.active_provider {
            provider
                .feed_audio(chunk)
                .await
                .map_err(|e| format!("Failed to feed audio: {}", e))
        } else {
            Err("No STT provider active".to_string())
        }
    }

    /// Set the recognition language.
    pub fn set_language(&mut self, language: &str) {
        self.language = language.to_string();
        if let Some(ref mut provider) = self.active_provider {
            provider.set_language(language);
        }
    }

    /// Set the Deepgram API key.
    pub fn set_deepgram_api_key(&mut self, key: &str) {
        self.deepgram_api_key = Some(key.to_string());

        // If Deepgram is the active provider, recreate with new key + current config
        if self.active_type == Some(STTProviderType::Deepgram) {
            let mut p = deepgram::DeepgramSTT::with_api_key(key);
            p.set_language(&self.language);
            p.set_config(self.deepgram_config.clone());
            self.active_provider = Some(Box::new(p));
        }
    }

    /// Update the Deepgram feature/model config.
    /// If Deepgram is the active provider, recreates it so the next connection uses the new config.
    pub fn set_deepgram_config(&mut self, config: deepgram::DeepgramConfig) {
        self.deepgram_config = config.clone();

        if self.active_type == Some(STTProviderType::Deepgram) {
            let mut p = deepgram::DeepgramSTT::new();
            if let Some(ref key) = self.deepgram_api_key {
                p.set_api_key(key);
            }
            p.set_language(&self.language);
            p.set_config(config);
            self.active_provider = Some(Box::new(p));
            log::info!("STTRouter: Deepgram provider recreated with new config");
        }
    }

    /// Update the Groq Whisper configuration.
    /// If Groq is the active provider, recreates it so the next connection uses the new config.
    pub fn set_groq_config(&mut self, config: groq_whisper::GroqConfig) {
        self.groq_config = config.clone();

        if self.active_type == Some(STTProviderType::GroqWhisper) {
            let mut p = groq_whisper::GroqWhisperSTT::new();
            if let Some(ref key) = self.groq_whisper_api_key {
                p.set_api_key(key);
            }
            p.set_config(config);
            p.set_language(&self.language); // must be after set_config — set_config overwrites language
            self.active_provider = Some(Box::new(p));
            log::info!("STTRouter: Groq provider recreated with new config");
        }
    }

    /// Set the OpenAI Whisper API key.
    pub fn set_whisper_api_key(&mut self, key: &str) {
        self.whisper_api_key = Some(key.to_string());

        if self.active_type == Some(STTProviderType::WhisperApi) {
            let mut p = whisper_api::WhisperApiSTT::with_api_key(key);
            p.set_language(&self.language);
            self.active_provider = Some(Box::new(p));
        }
    }

    /// Set the Azure Speech subscription key.
    pub fn set_azure_speech_key(&mut self, key: &str) {
        self.azure_speech_key = Some(key.to_string());

        if self.active_type == Some(STTProviderType::AzureSpeech) {
            let mut p = azure_speech::AzureSpeechSTT::new();
            p.set_subscription_key(key);
            if let Some(ref region) = self.azure_speech_region {
                p.set_region(region);
            }
            p.set_language(&self.language);
            self.active_provider = Some(Box::new(p));
        }
    }

    /// Set the Azure Speech region.
    pub fn set_azure_speech_region(&mut self, region: &str) {
        self.azure_speech_region = Some(region.to_string());

        if self.active_type == Some(STTProviderType::AzureSpeech) {
            let mut p = azure_speech::AzureSpeechSTT::new();
            if let Some(ref key) = self.azure_speech_key {
                p.set_subscription_key(key);
            }
            p.set_region(region);
            p.set_language(&self.language);
            self.active_provider = Some(Box::new(p));
        }
    }

    /// Set the Groq Whisper API key.
    pub fn set_groq_whisper_api_key(&mut self, key: &str) {
        self.groq_whisper_api_key = Some(key.to_string());

        if self.active_type == Some(STTProviderType::GroqWhisper) {
            let mut p = groq_whisper::GroqWhisperSTT::with_api_key(key);
            p.set_language(&self.language);
            self.active_provider = Some(Box::new(p));
        }
    }

    /// Test the connection for a given provider type.
    pub async fn test_provider_connection(
        &self,
        provider_type: &STTProviderType,
    ) -> Result<bool, String> {
        match provider_type {
            STTProviderType::WebSpeech => {
                // WebSpeech is always available in Chromium-based WebView
                Ok(true)
            }
            STTProviderType::WhisperCpp => {
                // WhisperCpp engine is always available; model availability
                // is checked at capture time.
                Ok(true)
            }
            STTProviderType::WindowsNative => {
                let provider = windows_native::WindowsNativeSTT::new();
                provider
                    .test_connection()
                    .await
                    .map_err(|e| format!("Connection test failed: {}", e))
            }
            STTProviderType::Deepgram => {
                let key = self
                    .deepgram_api_key
                    .as_deref()
                    .ok_or("No Deepgram API key configured")?;
                let provider = deepgram::DeepgramSTT::with_api_key(key);
                provider
                    .test_connection()
                    .await
                    .map_err(|e| format!("Connection test failed: {}", e))
            }
            STTProviderType::WhisperApi => {
                let key = self
                    .whisper_api_key
                    .as_deref()
                    .ok_or("No OpenAI API key configured")?;
                let provider = whisper_api::WhisperApiSTT::with_api_key(key);
                provider
                    .test_connection()
                    .await
                    .map_err(|e| format!("Connection test failed: {}", e))
            }
            STTProviderType::AzureSpeech => {
                let key = self
                    .azure_speech_key
                    .as_deref()
                    .ok_or("No Azure subscription key configured")?;
                let region = self
                    .azure_speech_region
                    .as_deref()
                    .ok_or("No Azure region configured")?;
                let provider = azure_speech::AzureSpeechSTT::with_config(key, region);
                provider
                    .test_connection()
                    .await
                    .map_err(|e| format!("Connection test failed: {}", e))
            }
            STTProviderType::GroqWhisper => {
                let key = self
                    .groq_whisper_api_key
                    .as_deref()
                    .ok_or("No Groq API key configured")?;
                let provider = groq_whisper::GroqWhisperSTT::with_api_key(key);
                provider
                    .test_connection()
                    .await
                    .map_err(|e| format!("Connection test failed: {}", e))
            }
            STTProviderType::SherpaOnnx | STTProviderType::OrtStreaming | STTProviderType::ParakeetTdt => {
                // Local engines — always "available" if a model is downloaded.
                // Model availability is checked at capture time in create_stt_provider_for_party.
                Ok(true)
            }
        }
    }

    /// Check if currently processing.
    pub fn is_processing(&self) -> bool {
        self.is_processing
    }

    /// Get the active provider type.
    pub fn active_provider_type(&self) -> Option<&STTProviderType> {
        self.active_type.as_ref()
    }

    /// Determine the speaker label based on the audio source.
    pub fn speaker_for_source(source: &AudioSource) -> &'static str {
        match source {
            AudioSource::Mic => "User",
            AudioSource::System => "Interviewer",
            AudioSource::Room => "Room",
        }
    }
}
