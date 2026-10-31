// Sub-PRD 3: Audio recording to WAV file
// Writes PCM data to file in a background thread
// Saves to %APPDATA%/com.nexq.app/recordings/{meeting_id}.wav

use hound::{SampleFormat, WavSpec, WavWriter};
use std::fs;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};

/// Sample rate for recorded audio (matches our pipeline target)
const RECORDING_SAMPLE_RATE: u32 = 16000;
/// Number of bits per sample
const BITS_PER_SAMPLE: u16 = 16;
/// Number of channels (mono)
const NUM_CHANNELS: u16 = 1;

/// Handle to an active recording session.
/// Dropping the handle will stop the recording.
pub struct RecorderHandle {
    /// Channel to send audio samples to the writer thread
    sample_tx: Option<std_mpsc::Sender<RecorderMessage>>,
    /// Writer thread join handle
    writer_thread: Option<std::thread::JoinHandle<Option<PathBuf>>>,
    /// Path where the recording will be saved
    output_path: PathBuf,
    /// Unix epoch milliseconds when recording started
    pub start_time_ms: u64,
}

enum RecorderMessage {
    /// Write these PCM samples to the WAV file
    Samples(Vec<i16>),
    /// Stop recording and finalize the file
    Stop,
}

impl RecorderHandle {
    /// Write PCM samples to the recording.
    /// Samples should be 16kHz mono 16-bit PCM.
    pub fn write_samples(&self, samples: &[i16]) {
        if samples.is_empty() {
            return;
        }
        if let Some(ref tx) = self.sample_tx {
            if tx.send(RecorderMessage::Samples(samples.to_vec())).is_err() {
                log::warn!("Recorder channel closed, samples dropped");
            }
        }
    }

    /// Stop the recording and finalize the WAV file.
    /// Returns the path to the saved recording.
    pub fn stop(mut self) -> Result<PathBuf, String> {
        // Send stop message
        if let Some(tx) = self.sample_tx.take() {
            let _ = tx.send(RecorderMessage::Stop);
        }

        // Wait for writer thread to finish
        if let Some(thread) = self.writer_thread.take() {
            match thread.join() {
                Ok(Some(path)) => {
                    log::info!("Recording saved to: {}", path.display());
                    Ok(path)
                }
                Ok(None) => Err("Recording failed: writer returned no path".to_string()),
                Err(_) => Err("Recording writer thread panicked".to_string()),
            }
        } else {
            Ok(self.output_path.clone())
        }
    }

    /// Get the output path (even before stopping).
    pub fn path(&self) -> &PathBuf {
        &self.output_path
    }
}

impl Drop for RecorderHandle {
    fn drop(&mut self) {
        // If not explicitly stopped, signal the writer to stop
        if let Some(tx) = self.sample_tx.take() {
            let _ = tx.send(RecorderMessage::Stop);
        }
        // We don't join here to avoid blocking on drop
    }
}

/// Get the recordings directory path.
/// Creates it if it doesn't exist.
fn get_recordings_dir() -> Result<PathBuf, String> {
    let app_data = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| {
            // Fallback for non-Windows or if APPDATA is not set
            dirs_fallback()
        })
        .map_err(|e| format!("Failed to find app data directory: {}", e))?;

    let recordings_dir = app_data.join("com.nexq.app").join("recordings");

    fs::create_dir_all(&recordings_dir)
        .map_err(|e| format!("Failed to create recordings directory: {}", e))?;

    Ok(recordings_dir)
}

/// Fallback for getting a suitable data directory
fn dirs_fallback() -> Result<PathBuf, String> {
    // Try common locations
    if let Ok(home) = std::env::var("HOME") {
        Ok(PathBuf::from(home).join(".config"))
    } else if let Ok(local) = std::env::var("LOCALAPPDATA") {
        Ok(PathBuf::from(local))
    } else {
        Err("Cannot determine data directory".to_string())
    }
}

/// Start recording audio to a WAV file.
///
/// Creates a new WAV file at `%APPDATA%/com.nexq.app/recordings/{meeting_id}.wav`
/// and spawns a background thread to write samples.
///
/// Returns a RecorderHandle for writing samples and stopping.
pub fn start_recording(meeting_id: &str) -> Result<RecorderHandle, String> {
    let recordings_dir = get_recordings_dir()?;
    start_recording_at(recordings_dir.join(format!("{}.wav", meeting_id)))
}

