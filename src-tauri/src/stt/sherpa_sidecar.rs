// Sherpa-ONNX sidecar process STT provider.
//
// Spawns the sherpa-onnx streaming recognition binary as a child process,
// pipes PCM audio via stdin (little-endian i16 samples), and reads JSON-line
// results from stdout. Fully offline, true streaming transducer model.
//
// Fixes over original:
// - Uses model_discovery to find actual model file paths (epoch-based naming)
// - Captures stderr and surfaces errors to dev log
// - Sets working directory for DLL resolution

use async_trait::async_trait;
use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::audio::AudioChunk;
use crate::stt::provider::{STTProvider, STTProviderType, TranscriptResult};

/// JSON line format emitted by sherpa-onnx-cli on stdout.
#[derive(Debug, Deserialize)]
struct SherpaJsonLine {
    text: String,
    #[serde(default)]
    is_endpoint: bool,
    #[serde(default)]
    segment_id: u64,
    #[serde(default)]
    #[allow(dead_code)]
    start_time: f64,
    #[serde(default)]
    end_time: f64,
}

/// Sherpa-ONNX sidecar STT provider.
pub struct SherpaSidecarSTT {
    /// Path to the sherpa-onnx streaming recognition binary.
    binary_path: PathBuf,
    /// Directory containing the model files (encoder, decoder, joiner, tokens).
    model_dir: PathBuf,
    /// Recognition language code.
    language: String,
    /// Whether the stream is currently active.
    is_streaming: bool,
    /// Channel sender for transcript results (set during start_stream).
    result_tx: Option<mpsc::Sender<TranscriptResult>>,
    /// Shared stop flag for coordinating shutdown across tasks.
    stop_flag: Arc<AtomicBool>,
    /// Handle to the child process.
    child: Option<std::process::Child>,
    /// Channel for sending raw PCM bytes to the stdin writer task.
    stdin_tx: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    /// Handle to the blocking stdin writer task.
    stdin_task: Option<JoinHandle<()>>,
    /// Handle to the blocking stdout reader task.
    stdout_task: Option<JoinHandle<()>>,
    /// Handle to the blocking stderr reader task.
    stderr_task: Option<JoinHandle<()>>,
    /// Tauri app handle for emitting debug events.
    app_handle: Option<AppHandle>,
}

impl SherpaSidecarSTT {
    pub fn new(binary_path: PathBuf, model_dir: PathBuf) -> Self {
        Self {
            binary_path,
            model_dir,
            language: "en".to_string(),
            is_streaming: false,
            result_tx: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            child: None,
            stdin_tx: None,
            stdin_task: None,
            stdout_task: None,
            stderr_task: None,
            app_handle: None,
        }
    }

    pub fn set_app_handle(&mut self, handle: AppHandle) {
        self.app_handle = Some(handle);
    }

    /// Emit debug info to both Rust log and frontend dev log.
    fn debug(&self, level: &str, msg: &str) {
        match level {
            "error" => log::error!("[sherpa_sidecar] {}", msg),
            "warn" => log::warn!("[sherpa_sidecar] {}", msg),
            _ => log::info!("[sherpa_sidecar] {}", msg),
        }
        if let Some(ref handle) = self.app_handle {
            crate::stt::emit_stt_debug(handle, level, "sherpa_sidecar", msg);
        }
    }

    /// Build the argument list for the sherpa-onnx streaming recognition binary.
    /// Uses model_discovery to find actual file paths.
    fn build_args(&self) -> Result<Vec<String>, String> {
        let model_files =
            crate::stt::local_engines::model_discovery::discover_model_files(&self.model_dir)?;

        Ok(vec![
            format!("--encoder={}", model_files.encoder.display()),
            format!("--decoder={}", model_files.decoder.display()),
            format!("--joiner={}", model_files.joiner.display()),
            format!("--tokens={}", model_files.tokens.display()),
            "--provider=cpu".to_string(),
            "--num-threads=4".to_string(),
            "--sample-rate=16000".to_string(),
            "--enable-endpoint=1".to_string(),
            "--rule1-min-trailing-silence=1.2".to_string(),
            "--rule2-min-trailing-silence=2.4".to_string(),
            "--rule3-min-utterance-length=20".to_string(),
            "--input=stdin".to_string(),
            "--output-format=json".to_string(),
        ])
    }
}

