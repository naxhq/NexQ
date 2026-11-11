// Sub-PRD 3: Microphone capture via cpal
// 16kHz, 16-bit mono PCM, sends via tokio::sync::mpsc

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, Stream};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use super::resampler::StreamResampler;
use super::{AudioChunk, AudioSource};

/// Target sample rate for all audio output
const TARGET_SAMPLE_RATE: u32 = 16000;

/// Start capturing audio from the specified input device.
/// Returns a cpal::Stream handle — dropping it will stop the stream.
///
/// Audio is resampled to 16kHz mono 16-bit PCM and sent as AudioChunk
/// through the provided mpsc channel. The `source` tag determines whether
/// chunks are labeled as Mic or System (for input devices used as "Them").
pub fn start_mic_capture(
    device_id: &str,
    tx: mpsc::Sender<AudioChunk>,
    source: AudioSource,
) -> Result<Stream, String> {
    let device = super::device_manager::find_input_device(device_id)?;

    let device_name = device.name().unwrap_or_else(|_| "unknown".into());
    log::info!("Starting mic capture on device: {}", device_name);

    let config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get default input config: {}", e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let sample_format = config.sample_format();

    log::info!(
        "Mic capture config: {}Hz, {} channels, {:?}",
        sample_rate,
        channels,
        sample_format
    );

    let err_fn = |err: cpal::StreamError| {
        log::error!("Mic capture stream error: {}", err);
    };

    let stream = match sample_format {
        SampleFormat::I16 => {
            let tx = tx.clone();
            let src = source.clone();
            let mut resampler = StreamResampler::new(sample_rate, TARGET_SAMPLE_RATE, channels);
            device
                .build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        handle_mic_data_i16(data, &mut resampler, &tx, &src);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build i16 input stream: {}", e))?
        }
        SampleFormat::F32 => {
            let tx = tx.clone();
            let src = source.clone();
            let mut resampler = StreamResampler::new(sample_rate, TARGET_SAMPLE_RATE, channels);
            device
                .build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        handle_mic_data_f32(data, &mut resampler, &tx, &src);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build f32 input stream: {}", e))?
        }
        SampleFormat::U16 => {
            let tx = tx.clone();
            let src = source;
            let mut resampler = StreamResampler::new(sample_rate, TARGET_SAMPLE_RATE, channels);
            device
                .build_input_stream(
                    &config.into(),
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        handle_mic_data_u16(data, &mut resampler, &tx, &src);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build u16 input stream: {}", e))?
        }
        _ => {
            return Err(format!("Unsupported sample format: {:?}", sample_format));
        }
    };

    stream
        .play()
        .map_err(|e| format!("Failed to start mic stream: {}", e))?;

    log::info!("Mic capture started successfully");
    Ok(stream)
}

/// Start a single capture that emits each chunk TWICE — once as Mic, once as System.
/// Used when both YOU and THEM share the same input device to avoid opening two
/// competing cpal streams on the same hardware.
pub fn start_mic_capture_dual(
    device_id: &str,
    tx: mpsc::Sender<AudioChunk>,
) -> Result<Stream, String> {
    let device = super::device_manager::find_input_device(device_id)?;
    let device_name = device.name().unwrap_or_else(|_| "unknown".into());
    log::info!("Starting dual-tagged capture on device: {}", device_name);

    let config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get default input config: {}", e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    let sample_format = config.sample_format();

    let err_fn = |err: cpal::StreamError| {
        log::error!("Dual capture stream error: {}", err);
    };

    let stream = match sample_format {
        SampleFormat::I16 => {
            let tx = tx.clone();
            let mut resampler = StreamResampler::new(sample_rate, TARGET_SAMPLE_RATE, channels);
            device
                .build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        handle_dual_data_i16(data, &mut resampler, &tx);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build dual i16 stream: {}", e))?
        }
        SampleFormat::F32 => {
            let tx = tx.clone();
            let mut resampler = StreamResampler::new(sample_rate, TARGET_SAMPLE_RATE, channels);
            device
                .build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        handle_dual_data_f32(data, &mut resampler, &tx);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build dual f32 stream: {}", e))?
        }
        _ => {
            return Err(format!("Unsupported sample format for dual capture: {:?}", sample_format));
        }
    };

    stream
        .play()
        .map_err(|e| format!("Failed to start dual stream: {}", e))?;

    log::info!("Dual-tagged capture started successfully");
    Ok(stream)
}

fn handle_dual_data_i16(
    data: &[i16],
    resampler: &mut StreamResampler,
    tx: &mpsc::Sender<AudioChunk>,
) {
    if data.is_empty() { return; }
    let pcm_data = resampler.process(data);
    let ts = current_timestamp_ms();

    // Emit as Mic
    let _ = tx.try_send(AudioChunk {
        pcm_data: pcm_data.clone(),
        source: AudioSource::Mic,
        timestamp_ms: ts,
        is_speech: false,
    });
    // Emit as System
    let _ = tx.try_send(AudioChunk {
        pcm_data,
        source: AudioSource::System,
        timestamp_ms: ts,
        is_speech: false,
    });
}

fn handle_dual_data_f32(
    data: &[f32],
    resampler: &mut StreamResampler,
    tx: &mpsc::Sender<AudioChunk>,
) {
    if data.is_empty() { return; }
    let i16_data: Vec<i16> = data
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect();
    let pcm_data = resampler.process(&i16_data);
    let ts = current_timestamp_ms();

    let _ = tx.try_send(AudioChunk {
        pcm_data: pcm_data.clone(),
        source: AudioSource::Mic,
        timestamp_ms: ts,
        is_speech: false,
    });
    let _ = tx.try_send(AudioChunk {
        pcm_data,
        source: AudioSource::System,
        timestamp_ms: ts,
        is_speech: false,
    });
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn handle_mic_data_i16(
    data: &[i16],
    resampler: &mut StreamResampler,
    tx: &mpsc::Sender<AudioChunk>,
    source: &AudioSource,
) {
    if data.is_empty() {
        return;
    }

    let pcm_data = resampler.process(data);

    let chunk = AudioChunk {
        pcm_data,
        source: source.clone(),
        timestamp_ms: current_timestamp_ms(),
        is_speech: false,
    };

    // Non-blocking send — drop chunk if channel is full
    if tx.try_send(chunk).is_err() {
        log::trace!("Mic audio channel full, dropping chunk");
    }
}

fn handle_mic_data_f32(
    data: &[f32],
    resampler: &mut StreamResampler,
    tx: &mpsc::Sender<AudioChunk>,
    source: &AudioSource,
) {
    if data.is_empty() {
        return;
    }

    // Convert f32 [-1.0, 1.0] to i16
    let i16_data: Vec<i16> = data
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect();

    let pcm_data = resampler.process(&i16_data);

    let chunk = AudioChunk {
        pcm_data,
        source: source.clone(),
        timestamp_ms: current_timestamp_ms(),
        is_speech: false,
    };

    if tx.try_send(chunk).is_err() {
        log::trace!("Mic audio channel full, dropping chunk");
    }
}

fn handle_mic_data_u16(
    data: &[u16],
    resampler: &mut StreamResampler,
    tx: &mpsc::Sender<AudioChunk>,
    source: &AudioSource,
) {
    if data.is_empty() {
        return;
    }

    // Convert u16 [0, 65535] to i16 [-32768, 32767]
    let i16_data: Vec<i16> = data
        .iter()
        .map(|&s| (s as i32 - 32768) as i16)
        .collect();

    let pcm_data = resampler.process(&i16_data);

    let chunk = AudioChunk {
        pcm_data,
        source: source.clone(),
        timestamp_ms: current_timestamp_ms(),
        is_speech: false,
    };

    if tx.try_send(chunk).is_err() {
        log::trace!("Mic audio channel full, dropping chunk");
    }
}