/// Start recording to `output_path`.
pub fn start_recording_at(output_path: PathBuf) -> Result<RecorderHandle, String> {
    log::info!("Starting recording to: {}", output_path.display());

    let spec = WavSpec {
        channels: NUM_CHANNELS,
        sample_rate: RECORDING_SAMPLE_RATE,
        bits_per_sample: BITS_PER_SAMPLE,
        sample_format: SampleFormat::Int,
    };

    let path_for_thread = output_path.clone();
    let (tx, rx) = std_mpsc::channel::<RecorderMessage>();

    let writer_thread = std::thread::Builder::new()
        .name("audio-recorder".into())
        .spawn(move || {
            recorder_thread_fn(path_for_thread, spec, rx)
        })
        .map_err(|e| format!("Failed to spawn recorder thread: {}", e))?;

    let start_time_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    Ok(RecorderHandle {
        sample_tx: Some(tx),
        writer_thread: Some(writer_thread),
        output_path,
        start_time_ms,
    })
}

/// The background writer thread function.
fn recorder_thread_fn(
    path: PathBuf,
    spec: WavSpec,
    rx: std_mpsc::Receiver<RecorderMessage>,
) -> Option<PathBuf> {
    let file = match fs::File::create(&path) {
        Ok(f) => f,
        Err(e) => {
            log::error!("Failed to create WAV file: {}", e);
            return None;
        }
    };

    let buf_writer = BufWriter::new(file);
    let mut writer = match WavWriter::new(buf_writer, spec) {
        Ok(w) => w,
        Err(e) => {
            log::error!("Failed to create WAV writer: {}", e);
            return None;
        }
    };

    let mut total_samples: u64 = 0;

    loop {
        match rx.recv() {
            Ok(RecorderMessage::Samples(samples)) => {
                for &sample in &samples {
                    if let Err(e) = writer.write_sample(sample) {
                        log::error!("Failed to write sample: {}", e);
                        // Try to finalize what we have
                        let _ = writer.finalize();
                        return Some(path);
                    }
                }
                total_samples += samples.len() as u64;
            }
            Ok(RecorderMessage::Stop) => {
                break;
            }
            Err(_) => {
                // Channel closed — sender dropped
                log::info!("Recorder channel closed, finalizing");
                break;
            }
        }
    }

    match writer.finalize() {
        Ok(()) => {
            let duration_secs = total_samples as f64 / RECORDING_SAMPLE_RATE as f64;
            log::info!(
                "Recording finalized: {} samples ({:.1}s) at {}",
                total_samples,
                duration_secs,
                path.display()
            );
            Some(path)
        }
        Err(e) => {
            log::error!("Failed to finalize WAV file: {}", e);
            Some(path)
        }
    }
}

/// A thread-safe wrapper for RecorderHandle that allows concurrent writes.
pub struct SharedRecorder {
    inner: Arc<Mutex<Option<RecorderHandle>>>,
    /// Unix epoch ms when recording started (copied at construction for lock-free reads).
    pub start_time_ms: u64,
}

impl SharedRecorder {
    pub fn new(handle: RecorderHandle) -> Self {
        let start_time_ms = handle.start_time_ms;
        Self {
            inner: Arc::new(Mutex::new(Some(handle))),
            start_time_ms,
        }
    }

    /// Write samples to the recording (thread-safe).
    pub fn write_samples(&self, samples: &[i16]) {
        if let Ok(guard) = self.inner.lock() {
            if let Some(ref handle) = *guard {
                handle.write_samples(samples);
            }
        }
    }

    /// Stop the recording and return the file path.
    pub fn stop(&self) -> Result<PathBuf, String> {
        let mut guard = self.inner.lock().map_err(|_| "Recorder lock poisoned".to_string())?;
        match guard.take() {
            Some(handle) => handle.stop(),
            None => Err("Recording already stopped".to_string()),
        }
    }

    /// Check if the recording is still active.
    pub fn is_active(&self) -> bool {
        self.inner
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }
}

impl Clone for SharedRecorder {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            start_time_ms: self.start_time_ms,
        }
    }
}
