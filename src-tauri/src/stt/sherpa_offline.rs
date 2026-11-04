// Sherpa-ONNX offline (batch) STT provider.
//
// Handles non-streaming models like SenseVoice and Parakeet TDT (NeMo CTC)
// by accumulating audio chunks, writing them to a temp WAV file, and running
// the `sherpa-onnx-offline` program on each batch.
//
// This is inherently higher-latency than streaming (3–5s chunk delay) but
// supports the full range of sherpa-onnx non-streaming model architectures.

use async_trait::async_trait;
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// How many seconds of audio to accumulate before running offline recognition.
const BATCH_SECONDS: f32 = 3.0;

/// Sample rate expected by sherpa-onnx models.
const SAMPLE_RATE: u32 = 16_000;

/// Model architecture type (determines CLI flags).
#[derive(Debug, Clone, Copy)]
pub enum OfflineModelType {
    /// SenseVoice: `--sense-voice-model=...`
    SenseVoice,
    /// NeMo CTC (Parakeet TDT): `--nemo-ctc-model=...`
    NemoCtc,
}

/// Messages from feed_audio to the batch processing thread.
enum AudioMessage {
    Samples(Vec<i16>),
    Stop,
}

/// Sherpa-ONNX offline (batch) STT provider.
pub struct SherpaOfflineSTT {
    /// Path to the sherpa-onnx offline program.
    binary_path: PathBuf,
    /// Path to model.onnx or model.int8.onnx.
    model_path: PathBuf,
    /// Path to tokens.txt.
    tokens_path: PathBuf,
    /// Model architecture type.
    model_type: OfflineModelType,
    /// Provider type for identification.
    provider_type: STTProviderType,
    /// Recognition language code.
    language: String,
    /// Whether the stream is currently active.
    is_streaming: bool,
    /// Shared stop flag.
    stop_flag: Arc<AtomicBool>,
    /// Channel for sending audio to the batch processing thread.
    audio_tx: Option<std::sync::mpsc::Sender<AudioMessage>>,
    /// Handle to the batch processing thread.
    batch_thread: Option<std::thread::JoinHandle<()>>,
    /// Segment counter for unique IDs (shared with batch thread).
    segment_counter: Arc<AtomicU64>,
    /// Tauri app handle for debug events.
    app_handle: Option<AppHandle>,
}

impl SherpaOfflineSTT {
    pub fn new(
        binary_path: PathBuf,
        model_path: PathBuf,
        tokens_path: PathBuf,
        model_type: OfflineModelType,
        provider_type: STTProviderType,
    ) -> Self {
        Self {
            binary_path,
            model_path,
            tokens_path,
            model_type,
            provider_type,
            language: "en".to_string(),
            is_streaming: false,
            stop_flag: Arc::new(AtomicBool::new(false)),
            audio_tx: None,
            batch_thread: None,
            segment_counter: Arc::new(AtomicU64::new(0)),
            app_handle: None,
        }
    }

    pub fn set_language(&mut self, lang: &str) {
        self.language = lang.to_string();
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }
}

#[async_trait]
impl STTProvider for SherpaOfflineSTT {
    fn provider_name(&self) -> &str {
        match self.model_type {
            OfflineModelType::SenseVoice => "Sherpa-ONNX Offline (SenseVoice)",
            OfflineModelType::NemoCtc => "Sherpa-ONNX Offline (Parakeet TDT)",
        }
    }

