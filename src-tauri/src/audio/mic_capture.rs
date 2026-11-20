// Sub-PRD 3: Microphone capture via cpal
// 16kHz, 16-bit mono PCM, sends via tokio::sync::mpsc

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::Stream;
use std::sync::mpsc::SyncSender;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use super::capture_supervisor::{self, CaptureOpener, CaptureSide, DeviceChoice, Opened, SideMessage};
use super::resampler::StreamResampler;
use super::{AudioChunk, AudioSource};

/// Target sample rate for all audio output
const TARGET_SAMPLE_RATE: u32 = 16000;

/// How an input stream's chunks are tagged.
#[derive(Debug, Clone, PartialEq)]
pub enum InputTags {
    /// One source: Mic for "You", System for an input device used as "Them".
    One(AudioSource),
    /// You and Them on the same input device: each chunk is sent twice, as Mic
    /// and as System, so the device isn't opened twice.
    Both,
}

/// Opens an input device for a supervised capture side (mic, dual mic,
/// input-as-Them). Every open sends into the same `tx`.
pub struct InputOpener {
    pub tx: mpsc::Sender<AudioChunk>,
    pub tags: InputTags,
    pub side: CaptureSide,
    /// The side's channel: stream errors go there.
    pub errors: SyncSender<SideMessage>,
}

impl CaptureOpener for InputOpener {
    type Stream = Stream;

    fn open(&mut self, choice: &DeviceChoice, generation: u64) -> Result<Opened<Stream>, String> {
        let device_id = match choice {
            DeviceChoice::Chosen(name) => name.as_str(),
            DeviceChoice::Default => "default",
        };
        let device = super::device_manager::find_input_device(device_id)?;
        let device_name = super::device_manager::device_name(&device).unwrap_or_else(|_| "unknown".into());
        let err_fn = capture_supervisor::error_callback(self.errors.clone(), self.side, generation);
        let stream = open_input_stream(&device, &device_name, self.tx.clone(), self.tags.clone(), err_fn)?;
        Ok(Opened { stream, device: device_name })
    }
}

/// Start capturing audio from the specified input device, unsupervised (the
/// device test in Settings). Returns a cpal::Stream handle — dropping it will
/// stop the stream.
///
/// Audio is resampled to 16kHz mono 16-bit PCM and sent as AudioChunk
/// through the provided mpsc channel, tagged with `source`.
pub fn start_mic_capture(
    device_id: &str,
    tx: mpsc::Sender<AudioChunk>,
    source: AudioSource,
) -> Result<Stream, String> {
    let device = super::device_manager::find_input_device(device_id)?;
    let device_name = super::device_manager::device_name(&device).unwrap_or_else(|_| "unknown".into());
    let err_fn = |err: cpal::Error| {
        super::capture_common::log_stream_error("Mic capture stream error", &err);
    };
    open_input_stream(&device, &device_name, tx, InputTags::One(source), err_fn)
}

/// Open and start an input stream on `device`, any PCM format, resampled to
/// 16 kHz mono and sent on `tx` with `tags`.
fn open_input_stream(
    device: &cpal::Device,
    device_name: &str,
    tx: mpsc::Sender<AudioChunk>,
    tags: InputTags,
    err_fn: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<Stream, String> {
    log::info!("Starting input capture on device: {} ({:?})", device_name, tags);

    let config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get default input config: {}", e))?;

    let sample_rate = config.sample_rate();
    let channels = config.channels();
    let sample_format = config.sample_format();
    log::info!("Input capture config: {}Hz, {} channels, {:?}", sample_rate, channels, sample_format);

    // Lives in the stream callback: keeps its place across chunks.
    let mut resampler = StreamResampler::new(sample_rate, TARGET_SAMPLE_RATE, channels);
    let stream = super::capture_common::build_pcm_input_stream(
        device,
        config.into(),
        sample_format,
        move |pcm| send_tagged(pcm, &mut resampler, &tx, &tags),
        err_fn,
    )
    .map_err(|e| format!("Failed to build {:?} input stream: {}", sample_format, e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start input stream: {}", e))?;

    log::info!("Input capture started on '{}'", device_name);
    Ok(stream)
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// One stream's i16 chunk: resampled to 16 kHz mono by that stream's own
/// `resampler` and sent with its tag(s). Never waits: a full channel drops it.
fn send_tagged(
    data: &[i16],
    resampler: &mut StreamResampler,
    tx: &mpsc::Sender<AudioChunk>,
    tags: &InputTags,
) {
    if data.is_empty() {
        return;
    }

    let pcm_data = resampler.process(data);
    if pcm_data.is_empty() {
        return; // a chunk too short to yield a 16 kHz sample
    }
    let timestamp_ms = current_timestamp_ms();

    let sent = match tags {
        InputTags::One(source) => tx.try_send(AudioChunk {
            pcm_data,
            source: source.clone(),
            timestamp_ms,
            is_speech: false,
        }),
        InputTags::Both => {
            let _ = tx.try_send(AudioChunk {
                pcm_data: pcm_data.clone(),
                source: AudioSource::Mic,
                timestamp_ms,
                is_speech: false,
            });
            tx.try_send(AudioChunk {
                pcm_data,
                source: AudioSource::System,
                timestamp_ms,
                is_speech: false,
            })
        }
    };
    if sent.is_err() {
        log::trace!("Input audio channel full, dropping chunk");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chunk_too_short_for_a_sample_sends_nothing() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut resampler = StreamResampler::new(48_000, TARGET_SAMPLE_RATE, 1);
        let tags = InputTags::One(AudioSource::Mic);
        send_tagged(&[1000], &mut resampler, &tx, &tags);
        assert!(rx.try_recv().is_err(), "an empty chunk was sent");
        send_tagged(&[1000; 480], &mut resampler, &tx, &tags);
        assert_eq!(rx.try_recv().unwrap().pcm_data.len(), 160);
    }

    #[test]
    fn a_shared_device_sends_each_chunk_as_mic_and_system() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut resampler = StreamResampler::new(16_000, TARGET_SAMPLE_RATE, 1);
        send_tagged(&[7; 160], &mut resampler, &tx, &InputTags::Both);
        let (mic, system) = (rx.try_recv().unwrap(), rx.try_recv().unwrap());
        assert_eq!((mic.source, system.source), (AudioSource::Mic, AudioSource::System));
        assert_eq!(mic.pcm_data, system.pcm_data);
        assert_eq!(mic.timestamp_ms, system.timestamp_ms);
    }
}
