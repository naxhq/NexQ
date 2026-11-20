// Native NeMo CTC decoding (Parakeet CTC 110M and similar).
//
// Unlike the TDT transducer in nemo.rs, a NeMo CTC export is a single ONNX
// graph: log-mel features in, per-frame log-probs over the vocabulary out.
// No decoder/joiner, no autoregressive loop — just one encoder run per
// segment followed by greedy CTC decoding (argmax, collapse repeats, drop
// blank), the same contract sherpa-onnx's own offline-ctc-greedy-search
// decoder implements against the same model family.

use super::nemo::Features;
use super::segmenter::{argmax, decode_tokens, segment_loop};
use super::{AudioMessage, TranscriptResult};
use ort::session::Session;
use ort::value::{TensorRef, ValueType};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use tokio::sync::mpsc;

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

/// The blank class id for a CTC head with `num_classes` outputs. Sherpa-onnx
/// reads it from the token table (`<blk>`, else `<eps>`, else `<blank>`, in
/// that order, see offline-recognizer-ctc-impl.h); the last class is the
/// fallback, since NeMo appends the blank after the vocabulary.
fn blank_id(vocab: &HashMap<i64, String>, num_classes: usize) -> Result<usize, String> {
    let blank = ["<blk>", "<eps>", "<blank>"].iter()
        .find_map(|name| vocab.iter().find(|(_, piece)| piece.as_str() == *name).map(|(id, _)| *id))
        .unwrap_or(num_classes as i64 - 1);
    if blank < 0 || blank as usize >= num_classes {
        return Err(format!("NeMo CTC blank id {blank} is outside the model's {num_classes} output classes"));
    }
    Ok(blank as usize)
}

fn recognize(
    encoder: &mut Session, features: &Features, samples: &[f32],
    vocab: &HashMap<i64, String>, num_classes: usize, blank: usize,
    subsampling_factor: usize, normalize: bool,
) -> Result<String, String> {
    let (frames, mel) = features.extract(samples, normalize);
    if frames == 0 { return Ok(String::new()); }
    let lengths = [frames as i64];
    let feature_tensor = TensorRef::from_array_view(([1, mel.len() / frames, frames], &mel[..])).map_err(|e| e.to_string())?;
    let length_tensor = TensorRef::from_array_view(([1], &lengths[..])).map_err(|e| e.to_string())?;
    let outputs = encoder.run(ort::inputs![feature_tensor, length_tensor]).map_err(|e| format!("NeMo CTC encoder: {e}"))?;
    let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if shape.len() != 3 || shape[0] != 1 || shape[2] as usize != num_classes {
        return Err(format!("Unexpected NeMo CTC output shape {shape:?}, expected [1, frames, {num_classes}]"));
    }
    let num_frames = shape[1] as usize;
    let valid = (frames / subsampling_factor.max(1)).min(num_frames);
    let tokens = greedy_decode(data, valid, num_classes, blank);
    Ok(decode_tokens(&tokens, vocab))
}

/// Static size of dimension `index` of a tensor type, when the graph fixes it.
fn static_dim(dtype: &ValueType, index: usize) -> Option<usize> {
    match dtype {
        ValueType::Tensor { shape, .. } => shape.get(index).copied().filter(|&d| d > 0).map(|d| d as usize),
        _ => None,
    }
}