    fn provider_type(&self) -> STTProviderType {
        self.provider_type.clone()
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        if !self.binary_path.exists() {
            return Err(format!(
                "sherpa-onnx-offline binary not found at: {}",
                self.binary_path.display()
            )
            .into());
        }

        self.stop_flag.store(false, AtomicOrdering::SeqCst);

        let (audio_tx, audio_rx) = std::sync::mpsc::channel::<AudioMessage>();
        self.audio_tx = Some(audio_tx);

        let binary_path = self.binary_path.clone();
        let model_path = self.model_path.clone();
        let tokens_path = self.tokens_path.clone();
        let model_type = self.model_type;
        let language = self.language.clone();
        let stop_flag = Arc::clone(&self.stop_flag);
        let segment_counter = Arc::clone(&self.segment_counter);
        let app_handle = self.app_handle.clone();

        // Working directory for DLL resolution
        let working_dir = binary_path
            .parent()
            .unwrap_or(&binary_path)
            .to_path_buf();

        let batch_thread = std::thread::spawn(move || {
            let batch_samples = (BATCH_SECONDS * SAMPLE_RATE as f32) as usize;
            let mut buffer: Vec<i16> = Vec::with_capacity(batch_samples);
            let mut segment_id = segment_counter.load(AtomicOrdering::Relaxed);

            loop {
                if stop_flag.load(AtomicOrdering::SeqCst) {
                    break;
                }

                // Receive audio samples
                match audio_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(AudioMessage::Samples(samples)) => {
                        buffer.extend_from_slice(&samples);
                    }
                    Ok(AudioMessage::Stop) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }

                // Process when we have enough audio
                if buffer.len() >= batch_samples {
                    let chunk = std::mem::take(&mut buffer);

                    // Write temp WAV file
                    let temp_dir = std::env::temp_dir();
                    let wav_path = temp_dir.join(format!(
                        "nexq_offline_stt_{}.wav",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                    ));

                    if let Err(e) = write_wav(&wav_path, &chunk, SAMPLE_RATE) {
                        log::error!("SherpaOfflineSTT: Failed to write temp WAV: {}", e);
                        continue;
                    }

                    // Verify model file exists before calling sidecar
                    if !model_path.exists() {
                        log::error!("SherpaOfflineSTT: Model file not found: {}", model_path.display());
                        if let Some(ref handle) = app_handle {
                            crate::stt::emit_stt_debug(handle, "error", "sherpa_offline",
                                &format!("Model file missing: {}", model_path.display()));
                        }
                        let _ = std::fs::remove_file(&wav_path);
                        continue;
                    }

                    // Build CLI arguments — use separate --flag value pairs
                    // (not --flag=value) because sherpa-onnx's Kaldi-style
                    // ParseOptions can misinterpret Windows paths with = format.
                    let model_flag = match model_type {
                        OfflineModelType::SenseVoice => "--sense-voice-model",
                        OfflineModelType::NemoCtc => "--nemo-ctc-model",
                    };
                    let model_str = model_path.to_string_lossy().to_string();
                    let tokens_str = tokens_path.to_string_lossy().to_string();

                    let mut args: Vec<String> = vec![
                        model_flag.to_string(), model_str,
                        "--tokens".to_string(), tokens_str,
                        "--num-threads".to_string(), "4".to_string(),
                        "--provider".to_string(), "cpu".to_string(),
                    ];

                    // SenseVoice-specific: set language and enable ITN
                    if matches!(model_type, OfflineModelType::SenseVoice) {
                        let sv_lang = match language.split('-').next().unwrap_or("en") {
                            "zh" => "zh",
                            "ja" => "ja",
                            "ko" => "ko",
                            "yue" => "yue",
                            _ => "en",
                        };
                        args.push("--sense-voice-language".to_string());
                        args.push(sv_lang.to_string());
                        args.push("--sense-voice-use-itn".to_string());
                        args.push("true".to_string());
                    }

                    args.push(wav_path.to_string_lossy().to_string());

                    log::debug!("SherpaOfflineSTT: cmd={} args={:?}", binary_path.display(), args);

                    // Run sherpa-onnx-offline
                    match std::process::Command::new(&binary_path)
                        .args(&args)
                        .current_dir(&working_dir)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .output()
                    {
                        Ok(output) => {
                            // Parse output — sherpa-onnx-offline prints result to stderr:
                            //   filename.wav
                            //     text: recognized text here
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            let stdout = String::from_utf8_lossy(&output.stdout);

                            let mut text = String::new();
                            // Check stderr first (sherpa-onnx prints results there)
                            for line in stderr.lines().chain(stdout.lines()) {
                                let trimmed = line.trim();
                                if trimmed.starts_with("text:") || trimmed.starts_with("text :") {
                                    text = trimmed
                                        .trim_start_matches("text:")
                                        .trim_start_matches("text :")
                                        .trim()
                                        .to_string();
                                    break;
                                }
                            }

                            if !text.is_empty() {
                                let timestamp_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64;

                                let result = TranscriptResult {
                                    text: text.clone(),
                                    is_final: true,
                                    confidence: 1.0,
                                    timestamp_ms,
                                    speaker: None,
                                    language: Some(language.clone()),
                                    segment_id: Some(segment_id.to_string()),
                                    duration_ms: None,
                                    speaker_tag: None,
                                    turn: None,
                                };

                                if let Err(e) = result_tx.blocking_send(result) {
                                    log::error!(
                                        "SherpaOfflineSTT: Failed to send result: {}",
                                        e
                                    );
                                    break;
                                }

                                if let Some(ref handle) = app_handle {
                                    crate::stt::emit_stt_debug(
                                        handle,
                                        "info",
                                        "sherpa_offline",
                                        &format!("Recognized: {}", text),
                                    );
                                }

                                segment_id += 1;
                                segment_counter.store(segment_id, AtomicOrdering::Relaxed);
                            } else if output.status.success() {
                                // Sidecar succeeded but no "text:" line found — log full output for debugging
                                let raw_stderr: String = stderr.chars().take(500).collect();
                                let raw_stdout: String = stdout.chars().take(500).collect();
                                log::warn!(
                                    "SherpaOfflineSTT: No text found in output. stderr=[{}] stdout=[{}]",
                                    raw_stderr, raw_stdout
                                );
                                if let Some(ref handle) = app_handle {
                                    let snippet = if !raw_stderr.is_empty() { &raw_stderr } else { &raw_stdout };
                                    crate::stt::emit_stt_debug(
                                        handle,
                                        "warn",
                                        "sherpa_offline",
                                        &format!("No text in output: {}", snippet.chars().take(300).collect::<String>()),
                                    );
                                }
                            }

                            if !output.status.success() {
                                let err = String::from_utf8_lossy(&output.stderr);
                                log::warn!(
                                    "SherpaOfflineSTT: Process exited with {}: {}",
                                    output.status,
                                    err.chars().take(200).collect::<String>()
                                );
                                if let Some(ref handle) = app_handle {
                                    crate::stt::emit_stt_debug(
                                        handle,
                                        "error",
                                        "sherpa_offline",
                                        &format!("Sidecar failed ({}): {}",
                                            output.status,
                                            err.chars().take(150).collect::<String>()),
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            log::error!(
                                "SherpaOfflineSTT: Failed to run binary: {}",
                                e
                            );
                            if let Some(ref handle) = app_handle {
                                crate::stt::emit_stt_debug(
                                    handle,
                                    "error",
                                    "sherpa_offline",
                                    &format!("Failed to run offline recognizer: {}", e),
                                );
                            }
                        }
                    }

                    // Clean up temp WAV
                    let _ = std::fs::remove_file(&wav_path);
                }
            }

            // Process any remaining audio in the buffer
            if !buffer.is_empty() && !stop_flag.load(AtomicOrdering::SeqCst) {
                let wav_path = std::env::temp_dir().join("nexq_offline_stt_final.wav");
                if write_wav(&wav_path, &buffer, SAMPLE_RATE).is_ok() && model_path.exists() {
                    let model_flag = match model_type {
                        OfflineModelType::SenseVoice => "--sense-voice-model",
                        OfflineModelType::NemoCtc => "--nemo-ctc-model",
                    };
                    let model_str = model_path.to_string_lossy().to_string();
                    let tokens_str = tokens_path.to_string_lossy().to_string();

                    let mut args: Vec<String> = vec![
                        model_flag.to_string(), model_str,
                        "--tokens".to_string(), tokens_str,
                        "--num-threads".to_string(), "4".to_string(),
                        "--provider".to_string(), "cpu".to_string(),
                    ];

                    if matches!(model_type, OfflineModelType::SenseVoice) {
                        let sv_lang = match language.split('-').next().unwrap_or("en") {
                            "zh" => "zh",
                            "ja" => "ja",
                            "ko" => "ko",
                            "yue" => "yue",
                            _ => "en",
                        };
                        args.push("--sense-voice-language".to_string());
                        args.push(sv_lang.to_string());
                        args.push("--sense-voice-use-itn".to_string());
                        args.push("true".to_string());
                    }

                    args.push(wav_path.to_string_lossy().to_string());

                    log::debug!("SherpaOfflineSTT: final cmd={} args={:?}", binary_path.display(), args);

                    if let Ok(output) = std::process::Command::new(&binary_path)
                        .args(&args)
                        .current_dir(&working_dir)
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .output()
                    {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        for line in stderr.lines().chain(stdout.lines()) {
                            let trimmed = line.trim();
                            if trimmed.starts_with("text:") || trimmed.starts_with("text :") {
                                let text = trimmed
                                    .trim_start_matches("text:")
                                    .trim_start_matches("text :")
                                    .trim()
                                    .to_string();
                                if !text.is_empty() {
                                    let _ = result_tx.blocking_send(TranscriptResult {
                                        text,
                                        is_final: true,
                                        confidence: 1.0,
                                        timestamp_ms: std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_millis()
                                            as u64,
                                        speaker: None,
                                        language: Some(language.clone()),
                                        segment_id: Some(segment_id.to_string()),
                                        duration_ms: None,
                                        speaker_tag: None,
                                        turn: None,
                                    });
                                }
                                break;
                            }
                        }
                    }
                    let _ = std::fs::remove_file(&wav_path);
                }
            }

            log::info!("SherpaOfflineSTT: batch processing thread exiting");
        });

        self.batch_thread = Some(batch_thread);
        self.is_streaming = true;

        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(ref tx) = self.audio_tx {
            let _ = tx.send(AudioMessage::Samples(chunk.pcm_data));
        }
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        Ok(self.binary_path.exists())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.stop_flag.store(true, AtomicOrdering::SeqCst);

        if let Some(tx) = self.audio_tx.take() {
            let _ = tx.send(AudioMessage::Stop);
        }

        if let Some(thread) = self.batch_thread.take() {
            let _ = thread.join();
        }

        self.is_streaming = false;
        Ok(())
    }

    fn set_language(&mut self, lang: &str) {
        self.language = lang.to_string();
    }
}

/// Write PCM i16 samples to a WAV file (mono, 16-bit, given sample rate).
fn write_wav(path: &std::path::Path, samples: &[i16], sample_rate: u32) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;

    let data_size = (samples.len() * 2) as u32;
    let file_size = 36 + data_size;

    // RIFF header
    file.write_all(b"RIFF")?;
    file.write_all(&file_size.to_le_bytes())?;
    file.write_all(b"WAVE")?;

    // fmt chunk
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?; // chunk size
    file.write_all(&1u16.to_le_bytes())?; // PCM format
    file.write_all(&1u16.to_le_bytes())?; // mono
    file.write_all(&sample_rate.to_le_bytes())?; // sample rate
    file.write_all(&(sample_rate * 2).to_le_bytes())?; // byte rate
    file.write_all(&2u16.to_le_bytes())?; // block align
    file.write_all(&16u16.to_le_bytes())?; // bits per sample

    // data chunk
    file.write_all(b"data")?;
    file.write_all(&data_size.to_le_bytes())?;

    // Write samples as little-endian i16
    for &sample in samples {
        file.write_all(&sample.to_le_bytes())?;
    }

    Ok(())
}

/// The sherpa-onnx offline program's file name on this platform.
pub const OFFLINE_BINARY: &str = if cfg!(windows) { "sherpa-onnx-offline.exe" } else { "sherpa-onnx-offline" };

/// Why a CTC or SenseVoice model can't start, for the Dev Log. NexQ doesn't
/// download the program those models run through.
pub fn missing_binary_message(models_base_dir: &std::path::Path) -> String {
    format!(
        "This model runs through the sherpa-onnx offline program ({OFFLINE_BINARY}), which NexQ doesn't download. \
         Use Parakeet TDT 0.6B v3, which runs inside NexQ, or place {OFFLINE_BINARY} in {}",
        models_base_dir.join("sherpa_onnx").join("sherpa-onnx-v<version>").join("bin").display()
    )
}

/// Find the sherpa-onnx offline program in the sherpa_onnx models directory:
/// `sherpa-onnx-v*/bin/` + [`OFFLINE_BINARY`] under the models base dir.
pub fn find_offline_binary(models_base_dir: &std::path::Path) -> Option<PathBuf> {
    let sherpa_dir = models_base_dir.join("sherpa_onnx");
    if !sherpa_dir.is_dir() {
        return None;
    }

    if let Ok(entries) = std::fs::read_dir(&sherpa_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("sherpa-onnx-v") && entry.path().is_dir() {
                let binary = entry.path().join("bin").join(OFFLINE_BINARY);
                if binary.exists() {
                    return Some(binary);
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_offline_program_under_its_platform_name() {
        let models = std::env::temp_dir().join(format!("nexq-sherpa-offline-{}", std::process::id()));
        let bin = models.join("sherpa_onnx").join("sherpa-onnx-v1.12.0").join("bin");
        let _ = std::fs::remove_dir_all(&models);
        std::fs::create_dir_all(&bin).unwrap();
        assert_eq!(find_offline_binary(&models), None);
        std::fs::write(bin.join(OFFLINE_BINARY), b"").unwrap();
        assert_eq!(find_offline_binary(&models), Some(bin.join(OFFLINE_BINARY)));
        assert_eq!(OFFLINE_BINARY.ends_with(".exe"), cfg!(windows));
        assert!(missing_binary_message(&models).contains("Parakeet TDT 0.6B v3"));
        let _ = std::fs::remove_dir_all(&models);
    }
}
