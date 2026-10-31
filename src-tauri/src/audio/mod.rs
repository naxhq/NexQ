pub mod device_default;
pub mod device_manager;
pub mod encoder;
pub mod mic_capture;
pub mod recorder;
pub mod resampler;
pub mod session_monitor;
pub mod system_capture;
pub mod vad;
pub mod waveform;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::audio::recorder::SharedRecorder;
use crate::audio::vad::VoiceActivityDetector;

// ── Two-Party Model Types ──

/// Which side of the meeting this party represents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PartyRole {
    You,
    Them,
}

/// Per-party audio + STT configuration.
/// Each party independently selects an audio device and an STT provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartyAudioConfig {
    pub role: PartyRole,
    pub device_id: String,
    pub is_input_device: bool,
    /// "web_speech" | "whisper_cpp" | "deepgram" | "whisper_api" | "azure_speech" | "groq_whisper"
    pub stt_provider: String,
    /// Model ID for local STT engines (e.g., "base", "small", "medium").
    /// Only used when stt_provider is a local engine like "whisper_cpp".
    #[serde(default)]
    pub local_model_id: Option<String>,
}

/// Information about an active audio session on the system (per-app awareness).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub process_name: String,
    pub display_name: String,
    pub device_name: String,
    pub is_active: bool,
}

/// Coordinates mic + system capture threads and manages audio lifecycle.
pub struct AudioCaptureManager {
    pub is_capturing: bool,
    pub recording_enabled: bool,
    /// Stop flag for the system capture thread
    stop_flag: Arc<AtomicBool>,
    /// The cpal stream handle for mic capture (dropping stops the stream)
    mic_stream: Option<cpal::Stream>,
    /// The system capture thread handle (WASAPI loopback)
    system_thread: Option<std::thread::JoinHandle<()>>,
    /// System capture via input device (cpal stream, for virtual cables tagged as System)
    system_input_stream: Option<cpal::Stream>,
    /// What didn't start as chosen (a missing device replaced by the default,
    /// or one side not captured at all). Taken by the caller to warn the user.
    warnings: Vec<String>,
    /// Active recorder (if recording is enabled)
    recorder: Option<SharedRecorder>,
    /// When a device change paused capture with the recorder kept open: the
    /// restart fills the gap with silence so the recording stays in time.
    recording_paused_at: Option<std::time::Instant>,
    /// Current meeting ID for recording file naming
    meeting_id: Option<String>,
    /// VAD for mic audio
    mic_vad: VoiceActivityDetector,
    /// VAD for system audio
    system_vad: VoiceActivityDetector,
    /// Recent mic audio level (for UI)
    mic_level: f32,
    /// Recent mic peak level
    mic_peak: f32,
    /// Recent system audio level (for UI)
    system_level: f32,
    /// Recent system peak level
    system_peak: f32,
    // -- Audio test state --
    /// Temporary test stream for mic device testing
    pub test_stream: Option<cpal::Stream>,
    /// Temporary test thread for system audio (WASAPI loopback) testing
    pub test_system_thread: Option<std::thread::JoinHandle<()>>,
    /// Stop flag for system audio test thread
    pub test_stop_flag: Arc<AtomicBool>,
    /// Whether any non-silent audio was detected during test
    pub test_audio_detected: Arc<AtomicBool>,
}

