use std::sync::atomic::AtomicBool;
#[cfg(not(target_os = "macos"))]
use std::sync::atomic::Ordering;
use std::sync::mpsc::SyncSender;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

#[cfg(not(target_os = "macos"))]
use cpal::traits::{DeviceTrait, StreamTrait};

use super::capture_supervisor::{CaptureOpener, DeviceChoice, Opened, SideMessage};
use super::resampler::StreamResampler;
use super::{AudioChunk, AudioSource};

const TARGET_SAMPLE_RATE: u32 = 16000;

#[cfg(target_os = "macos")]
#[path = "macos_system_capture.rs"]
mod macos;

/// Opens the output "Them" listens to (WASAPI loopback, or the CoreAudio
/// output tap on macOS) for a supervised capture side. Every open sends into
/// the same `tx`.
pub struct OutputOpener {
    pub tx: mpsc::Sender<AudioChunk>,
    /// The side's channel: stream errors go there.
    pub errors: SyncSender<SideMessage>,
}

#[cfg(not(target_os = "macos"))]
impl CaptureOpener for OutputOpener {
    type Stream = cpal::Stream;

    fn open(&mut self, choice: &DeviceChoice, generation: u64) -> Result<Opened<cpal::Stream>, String> {
        let device_id = match choice {
            DeviceChoice::Chosen(name) => name.as_str(),
            DeviceChoice::Default => "default",
        };
        let device = super::device_manager::find_output_device(device_id)?;
        let device_name = super::device_manager::device_name(&device).unwrap_or_else(|_| "unknown".into());
        let err_fn = super::capture_supervisor::error_callback(
            self.errors.clone(),
            super::capture_supervisor::CaptureSide::Them,
            generation,
        );
        let stream = open_loopback_stream(&device, &device_name, self.tx.clone(), err_fn)?;
        Ok(Opened { stream, device: device_name })
    }
}

/// The macOS output tap runs on its own thread; dropping this stops it.
#[cfg(target_os = "macos")]
pub struct TapStream {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "macos")]
impl Drop for TapStream {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(target_os = "macos")]
impl CaptureOpener for OutputOpener {
    type Stream = TapStream;

    fn open(&mut self, choice: &DeviceChoice, generation: u64) -> Result<Opened<TapStream>, String> {
        let name = match choice {
            DeviceChoice::Chosen(name) => Some(name.clone()),
            DeviceChoice::Default => None,
        };
        let stop = Arc::new(AtomicBool::new(false));
        // The tap ending on its own (its buffer layout changed) is the tap's
        // stream error: the side rebuilds it.
        let mut on_failure = super::capture_supervisor::error_callback(
            self.errors.clone(),
            super::capture_supervisor::CaptureSide::Them,
            generation,
        );
        let thread = macos::start(
            self.tx.clone(),
            Arc::clone(&stop),
            name.clone(),
            Box::new(move |error| {
                on_failure(cpal::Error::with_message(cpal::ErrorKind::StreamInvalidated, error))
            }),
        )?;
        Ok(Opened {
            stream: TapStream { stop, thread: Some(thread) },
            device: name.unwrap_or_else(|| "default output".to_string()),
        })
    }
}

pub fn start_system_capture(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
) -> Result<std::thread::JoinHandle<()>, String> {
    start_system_capture_device(tx, stop_flag, None)
}

/// Unsupervised loopback capture until `stop_flag` (the device test in Settings).
#[cfg(target_os = "macos")]
pub fn start_system_capture_device(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
    device_name: Option<String>,
) -> Result<std::thread::JoinHandle<()>, String> {
    macos::start(tx, stop_flag, device_name, Box::new(|_| {}))
}

