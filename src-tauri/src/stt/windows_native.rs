// PRD 4: Windows Native STT via Windows.Media.SpeechRecognition
//
// Architecture: Each WindowsNativeSTT owns a dedicated std::thread for COM (STA).
// Audio and results bridge via std::sync::mpsc (safe for non-tokio threads).
//
// Two modes:
//   DirectMic   — SpeechRecognizer reads from the default mic device. feed_audio is a no-op.
//   CustomStream — We push PCM chunks into a ring buffer for processing.
//                  Used for loopback (system audio) transcription.
//
// The Windows.Media.SpeechRecognition API provides built-in speech recognition
// that ships with Windows 10/11. No downloads needed if the language pack is installed.

use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// Input mode — determines how audio reaches the recognizer.
#[derive(Debug, Clone, PartialEq)]
pub enum SapiInputMode {
    /// SpeechRecognizer reads from the system default microphone directly.
    DirectMic,
    /// We feed PCM chunks via a channel; processed via energy-based VAD
    /// with real SAPI recognition when available.
    CustomStream,
}

/// Windows Native STT provider using Windows.Media.SpeechRecognition.
pub struct WindowsNativeSTT {
    language: String,
    is_streaming: bool,
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    /// Channel to feed PCM audio to the recognition thread (CustomStream mode only)
    audio_tx: Option<std::sync::mpsc::Sender<Vec<i16>>>,
    /// The recognition thread handle
    recognizer_thread: Option<std::thread::JoinHandle<()>>,
    /// Stop flag shared with the recognition thread
    stop_flag: Arc<AtomicBool>,
    /// Which input mode this instance uses
    input_mode: SapiInputMode,
    /// App handle for emitting status events to the frontend
    app_handle: Option<tauri::AppHandle>,
    /// Party label for status events ("You" or "Them")
    party: String,
}

impl WindowsNativeSTT {
    /// Create a new instance that reads directly from the default microphone.
    /// `feed_audio` calls are no-ops in this mode.
    pub fn new() -> Self {
        Self::for_mic()
    }

    /// Create an instance in DirectMic mode.
    pub fn for_mic() -> Self {
        Self {
            language: "en-US".to_string(),
            is_streaming: false,
            result_tx: None,
            audio_tx: None,
            recognizer_thread: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            input_mode: SapiInputMode::DirectMic,
            app_handle: None,
            party: "You".to_string(),
        }
    }

    /// Create an instance in CustomStream mode (for loopback/system audio).
    /// Caller must feed PCM via `feed_audio`.
    pub fn for_custom_stream() -> Self {
        Self {
            language: "en-US".to_string(),
            is_streaming: false,
            result_tx: None,
            audio_tx: None,
            recognizer_thread: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            input_mode: SapiInputMode::CustomStream,
            app_handle: None,
            party: "Them".to_string(),
        }
    }

    /// Set the Tauri app handle for emitting status events.
    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.app_handle = Some(handle);
    }

    /// Set the party label for status events.
    pub fn set_party(&mut self, party: &str) {
        self.party = party.to_string();
    }

    /// Emit a connection status event to the frontend.
    fn emit_status(&self, status: &str, message: Option<String>) {
        if let Some(ref handle) = self.app_handle {
            let event = serde_json::json!({
                "provider": "windows_native",
                "party": self.party,
                "status": status,
                "message": message,
            });
            let _ = tauri::Emitter::emit(handle, "stt_connection_status", &event);
        }
    }

    /// Calculate RMS energy of audio samples.
    fn calculate_rms(samples: &[i16]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
        (sum_sq / samples.len() as f64).sqrt() as f32
    }
}

