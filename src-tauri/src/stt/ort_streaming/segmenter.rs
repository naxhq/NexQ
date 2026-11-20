// Speech segmentation shared by the offline NeMo decoders (TDT in nemo.rs,
// CTC in ctc.rs). Audio arrives in arbitrary chunks; this buffers it, decides
// where a segment ends, hands the finished segment to a recognizer, and sends
// the text on. The decoders keep only their model contract and `recognize`.
// The token helpers they both need (`argmax`, `decode_tokens`) live here too.

use super::{AudioMessage, TranscriptResult, SAMPLE_RATE};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Mean power below this is silence (no decoding, counts toward a pause).
const SILENCE_ENERGY: f64 = 1e-6;

/// Samples of consecutive silence (0.8 s) that end a segment...
const PAUSE_SAMPLES: usize = 12_800;
/// ...once at least this much (1 s) is buffered.
const MIN_SEGMENT_SAMPLES: usize = SAMPLE_RATE as usize;
/// A segment never grows past this (20 s).
const MAX_SEGMENT_SAMPLES: usize = SAMPLE_RATE as usize * 20;
/// With no audio arriving for this long, what is buffered is decoded.
const IDLE_FLUSH: Duration = Duration::from_millis(800);
/// How long one wait for audio lasts before the stop flag and idle time are checked.
const POLL: Duration = Duration::from_millis(100);

pub(super) fn argmax(values: &[f32]) -> usize {
    values.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|x| x.0).unwrap_or(0)
}