/// Unsupervised loopback capture until `stop_flag` (the device test in Settings).
#[cfg(not(target_os = "macos"))]
pub fn start_system_capture_device(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
    device_name: Option<String>,
) -> Result<std::thread::JoinHandle<()>, String> {
    let label = device_name.as_deref().unwrap_or("default").to_string();
    log::info!("Starting system audio capture on: {}", label);

    // The stream is created, kept alive and dropped on this one thread. The
    // thread reports whether it started so the caller can warn the user.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let handle = std::thread::Builder::new()
        .name("system-audio-test".into())
        .spawn(move || {
            let opened = super::device_manager::find_output_device(device_name.as_deref().unwrap_or("default"))
                .and_then(|device| {
                    let name = super::device_manager::device_name(&device).unwrap_or_else(|_| "unknown".into());
                    let err_fn = |err: cpal::Error| {
                        super::capture_common::log_stream_error("System capture error", &err);
                    };
                    open_loopback_stream(&device, &name, tx, err_fn)
                });
            let stream = match opened {
                Ok(stream) => stream,
                Err(e) => {
                    log::error!("System audio capture failed: {}", e);
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));
            while !stop_flag.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            drop(stream);
            log::info!("System audio loopback stopped");
        })
        .map_err(|e| format!("Failed to spawn system capture thread: {}", e))?;

    match ready_rx.recv_timeout(super::capture_supervisor::START_TIMEOUT) {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(e)) => Err(e),
        // Still opening (slow Bluetooth device): let it continue; errors are logged.
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            log::warn!("System capture on '{}' is slow to start", label);
            Ok(handle)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("System capture thread ended before starting".to_string())
        }
    }
}

/// Open and start a loopback stream (an input stream on an output device) on
/// `device`, any PCM format, resampled to 16 kHz mono and sent on `tx`.
#[cfg(not(target_os = "macos"))]
fn open_loopback_stream(
    device: &cpal::Device,
    device_name: &str,
    tx: mpsc::Sender<AudioChunk>,
    err_fn: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, String> {
    log::info!("System loopback device: {}", device_name);

    let config = device
        .default_output_config()
        .map_err(|e| format!("No output config for '{}': {}", device_name, e))?;

    let sample_rate = config.sample_rate();
    let channels = config.channels();
    let sample_format = config.sample_format();
    log::info!("System capture: {}Hz, {}ch, {:?}", sample_rate, channels, sample_format);

    // Lives in the stream callback: keeps its place across chunks.
    let mut resampler = StreamResampler::new(sample_rate, TARGET_SAMPLE_RATE, channels);

    // Build INPUT stream on OUTPUT device = loopback capture
    let stream = super::capture_common::build_pcm_input_stream(
        device,
        config.into(),
        sample_format,
        move |pcm| send_system_chunk(pcm, &mut resampler, &tx),
        err_fn,
    )
    .map_err(|e| format!("Failed to build loopback stream on '{}': {}", device_name, e))?;

    stream.play().map_err(|e| format!("Failed to play loopback stream: {}", e))?;
    log::info!("System audio loopback ACTIVE on '{}'", device_name);
    Ok(stream)
}

/// One capture stream's chunk: resampled to 16 kHz mono by that stream's own
/// `resampler` (one per stream, kept across its chunks) and sent on.
fn send_system_chunk(
    i16_data: &[i16],
    resampler: &mut StreamResampler,
    tx: &mpsc::Sender<AudioChunk>,
) {
    if i16_data.is_empty() {
        return;
    }

    let pcm_data = resampler.process(i16_data);
    if pcm_data.is_empty() {
        return; // a chunk too short to yield a 16 kHz sample
    }

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let chunk = AudioChunk {
        pcm_data,
        source: AudioSource::System,
        timestamp_ms,
        is_speech: false,
    };

    if tx.try_send(chunk).is_err() {
        // Channel full — drop chunk silently
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunk_too_short_for_a_sample_sends_nothing() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut resampler = StreamResampler::new(48_000, TARGET_SAMPLE_RATE, 1);
        send_system_chunk(&[1000], &mut resampler, &tx);
        assert!(rx.try_recv().is_err(), "an empty chunk was sent");

        let mut resampler = StreamResampler::new(48_000, TARGET_SAMPLE_RATE, 1);
        send_system_chunk(&[1000; 480], &mut resampler, &tx);
        assert_eq!(rx.try_recv().unwrap().pcm_data.len(), 160);
    }
}
