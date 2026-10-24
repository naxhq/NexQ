use super::{AudioMessage, TranscriptResult, SAMPLE_RATE};
use ort::session::Session;
use ort::value::{DynValue, Tensor, TensorRef, ValueType};
use rustfft::{num_complex::Complex, FftPlanner};
use std::collections::HashMap;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

fn joiner_shape(dim: usize) -> [usize; 3] {
    [1, dim, 1]
}

fn gather_encoder_frame(data: &[f32], time: usize, t: usize, frame: &mut [f32]) {
    for (channel, value) in frame.iter_mut().enumerate() {
        *value = data[channel * time + t];
    }
}

fn argmax(values: &[f32]) -> usize {
    values.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|x| x.0).unwrap_or(0)
}

fn tdt_step(logits: &[f32], vocab_size: usize, blank: usize, tokens_this_frame: usize) -> Result<(usize, usize), String> {
    if logits.len() != vocab_size + 5 {
        return Err(format!("TDT joiner returned {} logits, expected {} tokens plus five durations", logits.len(), vocab_size));
    }
    let token = argmax(&logits[..vocab_size]);
    let mut skip = argmax(&logits[vocab_size..]);
    if skip == 0 && (token == blank || tokens_this_frame + 1 >= 5) {
        skip = 1;
    }
    Ok((token, skip))
}

fn decode_tokens(ids: &[i64], vocab: &HashMap<i64, String>) -> String {
    let mut text = String::new();
    for id in ids {
        if let Some(piece) = vocab.get(id) {
            if !piece.starts_with('<') {
                text.extend(piece.chars().map(|c| if c == '▁' { ' ' } else { c }));
            }
        }
    }
    text.trim().to_owned()
}

fn normalize_features(features: &mut [f32], frames: usize) {
    for channel in features.chunks_exact_mut(frames) {
        let mean = channel.iter().map(|&x| x as f64).sum::<f64>() / frames as f64;
        let variance = channel.iter().map(|&x| (x as f64 - mean).powi(2)).sum::<f64>() / (frames - 1) as f64;
        let scale = variance.sqrt() + 1e-5;
        for value in channel {
            *value = ((*value as f64 - mean) / scale) as f32;
        }
    }
}

struct Features {
    filters: Vec<Vec<f32>>,
    window: Vec<f32>,
    fft: Arc<dyn rustfft::Fft<f32>>,
}

impl Features {
    fn new() -> Self {
        let mel_max = 15.0 + (8000.0f64 / 1000.0).ln() / (6.4f64.ln() / 27.0);
        let points: Vec<f64> = (0..130).map(|i| {
            let mel = mel_max * i as f64 / 129.0;
            if mel < 15.0 { mel * 200.0 / 3.0 } else { 1000.0 * ((mel - 15.0) * (6.4f64.ln() / 27.0)).exp() }
        }).collect();
        let filters = (0..128).map(|m| {
            let (left, center, right) = (points[m], points[m + 1], points[m + 2]);
            (0..257).map(|k| {
                let hz = k as f64 * 16000.0 / 512.0;
                (((hz - left) / (center - left)).min((right - hz) / (right - center)).max(0.0) * 2.0 / (right - left)) as f32
            }).collect()
        }).collect();
        let window = (0..400).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / 399.0).cos()) as f32).collect();
        Self { filters, window, fft: FftPlanner::new().plan_fft_forward(512) }
    }

    fn extract(&self, samples: &[f32]) -> (usize, Vec<f32>) {
        let frames = samples.len() / 160;
        if frames < 2 { return (0, Vec::new()); }
        let mut features = vec![0.0; 128 * frames];
        let mut spectrum = vec![Complex::new(0.0, 0.0); 512];
        let mut scratch = vec![Complex::new(0.0, 0.0); self.fft.get_inplace_scratch_len()];
        let mut power = [0.0f32; 257];
        for t in 0..frames {
            spectrum.fill(Complex::new(0.0, 0.0));
            for i in 0..400 {
                let index = (t * 160 + i) as isize - 200;
                if index >= 0 && (index as usize) < samples.len() {
                    let index = index as usize;
                    let value = samples[index] - if index > 0 { 0.97 * samples[index - 1] } else { 0.0 };
                    spectrum[i + 56].re = value * self.window[i];
                }
            }
            self.fft.process_with_scratch(&mut spectrum, &mut scratch);
            for (value, bin) in power.iter_mut().zip(&spectrum) { *value = bin.norm_sqr(); }
            for (m, filter) in self.filters.iter().enumerate() {
                let energy: f32 = filter.iter().zip(&power).map(|(a, b)| a * b).sum();
                features[m * frames + t] = (energy + 2.0f32.powi(-24)).ln();
            }
        }
        normalize_features(&mut features, frames);
        (frames, features)
    }
}