/// SentencePiece pieces to text: `▁` is a space, `<...>` pieces are dropped.
pub(super) fn decode_tokens(ids: &[i64], vocab: &HashMap<i64, String>) -> String {
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

fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// Buffers audio from `audio_rx` into speech segments and sends each
/// recognized segment on `result_tx`, until a stop (the flag or a `Stop`
/// message, which decode what is already buffered) or the audio channel closes.
///
/// A segment ends after a 0.8 s pause once 1 s is buffered, at 20 s, when no
/// audio has arrived for 0.8 s, or on stop. Buffers without any speech-energy
/// frame are dropped undecoded. `recognize` gets the segment as 16 kHz mono
/// floats in [-1, 1]; segment ids (`ort_<n>`, from `segment`) advance only
/// when it returns text.
pub(super) fn segment_loop(
    stop: &AtomicBool,
    audio_rx: &std::sync::mpsc::Receiver<AudioMessage>,
    result_tx: &mpsc::Sender<TranscriptResult>,
    mut segment: u64,
    language: &str,
    mut recognize: impl FnMut(&[f32]) -> Result<String, String>,
) -> Result<(), String> {
    let mut samples: Vec<f32> = Vec::new();
    let mut silence = 0;
    // Whether the buffer holds any speech-energy frame (silent buffers aren't decoded).
    let mut heard = false;
    // Epoch ms of the buffer's first sample.
    let mut segment_start_ms = 0u64;
    let mut received = Instant::now();
    loop {
        let mut finished = false;
        let mut flush = false;
        // A stop request flushes only what is already buffered; queued audio is dropped.
        let message = if stop.load(Ordering::SeqCst) {
            Ok(AudioMessage::Stop)
        } else {
            audio_rx.recv_timeout(POLL)
        };
        match message {
            Ok(AudioMessage::Samples(audio)) => {
                received = Instant::now();
                // The chunk just arrived: its first sample was captured `len / 16` ms ago.
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
                    if (silence >= PAUSE_SAMPLES && samples.len() >= MIN_SEGMENT_SAMPLES) || samples.len() >= MAX_SEGMENT_SAMPLES {
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
                flush = finished || received.elapsed() >= IDLE_FLUSH;
            }
        }
        if flush && !samples.is_empty() {
            let text = if heard { recognize(&samples)? } else { String::new() };
            let duration_ms = samples.len() as u64 * 1000 / SAMPLE_RATE as u64;
            samples.clear();
            silence = 0;
            heard = false;
            if !text.is_empty() {
                result_tx.blocking_send(TranscriptResult {
                    text, is_final: true, confidence: 0.9,
                    timestamp_ms: segment_start_ms,
                    speaker: None, language: crate::stt::provider::reported_language(language), segment_id: Some(format!("ort_{segment}")),
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
    use std::sync::mpsc::{channel, Sender};
    use std::sync::Arc;

    /// `ms` of a loud tone (counts as speech) as 16 kHz samples.
    fn speech(ms: usize) -> Vec<i16> { vec![1000; ms * 16] }
    fn silence(ms: usize) -> Vec<i16> { vec![0; ms * 16] }

    /// Runs the loop to its end on audio queued up front and returns what the
    /// recognizer was asked to decode (segment lengths in samples) and what
    /// was sent. `texts` are the recognizer's answers in order; it then
    /// answers "t".
    fn run_queued(messages: Vec<AudioMessage>, texts: &[&str], start: u64) -> (Vec<usize>, Vec<TranscriptResult>) {
        let (tx, rx) = channel();
        for message in messages { tx.send(message).unwrap(); }
        drop(tx);
        let (result_tx, mut result_rx) = mpsc::channel(32);
        let mut lengths = Vec::new();
        let mut texts = texts.iter();
        segment_loop(&AtomicBool::new(false), &rx, &result_tx, start, "en", |segment| {
            lengths.push(segment.len());
            Ok(texts.next().copied().unwrap_or("t").to_owned())
        }).unwrap();
        drop(result_tx);
        let mut results = Vec::new();
        while let Ok(result) = result_rx.try_recv() { results.push(result); }
        (lengths, results)
    }

    #[test]
    fn a_pause_ends_a_segment_once_a_second_is_buffered() {
        // 100 ms of speech + 800 ms of silence is under 1 s: no flush yet, so the
        // next 200 ms of silence completes ONE segment of 1.1 s.
        let (lengths, results) = run_queued(vec![
            AudioMessage::Samples([speech(100), silence(800)].concat()),
            AudioMessage::Samples(silence(200)),
        ], &[], 0);
        assert_eq!(lengths, [17_600]);
        assert_eq!(results.len(), 1);
        // 1 s of speech followed by the pause flushes at once.
        let (lengths, _) = run_queued(vec![AudioMessage::Samples([speech(1000), silence(800)].concat())], &[], 0);
        assert_eq!(lengths, [28_800]);
    }

    #[test]
    fn auto_detect_never_tags_a_line_with_the_word_auto() {
        let (tx, rx) = channel();
        tx.send(AudioMessage::Samples([speech(1000), silence(800)].concat())).unwrap();
        drop(tx);
        let (result_tx, mut result_rx) = mpsc::channel(4);
        segment_loop(&AtomicBool::new(false), &rx, &result_tx, 0, "auto", |_| Ok("hello".into())).unwrap();
        assert_eq!(result_rx.try_recv().unwrap().language, None);
    }

    #[test]
    fn a_segment_never_grows_past_twenty_seconds() {
        let (lengths, results) = run_queued(vec![AudioMessage::Samples(speech(20_000))], &[], 0);
        assert_eq!(lengths, [320_000]);
        assert_eq!(results[0].duration_ms, Some(20_000));
    }

    #[test]
    fn silent_buffers_are_not_decoded() {
        let (lengths, results) = run_queued(vec![AudioMessage::Samples(silence(2_000))], &[], 0);
        assert!(lengths.is_empty());
        assert!(results.is_empty());
    }

    #[test]
    fn a_stop_message_decodes_what_is_buffered() {
        let (lengths, results) = run_queued(vec![AudioMessage::Samples(speech(500)), AudioMessage::Stop], &[], 0);
        assert_eq!(lengths, [8_000]);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn a_closed_audio_channel_decodes_what_is_buffered() {
        let (lengths, _) = run_queued(vec![AudioMessage::Samples(speech(500))], &[], 0);
        assert_eq!(lengths, [8_000]);
    }

    #[test]
    fn the_stop_flag_drops_queued_audio() {
        let (tx, rx) = channel();
        tx.send(AudioMessage::Samples(speech(500))).unwrap();
        let (result_tx, _result_rx) = mpsc::channel(4);
        let mut calls = 0;
        segment_loop(&AtomicBool::new(true), &rx, &result_tx, 0, "en", |_| { calls += 1; Ok("t".into()) }).unwrap();
        assert_eq!(calls, 0);
    }

    #[test]
    fn segment_ids_advance_only_when_there_is_text() {
        let one_segment = || AudioMessage::Samples([speech(1000), silence(800)].concat());
        let (lengths, results) = run_queued(vec![one_segment(), one_segment(), one_segment()], &["", "one", "two"], 5);
        assert_eq!(lengths.len(), 3);
        let ids: Vec<_> = results.iter().map(|r| r.segment_id.clone().unwrap()).collect();
        assert_eq!(ids, ["ort_5", "ort_6"]);
        let texts: Vec<_> = results.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["one", "two"]);
        assert!(results.iter().all(|r| r.is_final && r.language.as_deref() == Some("en")));
    }

    #[test]
    fn buffered_audio_is_decoded_after_800_ms_without_more_audio() {
        let (tx, rx): (Sender<AudioMessage>, _) = channel();
        let (result_tx, mut result_rx) = mpsc::channel(4);
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let mut lengths = Vec::new();
                segment_loop(&stop, &rx, &result_tx, 0, "en", |segment| {
                    lengths.push(segment.len());
                    Ok("idle".into())
                }).unwrap();
                lengths
            })
        };
        let sent = Instant::now();
        tx.send(AudioMessage::Samples(speech(500))).unwrap();
        // The sender stays open, so only the idle timer can flush this.
        let deadline = Instant::now() + Duration::from_secs(5);
        let result = loop {
            match result_rx.try_recv() {
                Ok(result) => break result,
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => {
                    let _ = tx.send(AudioMessage::Stop);
                    panic!("the idle flush sent nothing within 5 s");
                }
            }
        };
        assert!(sent.elapsed() >= Duration::from_millis(700), "flushed after {:?}", sent.elapsed());
        assert_eq!(result.text, "idle");
        tx.send(AudioMessage::Stop).unwrap();
        assert_eq!(worker.join().unwrap(), [8_000]);
    }

    #[test]
    fn sentencepiece_preserves_case_spaces_and_unicode() {
        let vocab = HashMap::from([(0, "<unk>".into()), (1, "▁Hello".into()), (2, ",".into()), (3, "▁café".into()), (4, "!".into()), (5, "<blk>".into())]);
        assert_eq!(decode_tokens(&[1, 2, 3, 4], &vocab), "Hello, café!");
    }

    #[test]
    fn argmax_picks_the_largest_value_index() {
        assert_eq!(argmax(&[0.5, 2.0, 1.0]), 1);
        assert_eq!(argmax(&[]), 0);
    }
}