#[async_trait]
impl STTProvider for SherpaSidecarSTT {
    fn provider_name(&self) -> &str {
        "Sherpa-ONNX (Local, Streaming)"
    }

    fn provider_type(&self) -> STTProviderType {
        STTProviderType::SherpaOnnx
    }

    async fn start_stream(
        &mut self,
        result_tx: mpsc::Sender<TranscriptResult>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.is_streaming {
            return Err("Stream already active".into());
        }

        // Verify the binary exists
        if !self.binary_path.exists() {
            return Err(format!(
                "Sherpa-ONNX binary not found at: {}",
                self.binary_path.display()
            )
            .into());
        }

        let args = self.build_args().map_err(|e| {
            format!("Failed to discover model files: {}", e)
        })?;

        self.debug(
            "info",
            &format!(
                "Spawning {} with {} args",
                self.binary_path.display(),
                args.len()
            ),
        );

        // Set working directory to binary's parent so companion DLLs are found
        let working_dir = self
            .binary_path
            .parent()
            .unwrap_or(&self.binary_path)
            .to_path_buf();

        // Spawn the child process with piped stdin/stdout/stderr
        let mut child = Command::new(&self.binary_path)
            .args(&args)
            .current_dir(&working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()) // Capture stderr instead of null
            .spawn()
            .map_err(|e| {
                format!(
                    "Failed to spawn sherpa-onnx at {}: {}",
                    self.binary_path.display(),
                    e
                )
            })?;

        // Take ownership of stdin, stdout, stderr
        let child_stdin = child
            .stdin
            .take()
            .ok_or("Failed to open stdin pipe to sherpa-onnx")?;
        let child_stdout = child
            .stdout
            .take()
            .ok_or("Failed to open stdout pipe from sherpa-onnx")?;
        let child_stderr = child
            .stderr
            .take()
            .ok_or("Failed to open stderr pipe from sherpa-onnx")?;

        self.stop_flag.store(false, AtomicOrdering::SeqCst);

        // ── Stdin writer task ──
        let (stdin_tx, stdin_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let stop_flag_stdin = Arc::clone(&self.stop_flag);

        let stdin_task = tokio::task::spawn_blocking(move || {
            let mut writer = child_stdin;
            loop {
                if stop_flag_stdin.load(AtomicOrdering::SeqCst) {
                    break;
                }
                match stdin_rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(bytes) => {
                        if let Err(e) = writer.write_all(&bytes) {
                            log::error!("SherpaSidecarSTT: stdin write error: {}", e);
                            break;
                        }
                        if let Err(e) = writer.flush() {
                            log::error!("SherpaSidecarSTT: stdin flush error: {}", e);
                            break;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            log::info!("SherpaSidecarSTT: stdin writer task exiting");
        });

        // ── Stdout reader task ──
        let stop_flag_stdout = Arc::clone(&self.stop_flag);
        let language = self.language.clone();
        let tx = result_tx.clone();

        // Capture wall-clock start time so we can convert process-relative
        // timestamps to absolute epoch time (survives mid-meeting restarts)
        let process_start_epoch_ms: u64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let stdout_task = tokio::task::spawn_blocking(move || {
            let reader = BufReader::new(child_stdout);
            for line_result in reader.lines() {
                if stop_flag_stdout.load(AtomicOrdering::SeqCst) {
                    break;
                }

                let line = match line_result {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!("SherpaSidecarSTT: stdout read error: {}", e);
                        break;
                    }
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let parsed: SherpaJsonLine = match serde_json::from_str(trimmed) {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!(
                            "SherpaSidecarSTT: Failed to parse JSON: {} (line: {})",
                            e,
                            trimmed
                        );
                        continue;
                    }
                };

                let text = parsed.text.trim().to_string();
                if text.is_empty() {
                    continue;
                }

                // Convert process-relative end_time to absolute epoch timestamp.
                // This ensures timestamps remain meaningful even after mid-meeting
                // provider restarts (the old code used raw end_time which reset to 0).
                let timestamp_ms = process_start_epoch_ms + (parsed.end_time * 1000.0) as u64;

                let result = TranscriptResult {
                    text,
                    is_final: parsed.is_endpoint,
                    confidence: if parsed.is_endpoint { 0.92 } else { 0.80 },
                    timestamp_ms,
                    speaker: None,
                    language: Some(language.clone()),
                    segment_id: Some(format!("sherpa_seg_{}", parsed.segment_id)),
                    duration_ms: None,
                    speaker_tag: None,
                    turn: None,
                };

                if let Err(e) = tx.blocking_send(result) {
                    log::error!("SherpaSidecarSTT: Failed to send result: {}", e);
                    break;
                }
            }

            log::info!("SherpaSidecarSTT: stdout reader task exiting");
        });

        // ── Stderr reader task — surfaces process errors to dev log ──
        let stop_flag_stderr = Arc::clone(&self.stop_flag);
        let stderr_app_handle = self.app_handle.clone();

        let stderr_task = tokio::task::spawn_blocking(move || {
            let reader = BufReader::new(child_stderr);
            for line_result in reader.lines() {
                if stop_flag_stderr.load(AtomicOrdering::SeqCst) {
                    break;
                }

                let line = match line_result {
                    Ok(l) => l,
                    Err(_) => break,
                };

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                // Surface to dev log
                log::info!("[sherpa-onnx stderr] {}", trimmed);
                if let Some(ref handle) = stderr_app_handle {
                    crate::stt::emit_stt_debug(
                        handle,
                        "info",
                        "sherpa_binary",
                        trimmed,
                    );
                }
            }
            log::info!("SherpaSidecarSTT: stderr reader task exiting");
        });

        self.child = Some(child);
        self.stdin_tx = Some(stdin_tx);
        self.stdin_task = Some(stdin_task);
        self.stdout_task = Some(stdout_task);
        self.stderr_task = Some(stderr_task);
        self.result_tx = Some(result_tx);
        self.is_streaming = true;

        self.debug("info", "Stream started");
        Ok(())
    }

    async fn feed_audio(
        &mut self,
        chunk: AudioChunk,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Err("Stream not active".into());
        }

        let stdin_tx = match self.stdin_tx {
            Some(ref tx) => tx,
            None => return Err("stdin channel not available".into()),
        };

        // Convert i16 PCM samples to little-endian bytes
        let mut bytes = Vec::with_capacity(chunk.pcm_data.len() * 2);
        for sample in &chunk.pcm_data {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }

        stdin_tx.send(bytes).map_err(|e| {
            format!(
                "SherpaSidecarSTT: Failed to send audio to stdin channel: {}",
                e
            )
        })?;

        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.is_streaming {
            return Ok(());
        }

        self.debug("info", "Stopping stream");

        self.stop_flag.store(true, AtomicOrdering::SeqCst);

        // Drop the stdin sender
        self.stdin_tx = None;

        // Wait for the stdin task
        if let Some(task) = self.stdin_task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }

        // Wait for the child process to exit gracefully
        // Take ownership to avoid borrow conflict with self.debug()
        if let Some(mut child) = self.child.take() {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.debug(
                            "info",
                            &format!("Child process exited: {}", status),
                        );
                        break;
                    }
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            self.debug(
                                "warn",
                                "Child process didn't exit in 2s, killing",
                            );
                            if let Err(e) = child.kill() {
                                log::error!(
                                    "SherpaSidecarSTT: kill failed: {}",
                                    e
                                );
                            }
                            let _ = child.wait();
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(e) => {
                        log::error!(
                            "SherpaSidecarSTT: wait error: {}",
                            e
                        );
                        break;
                    }
                }
            }
        }

        // Wait for stdout and stderr readers
        if let Some(task) = self.stdout_task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        if let Some(task) = self.stderr_task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }

        self.result_tx = None;
        self.is_streaming = false;

        self.debug("info", "Stream stopped");
        Ok(())
    }

    async fn test_connection(&self) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        if !self.binary_path.exists() {
            return Err(format!(
                "Binary not found: {}",
                self.binary_path.display()
            )
            .into());
        }
        // Also verify model files exist
        match crate::stt::local_engines::model_discovery::discover_model_files(&self.model_dir) {
            Ok(_) => Ok(true),
            Err(e) => Err(format!("Model files not found: {}", e).into()),
        }
    }

    fn set_language(&mut self, language: &str) {
        self.language = language
            .split('-')
            .next()
            .unwrap_or(language)
            .to_string();
        log::info!("SherpaSidecarSTT: Language set to {}", self.language);
    }
}