impl AudioCaptureManager {
    pub fn new() -> Self {
        Self {
            is_capturing: false,
            recording_enabled: false,
            stop_flag: Arc::new(AtomicBool::new(false)),
            mic_stream: None,
            system_thread: None,
            system_input_stream: None,
            warnings: Vec::new(),
            recorder: None,
            recording_paused_at: None,
            meeting_id: None,
            mic_vad: VoiceActivityDetector::new(),
            system_vad: VoiceActivityDetector::new(),
            mic_level: 0.0,
            mic_peak: 0.0,
            system_level: 0.0,
            system_peak: 0.0,
            test_stream: None,
            test_system_thread: None,
            test_stop_flag: Arc::new(AtomicBool::new(false)),
            test_audio_detected: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Start capturing audio from both mic and system sources.
    ///
    /// `tx` is the channel where AudioChunks (with VAD applied) will be sent.
    /// The caller (typically the STT module) receives chunks from this channel.
    ///
    /// When `system_is_input` is true, the system device is an input device
    /// (e.g. a virtual cable like AudienceMix) — capture it via standard
    /// mic capture tagged as AudioSource::System instead of WASAPI loopback.
    pub fn start_capture(
        &mut self,
        mic_device_id: &str,
        system_device_id: &str,
        system_is_input: bool,
        tx: mpsc::Sender<AudioChunk>,
    ) -> Result<(), String> {
        if self.is_capturing {
            return Err("Capture already in progress".to_string());
        }

        log::info!("Starting audio capture pipeline");
        self.warnings.clear();
        // Why "You" isn't captured, if the mic (and the default mic) failed.
        let mut mic_error: Option<String> = None;
        // Why "Them" isn't captured, if their device failed.
        let mut system_error: Option<String> = None;

        // Reset stop flag
        self.stop_flag.store(false, Ordering::SeqCst);

        // Same-device optimization: when both parties use the same input device,
        // open ONE capture and duplicate chunks with both Mic + System tags.
        // This avoids two cpal streams contending for the same 256-slot channel.
        let same_device = system_is_input
            && !system_device_id.is_empty()
            && system_device_id != "default"
            && mic_device_id == system_device_id;

        if same_device {
            log::info!(
                "Same input device for mic & system ('{}') — single capture with dual tagging",
                mic_device_id
            );
            // Single capture that produces both Mic and System chunks
            let dual_tx = tx.clone();
            match mic_capture::start_mic_capture_dual(mic_device_id, dual_tx) {
                Ok(stream) => {
                    self.mic_stream = Some(stream);
                    log::info!("Dual-tagged capture started on shared device");
                }
                Err(e) => {
                    log::error!("Failed to start dual capture: {}", e);
                    return Err(format!("Dual capture failed: {}", e));
                }
            }
        } else {
            // Standard: separate mic capture
            match self.start_mic_or_default(mic_device_id, tx.clone()) {
                Ok(stream) => {
                    self.mic_stream = Some(stream);
                    log::info!("Mic capture started");
                }
                Err(e) => {
                    // Keep going: the other side may still be captured.
                    log::error!("Failed to start mic capture: {e}");
                    mic_error = Some(e);
                }
            }
        }

        // Start system audio capture (only if not already handled by same-device path)
        if same_device {
            // Already handled above — both Mic and System chunks from single stream
        } else if system_is_input {
            // "Them" is a different input device — capture tagged as System
            let system_tx = tx.clone();
            match mic_capture::start_mic_capture(system_device_id, system_tx, AudioSource::System) {
                Ok(stream) => {
                    self.system_input_stream = Some(stream);
                    log::info!("System audio capture started via input device (tagged as System)");
                }
                Err(e) => {
                    // Keep "You" running; the caller warns about the other side.
                    log::error!("System input capture failed: {e}. The other party won't be captured.");
                    system_error = Some(e);
                }
            }
        } else {
            let device_name = if system_device_id.is_empty() || system_device_id == "default" {
                None
            } else {
                Some(system_device_id.to_string())
            };
            let mut started = system_capture::start_system_capture_device(tx.clone(), Arc::clone(&self.stop_flag), device_name.clone());
            // A chosen output that isn't connected falls back to the default output.
            if let (Err(e), Some(name)) = (&started, &device_name) {
                log::warn!("Output '{name}' failed ({e}); capturing the default output instead");
                started = system_capture::start_system_capture_device(tx.clone(), Arc::clone(&self.stop_flag), None);
                if started.is_ok() {
                    self.warnings.push(format!(
                        "The other side's device '{name}' isn't available, so NexQ is capturing your default output instead."
                    ));
                }
            }
            match started {
                Ok(handle) => {
                    self.system_thread = Some(handle);
                    log::info!("System output audio capture started");
                }
                Err(e) => {
                    // Keep "You" running; the caller warns about the other side.
                    log::error!("System output capture failed: {e}. The other party won't be captured.");
                    system_error = Some(e);
                }
            }
        }

        match (mic_error, system_error) {
            (Some(mic), Some(system)) => {
                self.stop_flag.store(true, Ordering::SeqCst);
                self.mic_stream.take();
                self.system_input_stream.take();
                return Err(format!("Couldn't capture any audio. Microphone: {mic}. Other side: {system}"));
            }
            (Some(mic), None) => self.warnings.push(format!(
                "Couldn't capture your microphone ({mic}). The other side is still transcribed."
            )),
            (None, Some(system)) => self.warnings.push(format!(
                "Couldn't capture the other side ({system}). Your microphone is still transcribed."
            )),
            (None, None) => {}
        }

        self.resume_or_start_recording();

        self.is_capturing = true;
        log::info!("Audio capture pipeline started");
        Ok(())
    }

    /// What didn't start as chosen, once (see `warnings`).
    pub fn take_warnings(&mut self) -> Vec<String> {
        std::mem::take(&mut self.warnings)
    }

    /// Open `device_id` as the microphone, or the default microphone when the
    /// chosen one fails (a headset that's switched off).
    fn start_mic_or_default(&mut self, device_id: &str, tx: mpsc::Sender<AudioChunk>) -> Result<cpal::Stream, String> {
        match mic_capture::start_mic_capture(device_id, tx.clone(), AudioSource::Mic) {
            Err(e) if !device_id.is_empty() && device_id != "default" => {
                log::warn!("Microphone '{device_id}' failed ({e}); trying the default microphone");
                let stream = mic_capture::start_mic_capture("default", tx, AudioSource::Mic)
                    .map_err(|default_err| format!("{e}; the default microphone failed too: {default_err}"))?;
                self.warnings.push(format!(
                    "Your microphone '{device_id}' isn't available, so NexQ is using the default microphone."
                ));
                Ok(stream)
            }
            result => result,
        }
    }

    /// Stop all audio capture.
    /// Returns (wav_path, start_time_ms) if a recording was active.
    ///
    /// `keep_recording` (a device change mid-meeting): the recorder stays
    /// open and the next `start_capture` keeps writing to it.
    pub fn stop_capture(&mut self, keep_recording: bool) -> Option<(std::path::PathBuf, u64)> {
        if self.is_capturing {
            self.stop_streams();
        }
        if keep_recording {
            if self.recorder.is_some() && self.recording_paused_at.is_none() {
                self.recording_paused_at = Some(std::time::Instant::now());
            }
            return None;
        }
        // Also when the restart after a device change failed: the recording
        // kept open for it is finalized here.
        self.recording_paused_at = None;
        self.stop_recording_internal()
    }

    fn stop_streams(&mut self) {
        log::info!("Stopping audio capture pipeline");

        // Signal system capture thread to stop
        self.stop_flag.store(true, Ordering::SeqCst);

        // Drop the mic stream (this stops cpal capture)
        self.mic_stream.take();

        // Drop system input stream (if using input device capture for "Them")
        self.system_input_stream.take();

        // Wait for system capture thread to finish (with timeout)
        if let Some(thread) = self.system_thread.take() {
            // Give the thread a moment to stop, then move on
            let _ = thread.join();
        }

        // Reset VADs
        self.mic_vad.reset();
        self.system_vad.reset();

        self.is_capturing = false;
        log::info!("Audio capture pipeline stopped");
    }

    /// Check if capture is active.
    pub fn is_capturing(&self) -> bool {
        self.is_capturing
    }

    /// Enable or disable recording to file.
    pub fn set_recording_enabled(&mut self, enabled: bool) {
        self.recording_enabled = enabled;

        if self.is_capturing {
            if enabled && self.recorder.is_none() {
                self.start_recording_internal();
            } else if !enabled && self.recorder.is_some() {
                self.stop_recording_internal();
            }
        }

        log::info!("Recording {}", if enabled { "enabled" } else { "disabled" });
    }

    /// Set the meeting ID for file naming.
    pub fn set_meeting_id(&mut self, meeting_id: String) {
        self.meeting_id = Some(meeting_id);
    }

    /// Process an audio chunk through VAD and optionally record it.
    /// Returns a new chunk with `is_speech` set correctly.
    pub fn process_chunk(&mut self, mut chunk: AudioChunk) -> AudioChunk {
        match chunk.source {
            AudioSource::Mic => {
                let vad_result = self.mic_vad.process_chunk(&chunk.pcm_data);
                chunk.is_speech = vad_result.is_speech;
                self.mic_level = vad_result.energy;
                self.mic_peak = vad::calculate_peak(&chunk.pcm_data);
            }
            AudioSource::System => {
                let vad_result = self.system_vad.process_chunk(&chunk.pcm_data);
                chunk.is_speech = vad_result.is_speech;
                self.system_level = vad_result.energy;
                self.system_peak = vad::calculate_peak(&chunk.pcm_data);
            }
            AudioSource::Room => {
                // In-person mode: Room audio uses the mic VAD pipeline but
                // reports levels as both mic and system (since it's a single shared source).
                let vad_result = self.mic_vad.process_chunk(&chunk.pcm_data);
                chunk.is_speech = vad_result.is_speech;
                self.mic_level = vad_result.energy;
                self.mic_peak = vad::calculate_peak(&chunk.pcm_data);
                // Mirror to system level so UI shows activity on both meters
                self.system_level = vad_result.energy;
                self.system_peak = self.mic_peak;
            }
        }

        // Note: Recording is handled by the processing loops in audio_commands.rs
        // (with proper mic/system mixing). process_chunk only handles VAD + levels.

        chunk
    }

    /// Flush the mic/system mix buffers to the recorder.
    /// When `force` is true, flush all remaining samples (used at recording end).
    /// Otherwise, only flush when both buffers have samples.
    /// Get the current audio levels for UI display.
    pub fn get_audio_levels(&self) -> (AudioLevel, AudioLevel) {
        (
            AudioLevel {
                source: AudioSource::Mic,
                level: self.mic_level,
                peak: self.mic_peak,
            },
            AudioLevel {
                source: AudioSource::System,
                level: self.system_level,
                peak: self.system_peak,
            },
        )
    }

    /// Get a clone of the shared recorder (for use in audio processing pipeline).
    pub fn get_recorder(&self) -> Option<SharedRecorder> {
        self.recorder.clone()
    }

    /// Start a device test capture. Returns a channel receiver for audio chunks.
    /// For input devices: opens a mic capture stream.
    /// For output devices: starts WASAPI loopback capture.
    pub fn start_test(
        &mut self,
        device_id: &str,
        is_input: bool,
    ) -> Result<mpsc::Receiver<AudioChunk>, String> {
        // Stop any existing test first
        self.stop_test();

        let (tx, rx) = mpsc::channel::<AudioChunk>(64);
        self.test_audio_detected.store(false, Ordering::SeqCst);

        if is_input {
            let stream = mic_capture::start_mic_capture(device_id, tx, AudioSource::Mic)?;
            self.test_stream = Some(stream);
            log::info!("Audio test started for input device: {}", device_id);
        } else {
            // For output devices, use WASAPI loopback on the selected device
            self.test_stop_flag.store(false, Ordering::SeqCst);
            let stop_flag = Arc::clone(&self.test_stop_flag);
            let dev_name = if device_id.is_empty() || device_id == "default" {
                None
            } else {
                Some(device_id.to_string())
            };
            match system_capture::start_system_capture_device(tx, stop_flag, dev_name) {
                Ok(handle) => {
                    self.test_system_thread = Some(handle);
                    log::info!("Audio test started for output device: {}", device_id);
                }
                Err(e) => {
                    return Err(format!("System audio test failed: {}", e));
                }
            }
        }

        Ok(rx)
    }

    /// Stop a running device test and return whether audio was detected.
    pub fn stop_test(&mut self) -> bool {
        // Stop mic test stream
        self.test_stream.take();

        // Stop system audio test thread
        self.test_stop_flag.store(true, Ordering::SeqCst);
        if let Some(thread) = self.test_system_thread.take() {
            let _ = thread.join();
        }

        let detected = self.test_audio_detected.load(Ordering::SeqCst);
        log::info!(
            "Audio test stopped, audio detected: {}",
            detected
        );
        detected
    }

    /// Start recording if enabled, or keep writing the one a device change
    /// kept open (a new recorder would replace the meeting's audio so far).
    fn resume_or_start_recording(&mut self) {
        if let (Some(rec), Some(paused_at)) = (&self.recorder, self.recording_paused_at.take()) {
            rec.write_samples(&gap_silence(paused_at.elapsed()));
        } else if self.recording_enabled && self.recorder.is_none() {
            self.start_recording_internal();
        }
    }

    fn start_recording_internal(&mut self) {
        let meeting_id = self
            .meeting_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        match recorder::start_recording(&meeting_id) {
            Ok(handle) => {
                self.recorder = Some(SharedRecorder::new(handle));
                log::info!("Recording started for meeting: {}", meeting_id);
            }
            Err(e) => {
                log::error!("Failed to start recording: {}", e);
            }
        }
    }

    /// Stop the active recorder and return (wav_path, start_time_ms) if one was running.
    pub fn stop_recording_internal(&mut self) -> Option<(std::path::PathBuf, u64)> {
        if let Some(rec) = self.recorder.take() {
            let start_time_ms = rec.start_time_ms;
            match rec.stop() {
                Ok(path) => {
                    log::info!("Recording saved to: {}", path.display());
                    Some((path, start_time_ms))
                }
                Err(e) => {
                    log::error!("Failed to stop recording: {}", e);
                    None
                }
            }
        } else {
            None
        }
    }
}

impl Drop for AudioCaptureManager {
    fn drop(&mut self) {
        self.stop_capture(false);
    }
}

/// Silence for the time capture was paused by a device change (16 kHz mono),
/// at most a minute.
fn gap_silence(gap: std::time::Duration) -> Vec<i16> {
    let ms = gap.as_millis().min(60_000) as usize;
    vec![0; ms * 16]
}

/// The output contract consumed by STT (Sub-PRD 4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioChunk {
    pub pcm_data: Vec<i16>,
    pub source: AudioSource,
    pub timestamp_ms: u64,
    pub is_speech: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AudioSource {
    Mic,
    System,
    /// In-person meeting mode: single shared microphone capturing the room.
    Room,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_input: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDeviceList {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioLevel {
    pub source: AudioSource,
    pub level: f32,
    pub peak: f32,
}

/// Post-meeting recording pipeline.
///
/// Steps:
/// 1. Extract waveform peaks from WAV (CPU-bound, runs in spawn_blocking)
/// 2. Encode WAV → OGG/Opus (CPU-bound, runs in spawn_blocking)
/// 3. If Opus succeeds: delete WAV, use .ogg as recording_path
///    If Opus fails: keep WAV, use .wav as recording_path (graceful fallback)
/// 4. Write waveform JSON to <recordings_dir>/<meeting_id>.waveform.json
/// 5. Update DB with recording_path, recording_size, waveform_path, recording_offset_ms
/// 6. Emit "recording_ready" to frontend
///
/// Called via tokio::spawn from end_meeting — does NOT block the IPC response.
pub async fn process_recording(
    wav_path: std::path::PathBuf,
    meeting_id: String,
    recording_offset_ms: i64,
    db: std::sync::Arc<std::sync::Mutex<crate::db::DatabaseManager>>,
    app: tauri::AppHandle,
) {
    use tauri::Emitter;

    log::info!(
        "Post-meeting pipeline starting for meeting {} (wav: {}, offset: {}ms)",
        meeting_id,
        wav_path.display(),
        recording_offset_ms
    );

    let wav_path_clone = wav_path.clone();
    let meeting_id_clone = meeting_id.clone();

    // ── Step 1: Extract waveform peaks ────────────────────────────────────────
    let waveform_path = wav_path.with_extension("waveform.json");
    let waveform_path_clone = waveform_path.clone();
    let wav_for_waveform = wav_path.clone();

    let waveform_result = tokio::task::spawn_blocking(move || {
        match crate::audio::waveform::extract_peaks(&wav_for_waveform) {
            Ok(data) => {
                match crate::audio::waveform::write_waveform_json(&data, &waveform_path_clone) {
                    Ok(()) => {
                        log::info!("Waveform written to: {}", waveform_path_clone.display());
                        Ok(waveform_path_clone)
                    }
                    Err(e) => {
                        log::error!("Failed to write waveform JSON: {}", e);
                        Err(e)
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to extract waveform peaks: {}", e);
                Err(e)
            }
        }
    })
    .await;

    let waveform_path_result = match waveform_result {
        Ok(Ok(p)) => Some(p),
        Ok(Err(_)) => None,
        Err(e) => {
            log::error!("Waveform task panicked: {:?}", e);
            None
        }
    };

    // ── Step 2: Encode WAV → Opus ──────────────────────────────────────────────
    let opus_path = wav_path_clone.with_extension("ogg");
    let opus_path_clone = opus_path.clone();
    let wav_for_encode = wav_path_clone.clone();

    let encode_result = tokio::task::spawn_blocking(move || {
        crate::audio::encoder::encode_wav_to_opus(&wav_for_encode, &opus_path_clone)
    })
    .await;

    let (recording_path, recording_size) = match encode_result {
        Ok(Ok(size)) => {
            // Opus encoding succeeded — delete the WAV to save space
            if let Err(e) = std::fs::remove_file(&wav_path_clone) {
                log::warn!("Failed to delete WAV after Opus encoding: {}", e);
            }
            log::info!("Opus encoding succeeded ({} bytes), WAV deleted", size);
            (opus_path, size as i64)
        }
        Ok(Err(e)) => {
            // Encoding failed — fall back to WAV
            log::warn!("Opus encoding failed ({}), keeping WAV as fallback", e);
            let wav_size = std::fs::metadata(&wav_path_clone)
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            (wav_path_clone.clone(), wav_size)
        }
        Err(e) => {
            log::error!("Opus encoding task panicked: {:?}", e);
            let wav_size = std::fs::metadata(&wav_path_clone)
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            (wav_path_clone.clone(), wav_size)
        }
    };

    // ── Step 3: Update DB ──────────────────────────────────────────────────────
    let recording_path_str = recording_path.to_string_lossy().to_string();
    let waveform_path_str = waveform_path_result
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let db_result = {
        let db_guard = db.lock();
        match db_guard {
            Ok(guard) => {
                crate::db::meetings::update_meeting_recording(
                    guard.connection(),
                    &meeting_id_clone,
                    &recording_path_str,
                    recording_size,
                    &waveform_path_str,
                    recording_offset_ms,
                )
                .map_err(|e| e.to_string())
            }
            Err(e) => Err(format!("DB lock poisoned: {}", e)),
        }
    };

    if let Err(e) = db_result {
        log::error!("Failed to update DB with recording info: {}", e);
    } else {
        log::info!(
            "DB updated for meeting {}: path={}, size={}, offset={}ms",
            meeting_id_clone,
            recording_path_str,
            recording_size,
            recording_offset_ms
        );
    }

    // ── Step 4: Emit "recording_ready" to frontend ─────────────────────────────
    let payload = serde_json::json!({
        "meeting_id": meeting_id_clone,
        "recording_path": recording_path_str,
        "recording_size": recording_size,
        "waveform_path": waveform_path_str,
        "recording_offset_ms": recording_offset_ms,
    });

    if let Err(e) = app.emit("recording_ready", &payload) {
        log::error!("Failed to emit recording_ready event: {}", e);
    } else {
        log::info!("Emitted recording_ready for meeting {}", meeting_id_clone);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_wav(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-rec-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("meeting.wav")
    }

    /// A device change mid-meeting must not replace the recording: the
    /// recorder stays open and the gap becomes silence.
    #[test]
    fn a_device_change_keeps_the_recording() {
        let path = temp_wav("keep");
        let mut mgr = AudioCaptureManager::new();
        mgr.recording_enabled = true;
        let rec = SharedRecorder::new(recorder::start_recording_at(path.clone()).unwrap());
        let started = rec.start_time_ms;
        rec.write_samples(&[100; 16_000]); // 1 s before the change
        mgr.recorder = Some(rec);

        assert_eq!(mgr.stop_capture(true), None, "nothing to process yet");
        std::thread::sleep(std::time::Duration::from_millis(200));
        mgr.resume_or_start_recording();
        mgr.recorder.as_ref().unwrap().write_samples(&[100; 16_000]); // 1 s after

        let (saved, start_time_ms) = mgr.stop_capture(false).expect("recording info at End");
        assert_eq!((saved.as_path(), start_time_ms), (path.as_path(), started));
        let reader = hound::WavReader::open(&path).unwrap();
        let samples: Vec<i16> = reader.into_samples::<i16>().map(Result::unwrap).collect();
        assert!(samples.len() >= 32_000 + 3_200, "both parts and the gap: {}", samples.len());
        assert_eq!(samples[0], 100, "audio from before the change is still there");
        assert_eq!(samples[16_000], 0, "the gap is silence");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The restart after a device change failed: End still finalizes the recording.
    #[test]
    fn end_finalizes_a_kept_recording_without_capture() {
        let path = temp_wav("end");
        let mut mgr = AudioCaptureManager::new();
        mgr.recorder = Some(SharedRecorder::new(recorder::start_recording_at(path.clone()).unwrap()));
        mgr.stop_capture(true);
        assert!(mgr.stop_capture(false).is_some());
        assert!(mgr.recorder.is_none() && mgr.recording_paused_at.is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn gap_silence_is_capped_at_a_minute() {
        assert_eq!(gap_silence(std::time::Duration::from_millis(250)).len(), 4_000);
        assert_eq!(gap_silence(std::time::Duration::from_secs(600)).len(), 60 * 16_000);
    }
}