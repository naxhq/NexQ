// Native NeMo CTC decoding (Parakeet CTC 110M and similar).
//
// Unlike the TDT transducer in nemo.rs, a NeMo CTC export is a single ONNX
// graph: log-mel features in, per-frame log-probits over the vocabulary out.
// No decoder/joiner, no autoregressive loop — just one encoder run per
// segment followed by greedy CTC decoding (argmax, collapse repeats, drop
// blank), the same contract sherpa-onnx's own offline-ctc-greedy-search
// decoder implements against the same model family.

use super::nemo::Features;
use super::{AudioMessage, TranscriptResult, SAMPLE_RATE};
use ort::session::Session;
use ort::value::TensorRef;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

fn argmax(values: &[f32]) -> usize {
    values.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|x| x.0).unwrap_or(0)
}

/// Greedy CTC decode over one segment's log-probs: argmax per frame, drop
/// the blank, collapse a token repeated on consecutive frames into one.
/// Mirrors sherpa-onnx's own offline-ctc-greedy-search-decoder.cc.
/// `num_classes` is the per-frame width: real tokens plus the blank class.
fn greedy_decode(log_probs: &[f32], valid_frames: usize, num_classes: usize, blank: usize) -> Vec<i64> {
    let mut tokens = Vec::new();
    let mut prev: i64 = -1;
    for t in 0..valid_frames {
        let frame = &log_probs[t * num_classes..(t + 1) * num_classes];
        let id = argmax(frame) as i64;
        if id != blank as i64 && id != prev {
            tokens.push(id);
        }
        prev = id;
    }
    tokens
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

fn recognize(
    encoder: &mut Session, features: &Features, samples: &[f32],
    vocab: &HashMap<i64, String>, vocab_size: usize, blank: usize,
    subsampling_factor: usize, normalize: bool,
) -> Result<String, String> {
    let (frames, mel) = features.extract(samples, normalize);
    if frames == 0 { return Ok(String::new()); }
    let lengths = [frames as i64];
    let feature_tensor = TensorRef::from_array_view(([1, mel.len() / frames, frames], &mel[..])).map_err(|e| e.to_string())?;
    let length_tensor = TensorRef::from_array_view(([1], &lengths[..])).map_err(|e| e.to_string())?;
    let outputs = encoder.run(ort::inputs![feature_tensor, length_tensor]).map_err(|e| format!("NeMo CTC encoder: {e}"))?;
    let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if shape.len() != 3 || shape[0] != 1 || shape[2] as usize != vocab_size {
        return Err(format!("Unexpected NeMo CTC output shape {shape:?} for vocab_size {vocab_size}"));
    }
    let num_frames = shape[1] as usize;
    let valid = (frames / subsampling_factor.max(1)).min(num_frames);
    let tokens = greedy_decode(data, valid, vocab_size, blank);
    Ok(decode_tokens(&tokens, vocab))
}

/// Mean power below this is silence (no decoding, counts toward a pause).
const SILENCE_ENERGY: f64 = 1e-6;

fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

pub(super) fn run(
    encoder: &mut Session, vocab: &HashMap<i64, String>, language: &str, stop: &AtomicBool,
    audio_rx: &std::sync::mpsc::Receiver<AudioMessage>,
    result_tx: &mpsc::Sender<TranscriptResult>, mut segment: u64,
    debug: &impl Fn(&str, &str),
) -> Result<(), String> {
    let metadata = encoder.metadata().map_err(|e| e.to_string())?;
    let vocab_size: usize = metadata.custom("vocab_size").ok_or("NeMo CTC encoder missing vocab_size")?.parse().map_err(|e| format!("NeMo CTC vocab_size: {e}"))?;
    let subsampling_factor: usize = metadata.custom("subsampling_factor").ok_or("NeMo CTC encoder missing subsampling_factor")?.parse().map_err(|e| format!("NeMo CTC subsampling_factor: {e}"))?;
    // "per_feature" is the normalization every published Parakeet CTC export
    // uses; an empty/"NA" value (GigaAM-style exports) means raw features.
    let normalize_type = metadata.custom("normalize_type").unwrap_or_default();
    let normalize = normalize_type == "per_feature";
    if !matches!(normalize_type.as_str(), "per_feature" | "" | "NA") {
        return Err(format!("Unsupported NeMo CTC normalize_type {normalize_type:?}"));
    }
    drop(metadata);
    // The model's full output width is vocab_size (real tokens plus blank);
    // the blank class is the last index, vocab_size - 1.
    let blank = vocab_size.checked_sub(1).ok_or("NeMo CTC vocab_size is 0")?;
    debug("info", &format!(
        "NeMo CTC: offline 80-bin Slaney mel encoder, subsampling {subsampling_factor}, normalize_type={normalize_type:?}"
    ));
    let features = Features::new(80);
    let mut samples = Vec::new();
    let mut silence = 0;
    let mut heard = false;
    let mut segment_start_ms = 0u64;
    let mut received = Instant::now();
    loop {
        let mut finished = false;
        let mut flush = false;
        let message = if stop.load(Ordering::SeqCst) {
            Ok(AudioMessage::Stop)
        } else {
            audio_rx.recv_timeout(Duration::from_millis(100))
        };
        match message {
            Ok(AudioMessage::Samples(audio)) => {
                received = Instant::now();
                let chunk_start_ms = epoch_ms().saturating_sub(audio.len() as u64 * 1000 / SAMPLE_RATE as u64);
                for (i, chunk) in audio.chunks(160).enumerate() {
                    if samples.is_empty() {
                        segment_start_ms = chunk_start_ms + (i as u64 * 160 * 1000 / SAMPLE_RATE as u64);
                    }
                    let energy = chunk.iter().map(|&x| (x as f64 / 32768.0).powi(2)).sum::<f64>() / chunk.len() as f64;
                    let speech = energy >= SILENCE_ENERGY;
                    heard |= speech;
                    silence = if speech { 0 } else { silence + chunk.len() };
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
            let text = if heard {
                recognize(encoder, &features, &samples, vocab, vocab_size, blank, subsampling_factor, normalize)?
            } else {
                String::new()
            };
            let duration_ms = samples.len() as u64 * 1000 / SAMPLE_RATE as u64;
            samples.clear();
            silence = 0;
            heard = false;
            if !text.is_empty() {
                result_tx.blocking_send(TranscriptResult {
                    text, is_final: true, confidence: 0.9,
                    timestamp_ms: segment_start_ms,
                    speaker: None, language: Some(language.to_owned()), segment_id: Some(format!("ort_{segment}")),
                    duration_ms: Some(duration_ms), speaker_tag: None,
                    turn: None,
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
    fn greedy_decode_drops_blank_and_collapses_repeats() {
        // vocab_size=3 (tokens 0,1,2), blank=3. Frames: 1,1,blank,2,2,2,1.
        let vocab_size = 3;
        let blank = 3;
        let mut log_probs = Vec::new();
        for id in [1, 1, 3, 2, 2, 2, 1] {
            let mut frame = vec![0.0f32; vocab_size + 1];
            frame[id] = 10.0;
            log_probs.extend(frame);
        }
        assert_eq!(greedy_decode(&log_probs, 7, vocab_size + 1, blank), vec![1, 2, 1]);
    }

    #[test]
    fn greedy_decode_handles_a_token_repeated_across_a_blank() {
        // Collapsing only merges IMMEDIATELY adjacent repeats; a blank in
        // between resets the "previous" token, so the same id can recur.
        let vocab_size = 2;
        let blank = 2;
        let mut log_probs = Vec::new();
        for id in [0, 2, 0] {
            let mut frame = vec![0.0f32; vocab_size + 1];
            frame[id] = 10.0;
            log_probs.extend(frame);
        }
        assert_eq!(greedy_decode(&log_probs, 3, vocab_size + 1, blank), vec![0, 0]);
    }

    #[test]
    fn sentencepiece_preserves_case_spaces_and_unicode() {
        let vocab = HashMap::from([(0, "<unk>".into()), (1, "▁Hello".into()), (2, ",".into()), (3, "▁café".into()), (4, "!".into())]);
        assert_eq!(decode_tokens(&[1, 2, 3, 4], &vocab), "Hello, café!");
    }
}
