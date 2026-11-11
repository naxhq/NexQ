use std::sync::atomic::AtomicBool;
#[cfg(not(target_os = "macos"))]
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

#[cfg(not(target_os = "macos"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::resampler::StreamResampler;
use super::{AudioChunk, AudioSource};

const TARGET_SAMPLE_RATE: u32 = 16000;

#[cfg(target_os = "macos")]
#[path = "macos_system_capture.rs"]
mod macos;

pub fn start_system_capture(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
) -> Result<std::thread::JoinHandle<()>, String> {
    start_system_capture_device(tx, stop_flag, None)
}

#[cfg(target_os = "macos")]
pub fn start_system_capture_device(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
    device_name: Option<String>,
) -> Result<std::thread::JoinHandle<()>, String> {
    macos::start(tx, stop_flag, device_name)
}

#[cfg(not(target_os = "macos"))]
pub fn start_system_capture_device(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
    device_name: Option<String>,
) -> Result<std::thread::JoinHandle<()>, String> {
    let label = device_name.as_deref().unwrap_or("default").to_string();
    log::info!("Starting system audio capture on: {}", label);

    // Everything runs inside the spawned thread because cpal::Stream is !Send.
    // The stream must be created and kept alive on the same thread; the thread
    // reports whether it started so the caller can warn the user.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let handle = std::thread::Builder::new()
        .name("system-audio-capture".into())
        .spawn(move || {
            if let Err(e) = run_cpal_loopback(tx, stop_flag, device_name, &ready_tx) {
                log::error!("System audio capture failed: {}", e);
                let _ = ready_tx.send(Err(e));
            }
        })
        .map_err(|e| format!("Failed to spawn system capture thread: {}", e))?;

    match ready_rx.recv_timeout(LOOPBACK_START_TIMEOUT) {
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

/// How long starting a meeting waits for the loopback stream to open.
#[cfg(not(target_os = "macos"))]
const LOOPBACK_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(not(target_os = "macos"))]
fn run_cpal_loopback(
    tx: mpsc::Sender<AudioChunk>,
    stop_flag: Arc<AtomicBool>,
    device_name: Option<String>,
    ready: &std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let host = cpal::default_host();

    let device = if let Some(ref name) = device_name {
        let mut found = None;
        if let Ok(devices) = host.output_devices() {
            for d in devices {
                if let Ok(d_name) = d.name() {
                    log::info!("  Output device: {}", d_name);
                    if d_name == *name {
                        found = Some(d);
                        break;
                    }
                }
            }
        }
        match found {
            Some(d) => d,
            None => {
                log::warn!("Output device '{}' not found, using default", name);
                host.default_output_device()
                    .ok_or_else(|| "No default output device".to_string())?
            }
        }
    } else {
        host.default_output_device()
            .ok_or_else(|| "No default output device".to_string())?
    };

    let actual_name = device.name().unwrap_or_else(|_| "unknown".into());
    log::info!("System loopback device: {}", actual_name);

    let config = device
        .default_output_config()
        .map_err(|e| format!("No output config for '{}': {}", actual_name, e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let sample_format = config.sample_format();
    log::info!("System capture: {}Hz, {}ch, {:?}", sample_rate, channels, sample_format);

    let err_fn = |err: cpal::StreamError| {
        log::error!("System capture error: {}", err);
    };

    let stop = stop_flag.clone();
    let tx2 = tx.clone();
    // Lives in the stream callback: keeps its place across chunks.
    let mut resampler = StreamResampler::new(sample_rate, TARGET_SAMPLE_RATE, channels);

    // Build INPUT stream on OUTPUT device = loopback capture
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if stop.load(Ordering::Relaxed) { return; }
                let pcm: Vec<i16> = data.iter()
                    .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                    .collect();
                send_system_chunk(&pcm, &mut resampler, &tx2);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                if stop.load(Ordering::Relaxed) { return; }
                send_system_chunk(data, &mut resampler, &tx2);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.into(),
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                if stop.load(Ordering::Relaxed) { return; }
                let pcm: Vec<i16> = data.iter()
                    .map(|&s| (s as i32 - 32768) as i16)
                    .collect();
                send_system_chunk(&pcm, &mut resampler, &tx2);
            },
            err_fn,
            None,
        ),
        _ => return Err(format!("Unsupported format: {:?}", sample_format)),
    }
    .map_err(|e| format!("Failed to build loopback stream on '{}': {}", actual_name, e))?;

    stream.play().map_err(|e| format!("Failed to play loopback stream: {}", e))?;
    log::info!("System audio loopback ACTIVE on '{}'", actual_name);
    let _ = ready.send(Ok(()));

    // Keep stream alive until stop flag
    while !stop_flag.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    drop(stream);
    log::info!("System audio loopback stopped");
    Ok(())
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