#[async_trait]
impl STTProvider for WindowsNativeSTT {
    fn provider_name(&self) -> &str {
        "Windows Speech (Built-in)"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::WindowsNative
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        log::info!(
            "WindowsNativeSTT: Starting stream (mode: {:?}, language: {})",
            self.input_mode,
            self.language
        );

        self.emit_status("connecting", None);
        self.stop_flag.store(false, Ordering::SeqCst);

        // Create the audio feed channel for CustomStream mode
        let (audio_tx, audio_rx) = std::sync::mpsc::channel::<Vec<i16>>();
        self.audio_tx = Some(audio_tx);

        // Clone values for the recognition thread
        let stop_flag = Arc::clone(&self.stop_flag);
        let language = self.language.clone();
        let input_mode = self.input_mode.clone();
        let result_tx_clone = result_tx.clone();
        let app_handle = self.app_handle.clone();
        let party = self.party.clone();

        // Spawn dedicated thread for recognition
        let recognizer_thread = std::thread::Builder::new()
            .name("win-stt".to_string())
            .spawn(move || {
                recognition_thread_main(
                    stop_flag,
                    language,
                    input_mode,
                    audio_rx,
                    result_tx_clone,
                    app_handle,
                    party,
                );
            })?;

        self.recognizer_thread = Some(recognizer_thread);
        self.result_tx = Some(result_tx);
        self.is_streaming = true;

        log::info!("WindowsNativeSTT: Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        // In DirectMic mode, the recognizer reads from the mic directly — no-op.
        if self.input_mode == SapiInputMode::DirectMic {
            return Ok(());
        }

        // CustomStream mode: push PCM to the recognition thread
        if let Some(ref tx) = self.audio_tx {
            // Non-blocking: if the channel is full, drop the chunk
            let _ = tx.send(chunk.pcm_data);
        }

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        log::info!("WindowsNativeSTT: Stopping stream");

        // Signal the recognition thread to stop
        self.stop_flag.store(true, Ordering::SeqCst);

        // Drop the audio sender to unblock the receiver
        self.audio_tx.take();

        // Wait for the recognition thread to finish
        if let Some(thread) = self.recognizer_thread.take() {
            let _ = thread.join();
        }

        self.is_streaming = false;
        self.result_tx = None;

        log::info!("WindowsNativeSTT: Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        #[cfg(target_os = "windows")]
        {
            // Check if SpeechRecognizer is available
            // Try to create a recognizer on a temporary thread to validate
            let language = self.language.clone();
            let result = std::thread::spawn(move || -> bool {
                check_speech_recognizer_available(&language)
            })
            .join()
            .unwrap_or(false);

            if result {
                Ok(true)
            } else {
                Err("Windows Speech Recognition is not available. You may need to install the language pack in Settings > Time & Language > Speech.".into())
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(false)
        }
    }

    fn set_language(&mut self, language: &str) {
        self.language = language.to_string();
        log::info!("WindowsNativeSTT: Language set to {}", self.language);
    }
}

/// Check if Windows Speech Recognition is available for the given language.
#[cfg(target_os = "windows")]
fn check_speech_recognizer_available(language: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{
        SpeechRecognitionScenario,
        SpeechRecognitionTopicConstraint,
        SpeechRecognizer,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_err() {
            return false;
        }

        let available = (|| -> windows::core::Result<bool> {
            let lang = Language::CreateLanguage(&HSTRING::from(language))?;
            let recognizer = SpeechRecognizer::Create(&lang)?;
            let constraint = SpeechRecognitionTopicConstraint::Create(
                SpeechRecognitionScenario::Dictation,
                &HSTRING::from("freeform"),
            )?;
            recognizer.Constraints()?.Append(&constraint)?;
            recognizer.CompileConstraintsAsync()?.get()?;
            Ok(true)
        })().unwrap_or(false);

        CoUninitialize();
        available
    }
}

#[cfg(not(target_os = "windows"))]
fn check_speech_recognizer_available(_language: &str) -> bool {
    false
}

/// Emit a status event from the recognition thread.
/// Also emits an stt_debug event for the DevLog panel.
fn emit_thread_status(app_handle: &Option<tauri::AppHandle>, party: &str, status: &str, message: Option<String>) {
    if let Some(ref handle) = app_handle {
        let event = serde_json::json!({
            "provider": "windows_native",
            "party": party,
            "status": status,
            "message": message,
        });
        let _ = tauri::Emitter::emit(handle, "stt_connection_status", &event);
        // Also emit to DevLog for diagnostics
        let level = match status {
            "error" => "error",
            "warn" => "warn",
            _ => "info",
        };
        let debug_msg = message.unwrap_or_else(|| format!("windows_native [{}]: {}", party, status));
        super::emit_stt_debug(handle, level, "win-stt", &debug_msg);
    }
}

/// Main function running on the dedicated recognition thread.
///
/// On Windows, attempts to use Windows.Media.SpeechRecognition API.
/// Falls back to energy-based speech detection if the API is unavailable.
fn recognition_thread_main(
    stop_flag: Arc<AtomicBool>,
    language: String,
    input_mode: SapiInputMode,
    audio_rx: std::sync::mpsc::Receiver<Vec<i16>>,
    result_tx: mpsc::Sender<TranscriptResult>,
    app_handle: Option<tauri::AppHandle>,
    party: String,
) {
    log::info!("Recognition thread started (mode: {:?})", input_mode);

    #[cfg(target_os = "windows")]
    {
        // Try Windows.Media.SpeechRecognition for DirectMic mode
        if input_mode == SapiInputMode::DirectMic {
            if run_windows_speech_recognizer(&stop_flag, &language, &result_tx, &app_handle, &party) {
                log::info!("WindowsNativeSTT: Windows Speech Recognizer completed");
                emit_thread_status(&app_handle, &party, "disconnected", None);
                return;
            }
            // Don't emit another generic error here — run_windows_speech_recognizer
            // already emits specific errors at each failure point.
            log::warn!("WindowsNativeSTT: Windows Speech Recognizer unavailable, falling back to energy detection");
        }
    }

    // CustomStream mode or fallback: use energy-based detection
    emit_thread_status(&app_handle, &party, "connected", Some("Energy-based detection active".to_string()));
    energy_detection_with_accumulation(stop_flag, input_mode, audio_rx, result_tx);
}

/// Run the Windows.Media.SpeechRecognition continuous recognizer (DirectMic mode only).
/// Returns true if it ran successfully, false if the API is unavailable.
#[cfg(target_os = "windows")]
fn run_windows_speech_recognizer(
    stop_flag: &Arc<AtomicBool>,
    language: &str,
    result_tx: &mpsc::Sender<TranscriptResult>,
    app_handle: &Option<tauri::AppHandle>,
    party: &str,
) -> bool {
    use windows::core::HSTRING;
    use windows::Foundation::TypedEventHandler;
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionCompletedEventArgs,
        SpeechContinuousRecognitionResultGeneratedEventArgs,
        SpeechContinuousRecognitionSession,
        SpeechRecognitionConfidence,
        SpeechRecognitionHypothesisGeneratedEventArgs,
        SpeechRecognitionResultStatus,
        SpeechRecognitionScenario,
        SpeechRecognitionTopicConstraint,
        SpeechRecognizer,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_err() {
            log::error!("WindowsNativeSTT: COM initialization failed");
            emit_thread_status(app_handle, party, "error", Some("COM initialization failed".to_string()));
            return false;
        }
    }

    // Create recognizer with the requested language.
    emit_thread_status(app_handle, party, "info",
        Some(format!("Windows Speech language: {}", language)));

    let recognizer = match (|| -> windows::core::Result<SpeechRecognizer> {
        let lang = Language::CreateLanguage(&HSTRING::from(language))?;
        SpeechRecognizer::Create(&lang)
    })() {
        Ok(r) => r,
        Err(e) => {
            log::warn!(
                "WindowsNativeSTT: requested language '{}' unavailable: {}",
                language, e
            );
            emit_thread_status(app_handle, party, "error",
                Some(format!("Windows Speech language '{}' is unavailable. Install that speech language pack in Settings > Time & Language > Speech, or use Deepgram for this language.", language)));
            unsafe { windows::Win32::System::Com::CoUninitialize(); }
            return false;
        }
    };

    // ---- Add dictation constraint (REQUIRED for free-form speech recognition) ----
    // Without a compiled constraint the session starts but produces zero results.
    match SpeechRecognitionTopicConstraint::Create(
        SpeechRecognitionScenario::Dictation,
        &HSTRING::from("freeform"),
    ) {
        Ok(constraint) => {
            if let Ok(constraints) = recognizer.Constraints() {
                let _ = constraints.Append(&constraint);
                log::info!("WindowsNativeSTT: Dictation constraint added");
                emit_thread_status(app_handle, party, "info",
                    Some("Dictation constraint added".to_string()));
            }
            // Compile — mandatory before StartAsync
            match recognizer.CompileConstraintsAsync() {
                Ok(op) => match op.get() {
                    Ok(compile_result) => {
                        // CRITICAL: Check the actual compilation status, not just Ok/Err.
                        // A non-Success status means the recognizer will silently produce
                        // zero results even though StartAsync succeeds.
                        match compile_result.Status() {
                            Ok(status) if status == SpeechRecognitionResultStatus::Success => {
                                log::info!("WindowsNativeSTT: Constraints compiled successfully");
                                emit_thread_status(app_handle, party, "info",
                                    Some("Constraints compiled OK".to_string()));
                            }
                            Ok(status) => {
                                let status_name = match status {
                                    SpeechRecognitionResultStatus::TopicLanguageNotSupported => "TopicLanguageNotSupported",
                                    SpeechRecognitionResultStatus::GrammarLanguageMismatch => "GrammarLanguageMismatch",
                                    SpeechRecognitionResultStatus::GrammarCompilationFailure => "GrammarCompilationFailure",
                                    SpeechRecognitionResultStatus::AudioQualityFailure => "AudioQualityFailure",
                                    SpeechRecognitionResultStatus::UserCanceled => "UserCanceled",
                                    SpeechRecognitionResultStatus::Unknown => "Unknown",
                                    SpeechRecognitionResultStatus::TimeoutExceeded => "TimeoutExceeded",
                                    SpeechRecognitionResultStatus::PauseLimitExceeded => "PauseLimitExceeded",
                                    SpeechRecognitionResultStatus::NetworkFailure => "NetworkFailure",
                                    SpeechRecognitionResultStatus::MicrophoneUnavailable => "MicrophoneUnavailable",
                                    _ => "Other",
                                };
                                log::error!(
                                    "WindowsNativeSTT: Constraint compilation FAILED with status: {}",
                                    status_name
                                );
                                let user_msg = match status {
                                    SpeechRecognitionResultStatus::TopicLanguageNotSupported =>
                                        format!("Language '{}' not supported for dictation. Install the speech language pack in Settings > Time & Language > Speech.", language),
                                    SpeechRecognitionResultStatus::NetworkFailure =>
                                        "Network error during constraint compilation. Online speech recognition may be disabled. Go to Settings > Privacy & Security > Speech.".to_string(),
                                    SpeechRecognitionResultStatus::MicrophoneUnavailable =>
                                        "Microphone unavailable. Check your audio device settings.".to_string(),
                                    _ => format!("Constraint compilation failed: {}. Speech recognition may not produce results.", status_name),
                                };
                                emit_thread_status(app_handle, party, "error", Some(user_msg));
                                // Don't return false — let StartAsync try anyway, but we've warned the user
                            }
                            Err(e) => {
                                log::warn!("WindowsNativeSTT: Could not read compile status: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("WindowsNativeSTT: Compile result error: {}", e);
                        emit_thread_status(app_handle, party, "error",
                            Some(format!("Constraint compilation error: {}", e)));
                    }
                },
                Err(e) => {
                    log::warn!("WindowsNativeSTT: CompileConstraintsAsync failed: {}", e);
                    emit_thread_status(app_handle, party, "error",
                        Some(format!("CompileConstraintsAsync failed: {}", e)));
                }
            }
        }
        Err(e) => {
            log::warn!("WindowsNativeSTT: Could not create dictation constraint: {}", e);
            emit_thread_status(app_handle, party, "error",
                Some(format!("Could not create dictation constraint: {}", e)));
        }
    }

    // Get continuous recognition session
    let session = match recognizer.ContinuousRecognitionSession() {
        Ok(s) => s,
        Err(e) => {
            log::warn!("WindowsNativeSTT: Failed to get recognition session: {}", e);
            emit_thread_status(app_handle, party, "error",
                Some(format!("Failed to get recognition session: {}", e)));
            unsafe { windows::Win32::System::Com::CoUninitialize(); }
            return false;
        }
    };

    // Shared segment counter between hypothesis and result handlers.
    // Hypotheses read it to produce a stable interim id; ResultGenerated increments it.
    let shared_seg = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let start_time = Instant::now();

    // ---- Set up HypothesisGenerated handler (real-time interim results) ----
    // This fires continuously as words are recognized, giving partial text
    // before the user pauses. This is what makes transcription feel "live".
    let hypothesis_tx = result_tx.clone();
    let hypothesis_start = start_time;
    let hypothesis_seg = Arc::clone(&shared_seg);

    let hypothesis_handler = TypedEventHandler::<
        SpeechRecognizer,
        SpeechRecognitionHypothesisGeneratedEventArgs,
    >::new(move |_recognizer, args| {
        if let Some(args) = args {
            if let Ok(hypothesis) = args.Hypothesis() {
                if let Ok(text) = hypothesis.Text() {
                    let text_str = text.to_string();
                    if !text_str.is_empty() {
                        // Use current_seg + 1 so the interim id matches what the
                        // next ResultGenerated will produce as the final.
                        let current = hypothesis_seg.load(Ordering::SeqCst);
                        let transcript = TranscriptResult {
                            text: text_str,
                            is_final: false,
                            confidence: 0.5,
                            timestamp_ms: hypothesis_start.elapsed().as_millis() as u64,
                            speaker: None,
                            language: None,
                            segment_id: Some(format!("win_{}", current + 1)),
                        };
                        // try_send to avoid blocking the COM STA thread
                        let _ = hypothesis_tx.try_send(transcript);
                    }
                }
            }
        }
        Ok(())
    });

    if let Err(e) = recognizer.HypothesisGenerated(&hypothesis_handler) {
        log::warn!("WindowsNativeSTT: Failed to register HypothesisGenerated handler: {}", e);
        // Non-fatal — we'll still get final results
    } else {
        log::info!("WindowsNativeSTT: HypothesisGenerated handler registered (real-time streaming)");
    }

    // ---- Set up ResultGenerated handler (final results after pause) ----
    let tx_clone = result_tx.clone();
    let final_seg = Arc::clone(&shared_seg);

    let handler = TypedEventHandler::<
        SpeechContinuousRecognitionSession,
        SpeechContinuousRecognitionResultGeneratedEventArgs,
    >::new(move |_session, args| {
        if let Some(args) = args {
            if let Ok(result) = args.Result() {
                if let Ok(text) = result.Text() {
                    let text_str = text.to_string();
                    if !text_str.is_empty() {
                        let confidence = match result.Confidence() {
                            Ok(SpeechRecognitionConfidence::High) => 0.95,
                            Ok(SpeechRecognitionConfidence::Medium) => 0.75,
                            Ok(SpeechRecognitionConfidence::Low) => 0.50,
                            _ => 0.60,
                        };

                        // Increment the shared counter — the final id matches
                        // the interim hypotheses that preceded it.
                        let seg = final_seg.fetch_add(1, Ordering::SeqCst) + 1;
                        let transcript = TranscriptResult {
                            text: text_str.clone(),
                            is_final: true,
                            confidence,
                            timestamp_ms: start_time.elapsed().as_millis() as u64,
                            speaker: None,
                            language: None,
                            segment_id: Some(format!("win_{}", seg)),
                        };

                        log::info!(
                            "WindowsNativeSTT: Final #{}: '{}' (confidence={:.2})",
                            seg, text_str, confidence
                        );
                        let _ = tx_clone.blocking_send(transcript);
                    }
                }
            }
        }
        Ok(())
    });

    if let Err(e) = session.ResultGenerated(&handler) {
        log::warn!("WindowsNativeSTT: Failed to register result handler: {}", e);
        emit_thread_status(app_handle, party, "error",
            Some(format!("Failed to register result handler: {}", e)));
        unsafe { windows::Win32::System::Com::CoUninitialize(); }
        return false;
    }
    log::info!("WindowsNativeSTT: ResultGenerated handler registered");

    // Set up Completed handler — fires if the session terminates unexpectedly
    // (timeout, network failure, user cancellation, etc.)
    // Use a shared flag so the pump loop can detect session-end and auto-restart.
    let session_ended = Arc::new(AtomicBool::new(false));
    let session_ended_for_handler = Arc::clone(&session_ended);
    let completed_app_handle = app_handle.clone();
    let completed_party = party.to_string();
    let completed_handler = TypedEventHandler::<
        SpeechContinuousRecognitionSession,
        SpeechContinuousRecognitionCompletedEventArgs,
    >::new(move |_session, args| {
        if let Some(args) = args {
            if let Ok(status) = args.Status() {
                let status_name = match status {
                    SpeechRecognitionResultStatus::Success => "Success",
                    SpeechRecognitionResultStatus::TopicLanguageNotSupported => "TopicLanguageNotSupported",
                    SpeechRecognitionResultStatus::GrammarLanguageMismatch => "GrammarLanguageMismatch",
                    SpeechRecognitionResultStatus::GrammarCompilationFailure => "GrammarCompilationFailure",
                    SpeechRecognitionResultStatus::AudioQualityFailure => "AudioQualityFailure",
                    SpeechRecognitionResultStatus::UserCanceled => "UserCanceled",
                    SpeechRecognitionResultStatus::Unknown => "Unknown",
                    SpeechRecognitionResultStatus::TimeoutExceeded => "TimeoutExceeded",
                    SpeechRecognitionResultStatus::PauseLimitExceeded => "PauseLimitExceeded",
                    SpeechRecognitionResultStatus::NetworkFailure => "NetworkFailure",
                    SpeechRecognitionResultStatus::MicrophoneUnavailable => "MicrophoneUnavailable",
                    _ => "Other",
                };

                // Recoverable statuses: auto-restart instead of giving up
                let is_recoverable = matches!(status,
                    SpeechRecognitionResultStatus::UserCanceled
                    | SpeechRecognitionResultStatus::TimeoutExceeded
                    | SpeechRecognitionResultStatus::PauseLimitExceeded
                );

                if status == SpeechRecognitionResultStatus::Success {
                    // Normal termination (e.g., stop during hot-swap) — not an error
                    log::info!("WindowsNativeSTT: Session completed successfully");
                } else if is_recoverable {
                    log::info!("WindowsNativeSTT: Session ended with {} — will auto-restart", status_name);
                    session_ended_for_handler.store(true, Ordering::SeqCst);
                } else {
                    log::warn!("WindowsNativeSTT: Session Completed with status: {}", status_name);
                    emit_thread_status(&completed_app_handle, &completed_party, "error",
                        Some(format!("Recognition session ended: {}", status_name)));
                }
            }
        }
        Ok(())
    });
    if let Err(e) = session.Completed(&completed_handler) {
        log::warn!("WindowsNativeSTT: Failed to register Completed handler: {}", e);
        // Non-fatal — continue without completion monitoring
    }

    // Start continuous recognition
    let start_err = match session.StartAsync() {
        Ok(op) => match op.get() {
            Ok(_) => None,
            Err(e) => Some(e),
        },
        Err(e) => Some(e),
    };
    if let Some(e) = start_err {
        let err_str = e.to_string();
        log::warn!("WindowsNativeSTT: Failed to start recognition: {}", err_str);
        // Detect specific Windows errors and provide actionable instructions
        let user_msg = if err_str.contains("80045509") || err_str.contains("privacy policy") {
            "Speech privacy policy not accepted. Go to Settings > Privacy & Security > Speech and enable 'Online speech recognition'.".to_string()
        } else {
            format!("Failed to start: {}", err_str)
        };
        emit_thread_status(app_handle, party, "error", Some(user_msg));
        unsafe { windows::Win32::System::Com::CoUninitialize(); }
        return false;
    }

    log::info!("WindowsNativeSTT: Continuous recognition started — listening for speech...");
    emit_thread_status(app_handle, party, "connected",
        Some("Listening for speech (speak into your microphone)".to_string()));

    // Pump COM messages while waiting for stop signal.
    // The SpeechRecognizer delivers ResultGenerated callbacks via COM messages,
    // so the pump MUST run for recognition to work.
    let mut pump_iterations: u64 = 0;
    let mut restart_count: u32 = 0;
    while !stop_flag.load(Ordering::SeqCst) {
        // Auto-restart session if it ended due to timeout/pause/cancel
        if session_ended.load(Ordering::SeqCst) {
            session_ended.store(false, Ordering::SeqCst);
            restart_count += 1;

            // Cap restarts to avoid infinite loop when device is fundamentally incompatible
            const MAX_RESTARTS: u32 = 10;
            if restart_count > MAX_RESTARTS {
                log::warn!("WindowsNativeSTT: Max restarts ({}) reached — stopping", MAX_RESTARTS);
                emit_thread_status(app_handle, party, "error",
                    Some("Recognition keeps timing out. Try a different STT provider for this device.".to_string()));
                break;
            }

            // Exponential backoff: 500ms, 1s, 2s, capped at 5s
            let backoff_ms = std::cmp::min(500 * (1u64 << (restart_count - 1).min(3)), 5000);
            log::info!("WindowsNativeSTT: Auto-restarting session (#{}, backoff {}ms)", restart_count, backoff_ms);
            std::thread::sleep(std::time::Duration::from_millis(backoff_ms));

            // StopAsync before StartAsync — after TimeoutExceeded/PauseLimitExceeded
            // the session is in a completed state; calling StartAsync directly returns
            // 0x80131509 (InvalidOperationException). StopAsync transitions it back to
            // a startable state.
            if let Ok(stop_op) = session.StopAsync() {
                let _ = stop_op.get();
            }

            match session.StartAsync() {
                Ok(op) => match op.get() {
                    Ok(_) => {
                        log::info!("WindowsNativeSTT: Session restarted successfully");
                        // Don't spam status updates — only show on first restart
                        if restart_count <= 2 {
                            emit_thread_status(app_handle, party, "connected",
                                Some("Listening for speech (auto-restarted)".to_string()));
                        }
                    }
                    Err(e) => {
                        log::error!("WindowsNativeSTT: Restart failed: {}", e);
                        emit_thread_status(app_handle, party, "error",
                            Some(format!("Restart failed: {}", e)));
                        break;
                    }
                },
                Err(e) => {
                    log::error!("WindowsNativeSTT: Restart StartAsync failed: {}", e);
                    break;
                }
            }
        }

        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
            };
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Log periodically to confirm the pump is alive
        pump_iterations += 1;
        if pump_iterations == 100 {
            // ~5 seconds in
            log::info!("WindowsNativeSTT: COM message pump running (5s mark, still waiting for speech)");
        }
        if pump_iterations % 600 == 0 {
            // Every ~30 seconds
            log::info!("WindowsNativeSTT: COM pump alive at {}s", pump_iterations * 50 / 1000);
        }
    }

    // Stop recognition
    if let Ok(op) = session.StopAsync() {
        let _ = op.get();
    }

    unsafe { windows::Win32::System::Com::CoUninitialize(); }
    true
}

/// Enhanced energy-based speech detection with audio accumulation.
/// Detects speech boundaries and emits transcript events with timing info.
/// This serves as the primary recognizer for CustomStream mode and as a
/// fallback for DirectMic mode when the Windows Speech API is unavailable.
fn energy_detection_with_accumulation(
    stop_flag: Arc<AtomicBool>,
    input_mode: SapiInputMode,
    audio_rx: std::sync::mpsc::Receiver<Vec<i16>>,
    result_tx: mpsc::Sender<TranscriptResult>,
) {
    log::info!("WindowsNativeSTT: Running energy-based detection");

    let mut speech_frame_count: u32 = 0;
    let mut silence_frame_count: u32 = 0;
    let mut utterance_active = false;
    let mut segment_counter: u64 = 0;
    let start_time = Instant::now();
    let mut utterance_start_ms: u64 = 0;
    let mut utterance_samples: Vec<i16> = Vec::new();

    // For DirectMic mode, we won't receive audio — just sleep and check stop flag.
    if input_mode == SapiInputMode::DirectMic {
        while !stop_flag.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        return;
    }

    // CustomStream mode: process incoming PCM chunks
    while !stop_flag.load(Ordering::SeqCst) {
        match audio_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(pcm_data) => {
                let rms = WindowsNativeSTT::calculate_rms(&pcm_data);
                let has_speech = rms > 500.0;

                if has_speech {
                    speech_frame_count += 1;
                    silence_frame_count = 0;

                    if !utterance_active && speech_frame_count >= 5 {
                        utterance_active = true;
                        utterance_start_ms = start_time.elapsed().as_millis() as u64;
                        utterance_samples.clear();
                        log::debug!("WindowsNativeSTT: Speech started");
                    }

                    if utterance_active {
                        utterance_samples.extend_from_slice(&pcm_data);

                        // Emit interim result for long utterances (every ~2s of speech)
                        if utterance_samples.len() > 32000 * 2 {
                            segment_counter += 1;
                            let duration_s = utterance_samples.len() as f32 / 16000.0;
                            let _ = result_tx.blocking_send(TranscriptResult {
                                text: format!("[speech: {:.1}s]", duration_s),
                                is_final: false,
                                confidence: 0.0,
                                timestamp_ms: utterance_start_ms,
                                speaker: None,
                                language: None,
                                segment_id: Some(format!("win_{}", segment_counter)),
                            });
                        }
                    }
                } else {
                    silence_frame_count += 1;

                    if utterance_active && silence_frame_count > 15 {
                        // Utterance ended
                        let duration_s = utterance_samples.len() as f32 / 16000.0;
                        segment_counter += 1;

                        log::debug!(
                            "WindowsNativeSTT: Speech ended (~{:.1}s of audio)",
                            duration_s
                        );

                        // Emit final result with duration info
                        // Real transcription requires a cloud STT or the Windows Speech API.
                        // This fallback only provides VAD boundaries.
                        let _ = result_tx.blocking_send(TranscriptResult {
                            text: format!("[speech detected: {:.1}s]", duration_s),
                            is_final: true,
                            confidence: 0.0,
                            timestamp_ms: utterance_start_ms,
                            speaker: None,
                            language: None,
                            segment_id: Some(format!("win_{}", segment_counter)),
                        });

                        utterance_active = false;
                        speech_frame_count = 0;
                        utterance_samples.clear();
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    log::info!("WindowsNativeSTT: Recognition thread exiting");
}