pub(super) fn run(
    encoder: &mut Session, vocab: &HashMap<i64, String>, language: &str, stop: &AtomicBool,
    audio_rx: &std::sync::mpsc::Receiver<AudioMessage>,
    result_tx: &mpsc::Sender<TranscriptResult>, segment: u64,
    debug: &impl Fn(&str, &str),
) -> Result<(), String> {
    // The input contract is NeMo's `audio_signal` [batch, mels, time] plus `length`.
    let input = encoder.inputs().first().ok_or("NeMo CTC encoder has no inputs")?;
    if input.name() != "audio_signal" {
        return Err(format!("Unsupported NeMo CTC encoder input {:?}, expected audio_signal", input.name()));
    }
    if let Some(mels) = static_dim(input.dtype(), 1) {
        if mels != 80 {
            return Err(format!("Unsupported NeMo CTC encoder: {mels} mel bins, expected 80"));
        }
    }
    let static_classes = encoder.outputs().first().and_then(|output| static_dim(output.dtype(), 2));
    let metadata = encoder.metadata().map_err(|e| e.to_string())?;
    let subsampling_factor: usize = metadata.custom("subsampling_factor").ok_or("NeMo CTC encoder missing subsampling_factor")?.parse().map_err(|e| format!("NeMo CTC subsampling_factor: {e}"))?;
    // "per_feature" is the normalization every published Parakeet CTC export
    // uses. An empty or "NA" value means unnormalized log-mel; other front ends
    // (e.g. GigaAM's 64-bin features) are not supported.
    let normalize_type = metadata.custom("normalize_type").unwrap_or_default();
    let normalize = normalize_type == "per_feature";
    if !matches!(normalize_type.as_str(), "per_feature" | "" | "NA") {
        return Err(format!("Unsupported NeMo CTC normalize_type {normalize_type:?}"));
    }
    drop(metadata);
    // The class count is the output's last dimension (the metadata vocab_size
    // can leave out the blank) and the blank follows from the token table.
    // Both are fixed for the model, so they are resolved once, here; every
    // segment's output is checked against them.
    let num_classes = static_classes.unwrap_or(vocab.len());
    let blank = blank_id(vocab, num_classes)?;
    debug("info", &format!(
        "NeMo CTC: offline 80-bin Slaney mel encoder, subsampling {subsampling_factor}, normalize_type={normalize_type:?}"
    ));
    debug("info", &format!("NeMo CTC: {num_classes} classes, blank {blank}"));
    let features = Features::new(80);
    segment_loop(stop, audio_rx, result_tx, segment, language, |samples| {
        recognize(encoder, &features, samples, vocab, num_classes, blank, subsampling_factor, normalize)
    })
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
    fn blank_comes_from_the_blk_token_for_a_1025_wide_head() {
        // Hybrid TDT/CTC 110M export: 1024 vocabulary entries, `<blk>` at id 1024,
        // a 1025-wide CTC head (metadata vocab_size is 1024, so it is not used).
        let mut vocab: HashMap<i64, String> = (0..1024).map(|i| (i, format!("t{i}"))).collect();
        vocab.insert(1024, "<blk>".into());
        assert_eq!(blank_id(&vocab, 1025), Ok(1024));
        // `<blk>` wins over the last-class fallback.
        vocab.insert(3, "<blk>".into());
        vocab.remove(&1024);
        assert_eq!(blank_id(&vocab, 1025), Ok(3));
    }

    #[test]
    fn blank_falls_back_through_other_names_then_the_last_class() {
        // sherpa-onnx's order: `<blk>`, then `<eps>`, then `<blank>`.
        let vocab = HashMap::from([(0, "a".into()), (1, "<blank>".into()), (2, "<eps>".into())]);
        assert_eq!(blank_id(&vocab, 3), Ok(2));
        let vocab = HashMap::from([(0, "a".into()), (1, "<blank>".into())]);
        assert_eq!(blank_id(&vocab, 3), Ok(1));
        let vocab = HashMap::from([(0, "a".into()), (1, "b".into())]);
        assert_eq!(blank_id(&vocab, 3), Ok(2));
    }

    #[test]
    fn blank_outside_the_output_classes_is_an_error() {
        let vocab = HashMap::from([(0, "a".into()), (5, "<blk>".into())]);
        assert!(blank_id(&vocab, 3).is_err());
    }

    #[test]
    fn greedy_decode_uses_the_head_width_not_the_vocab_size() {
        // 1025-wide frames, blank 1024: token 1023 (the old "blank") must survive.
        let mut log_probs = Vec::new();
        for id in [1023usize, 1024, 5] {
            let mut frame = vec![0.0f32; 1025];
            frame[id] = 10.0;
            log_probs.extend(frame);
        }
        assert_eq!(greedy_decode(&log_probs, 3, 1025, 1024), vec![1023, 5]);
    }
}