struct Prediction {
    embedding: DynValue,
    states: [DynValue; 2],
}

fn predict(decoder: &mut Session, token: i32, states: &[DynValue]) -> Result<Prediction, String> {
    let targets = [token];
    let length = [1i32];
    let target_tensor = TensorRef::from_array_view(([1, 1], &targets[..])).map_err(|e| e.to_string())?;
    let length_tensor = TensorRef::from_array_view(([1], &length[..])).map_err(|e| e.to_string())?;
    let outputs = decoder.run(ort::inputs![target_tensor, length_tensor, &states[0], &states[1]])
        .map_err(|e| format!("NeMo decoder: {e}"))?;
    let mut outputs = outputs.into_iter().map(|(_, value)| value);
    let embedding = outputs.next().ok_or("NeMo decoder missing embedding")?;
    outputs.next().ok_or("NeMo decoder missing lengths")?;
    let states = [
        outputs.next().ok_or("NeMo decoder missing hidden state")?,
        outputs.next().ok_or("NeMo decoder missing cell state")?,
    ];
    if outputs.next().is_some() { return Err("NeMo decoder returned extra states".into()); }
    Ok(Prediction { embedding, states })
}

fn recognize(
    encoder: &mut Session, decoder: &mut Session, joiner: &mut Session,
    features: &Features, samples: &[f32], vocab: &HashMap<i64, String>, blank: usize,
) -> Result<String, String> {
    let (frames, features) = features.extract(samples);
    if frames == 0 { return Ok(String::new()); }
    let lengths = [frames as i64];
    let feature_tensor = TensorRef::from_array_view(([1, 128, frames], &features[..])).map_err(|e| e.to_string())?;
    let length_tensor = TensorRef::from_array_view(([1], &lengths[..])).map_err(|e| e.to_string())?;
    let encoded = encoder.run(ort::inputs![feature_tensor, length_tensor]).map_err(|e| format!("NeMo encoder: {e}"))?;
    let (shape, data) = encoded[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if shape.len() != 3 || shape[0] != 1 || shape[1] != 1024 || shape[2] <= 0 {
        return Err(format!("Unexpected NeMo encoder output shape {shape:?}"));
    }
    let time = shape[2] as usize;
    let (_, encoded_lengths) = encoded[1].try_extract_tensor::<i64>().map_err(|e| e.to_string())?;
    let valid = *encoded_lengths.first().ok_or("NeMo encoder returned no length")?;
    if valid < 0 || valid as usize > time { return Err(format!("Invalid NeMo encoded length {valid} for {time} frames")); }
    let mut states = Vec::new();
    for input in decoder.inputs().iter().skip(2) {
        let ValueType::Tensor { shape, .. } = input.dtype() else { return Err("NeMo decoder state is not a tensor".into()); };
        let shape: Vec<usize> = shape.iter().map(|&n| n.max(1) as usize).collect();
        let size = shape.iter().product();
        states.push(Tensor::from_array((shape, vec![0.0f32; size])).map_err(|e| e.to_string())?.into_dyn());
    }
    if states.len() != 2 { return Err("NeMo decoder requires hidden and cell state inputs".into()); }
    let mut prediction = predict(decoder, blank as i32, &states)?;
    let mut tokens = Vec::new();
    let mut frame = vec![0.0; 1024];
    let mut t = 0;
    let mut tokens_this_frame = 0;
    while t < valid as usize {
        gather_encoder_frame(data, time, t, &mut frame);
        let encoder_tensor = TensorRef::from_array_view((joiner_shape(frame.len()), &frame[..])).map_err(|e| e.to_string())?;
        let logits = joiner.run(ort::inputs![encoder_tensor, &prediction.embedding]).map_err(|e| format!("NeMo joiner: {e}"))?;
        let (_, values) = logits[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let (token, skip) = tdt_step(values, blank + 1, blank, tokens_this_frame)?;
        if token != blank {
            tokens.push(token as i64);
            prediction = predict(decoder, token as i32, &prediction.states)?;
            tokens_this_frame += 1;
        }
        if skip > 0 { tokens_this_frame = 0; }
        t += skip;
    }
    Ok(decode_tokens(&tokens, vocab))
}

pub(super) fn run(
    encoder: &mut Session, decoder: &mut Session, joiner: &mut Session,
    vocab: &HashMap<i64, String>, language: &str, stop: &AtomicBool,
    audio_rx: &std::sync::mpsc::Receiver<AudioMessage>,
    result_tx: &mpsc::Sender<TranscriptResult>, mut segment: u64,
    debug: &impl Fn(&str, &str),
) -> Result<(), String> {
    let metadata = encoder.metadata().map_err(|e| e.to_string())?;
    let blank: usize = metadata.custom("vocab_size").ok_or("NeMo encoder missing vocab_size")?.parse().map_err(|e| format!("NeMo vocab_size: {e}"))?;
    if metadata.custom("feat_dim").as_deref() != Some("128")
        || metadata.custom("normalize_type").as_deref() != Some("per_feature")
        || metadata.custom("url").map_or(true, |url| !url.contains("tdt"))
        || vocab.get(&(blank as i64)).map(String::as_str) != Some("<blk>") {
        return Err("Unsupported NeMo TDT feature or vocabulary contract".into());
    }
    drop(metadata);
    debug("info", "NeMo TDT: offline channel-major encoder, per-feature normalized 128-bin Slaney mel, recurrent decoder, five durations");
    let features = Features::new();
    let mut samples = Vec::new();
    let mut silence = 0;
    let mut received = Instant::now();
    loop {
        let mut finished = false;
        let mut flush = false;
        match audio_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(AudioMessage::Samples(audio)) => {
                received = Instant::now();
                for chunk in audio.chunks(160) {
                    let energy = chunk.iter().map(|&x| (x as f64 / 32768.0).powi(2)).sum::<f64>() / chunk.len() as f64;
                    silence = if energy < 1e-6 { silence + chunk.len() } else { 0 };
                    samples.extend(chunk.iter().map(|&x| x as f32 / 32768.0));
                    if (silence >= 12800 && samples.len() >= SAMPLE_RATE as usize) || samples.len() >= SAMPLE_RATE as usize * 20 {
                        flush = true;
                    }
                }
            }
            Ok(AudioMessage::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                finished = true;
                flush = true;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                finished = stop.load(Ordering::SeqCst);
                flush = finished || received.elapsed() >= Duration::from_millis(800);
            }
        }
        if flush && !samples.is_empty() {
            let text = recognize(encoder, decoder, joiner, &features, &samples, vocab, blank)?;
            samples.clear();
            silence = 0;
            if !text.is_empty() {
                result_tx.blocking_send(TranscriptResult {
                    text, is_final: true, confidence: 0.9,
                    timestamp_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
                    speaker: None, language: Some(language.to_owned()), segment_id: Some(format!("ort_{segment}")),
                    duration_ms: None, speaker_tag: None,
                }).map_err(|e| e.to_string())?;
                segment += 1;
            }
        }
        if finished { return Ok(()); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_channels_are_gathered_at_one_time_step() {
        let mut frame = vec![0.0; 3];
        gather_encoder_frame(&[1.0, 2.0, 10.0, 20.0, 100.0, 200.0], 2, 1, &mut frame);
        assert_eq!(frame, [2.0, 20.0, 200.0]);
        assert_eq!(joiner_shape(1024), [1, 1024, 1]);
    }

    #[test]
    fn duration_logits_are_not_tokens_and_zero_duration_can_emit_again() {
        assert_eq!(tdt_step(&[0.0, 3.0, 1.0, 100.0, 2.0, 0.0, 0.0, 0.0], 3, 2, 0).unwrap(), (1, 0));
        assert_eq!(tdt_step(&[0.0, 1.0, 3.0, 100.0, 2.0, 0.0, 0.0, 0.0], 3, 2, 0).unwrap(), (2, 1));
        assert_eq!(tdt_step(&[0.0, 3.0, 1.0, 100.0, 2.0, 0.0, 0.0, 0.0], 3, 2, 4).unwrap(), (1, 1));
        assert_eq!(tdt_step(&[0.0, 3.0, 1.0, 2.0, 0.0, 100.0, 0.0, 0.0], 3, 2, 0).unwrap(), (1, 2));
    }

    #[test]
    fn sentencepiece_preserves_case_spaces_and_unicode() {
        let vocab = HashMap::from([(0, "<unk>".into()), (1, "▁Hello".into()), (2, ",".into()), (3, "▁café".into()), (4, "!".into()), (5, "<blk>".into())]);
        assert_eq!(decode_tokens(&[1, 2, 3, 4], &vocab), "Hello, café!");
    }

    #[test]
    fn per_feature_normalization_uses_unbiased_variance() {
        let mut features = [1.0, 2.0, 3.0, 4.0, 4.0, 4.0];
        normalize_features(&mut features, 3);
        assert!((features[0] + 0.99999).abs() < 0.0001);
        assert!(features[1].abs() < 0.0001);
        assert!((features[2] - 0.99999).abs() < 0.0001);
        assert_eq!(&features[3..], &[0.0, 0.0, 0.0]);
    }

    #[test]
    fn silent_features_have_valid_frame_count_and_no_nan() {
        let (frames, features) = Features::new().extract(&vec![0.0; 16000]);
        assert_eq!(frames, 100);
        assert_eq!(features.len(), 12800);
        assert!(features.iter().all(|&x| x == 0.0));
    }
}
