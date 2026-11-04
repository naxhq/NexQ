// Deepgram Flux: conversational speech recognition with built-in turn
// detection, served on wss://api.deepgram.com/v2/listen.
//
// The Deepgram provider (deepgram.rs) uses this when its model is a Flux model
// ("flux-general-en", "flux-general-multi"); Nova keeps its own code paths.
// - Thresholds are Deepgram's documented Low-Latency profile: eager end of
//   turn at 0.4, end of turn at 0.7, forced end after 6 s
// - TurnInfo events become results: Update / StartOfTurn as interims,
//   EagerEndOfTurn and TurnResumed as interims with a turn signal, EndOfTurn as
//   the final with the End signal
// - Flux has no KeepAlive and detects turns from the audio itself, so gaps are
//   filled with silence (idle system loopback sends none)
// - Audio goes out in 80 ms frames, as Deepgram strongly recommends for Flux;
//   capture delivers 10 ms chunks
// - CloseStream doesn't end the open turn: its latest text is kept as a final,
//   without a turn signal

use std::time::{Duration, Instant};

use serde::Deserialize;

use super::deepgram::DeepgramConfig;
use super::provider::{TranscriptResult, TurnSignal};

/// Flux turn thresholds: Deepgram's Low-Latency profile.
pub const EAGER_EOT_THRESHOLD: &str = "0.4";
pub const EOT_THRESHOLD: &str = "0.7";
pub const EOT_TIMEOUT_MS: u32 = 6000;

/// Languages `flux-general-multi` takes as a `language_hint`.
const MULTI_LANGUAGES: [&str; 10] = ["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"];

/// Silence fills a gap once nothing has been sent for this long (150 ms);
/// capture delivers a chunk every ~10 ms, so real audio never trips it.
pub const GAP_BEFORE_SILENCE: Duration = Duration::from_millis(150);
/// How often the writer looks for a gap.
pub const GAP_CHECK_INTERVAL: Duration = Duration::from_millis(100);
/// The most silence sent in one frame, so a delayed writer doesn't burst.
const MAX_SILENCE_FILL: Duration = Duration::from_secs(1);

/// A connection made in the background (reconnect, unmute) is put to use only
/// when audio arrives. Deepgram closes a connection that gets no audio for
/// 10 s, so a Flux connection left unused for longer than 5 s is replaced.
pub const UNUSED_CONNECTION_MAX: Duration = Duration::from_secs(5);

const SAMPLE_RATE: usize = 16_000;

/// Whether `model` is a Flux model (served on /v2/listen).
pub fn is_flux_model(model: &str) -> bool {
    model.starts_with("flux-")
}

/// The Flux WebSocket URL. `base` is `wss://api.deepgram.com/v2/listen` (tests
/// pass a local server). Nova-only options (smart format, endpointing,
/// diarization...) don't exist on Flux and aren't sent.
pub fn ws_url(base: &str, config: &DeepgramConfig, language: &str) -> String {
    let mut params = vec![
        format!("model={}", config.model),
        "encoding=linear16".to_string(),
        format!("sample_rate={}", SAMPLE_RATE),
        format!("eager_eot_threshold={}", EAGER_EOT_THRESHOLD),
        format!("eot_threshold={}", EOT_THRESHOLD),
        format!("eot_timeout_ms={}", EOT_TIMEOUT_MS),
    ];
    if config.profanity_filter {
        params.push("profanity_filter=true".to_string());
    }
    if config.numerals {
        params.push("numerals=true".to_string());
    }
    for keyterm in &config.keyterms {
        params.push(format!("keyterm={}", encode_query_value(keyterm)));
    }
    // Only the multilingual model takes a hint (others answer 400); a
    // language it can't be hinted is auto-detected.
    if config.model == "flux-general-multi" {
        let code = language.trim().split('-').next().unwrap_or("").to_lowercase();
        if MULTI_LANGUAGES.contains(&code.as_str()) {
            params.push(format!("language_hint={}", code));
        }
    }
    format!("{}?{}", base, params.join("&"))
}

/// Escapes the characters that would break a query parameter value.
fn encode_query_value(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('+', "%2B")
}

/// Bytes in an 80 ms frame of 16-bit audio, the size Deepgram strongly recommends for Flux.
pub const FRAME_BYTES: usize = SAMPLE_RATE * 2 * 80 / 1000;
/// With no new audio for this long, a partly filled frame goes out as it is.
pub const PARTIAL_FRAME_WAIT: Duration = Duration::from_millis(50);

/// Collects capture's small chunks into frames of at least FRAME_BYTES.
#[derive(Default)]
pub struct FrameBatcher {
    pending: Vec<u8>,
    last_push: Option<Instant>,
}

impl FrameBatcher {
    /// Adds audio; returns a frame once there is enough for one.
    pub fn push(&mut self, bytes: Vec<u8>, now: Instant) -> Option<Vec<u8>> {
        self.last_push = Some(now);
        if self.pending.is_empty() {
            self.pending = bytes;
        } else {
            self.pending.extend_from_slice(&bytes);
        }
        (self.pending.len() >= FRAME_BYTES).then(|| std::mem::take(&mut self.pending))
    }

    /// Whatever is held, for when the stream is closing.
    pub fn take(&mut self) -> Option<Vec<u8>> {
        (!self.pending.is_empty()).then(|| std::mem::take(&mut self.pending))
    }

    /// Whatever is held, once audio has paused for PARTIAL_FRAME_WAIT.
    pub fn take_if_paused(&mut self, now: Instant) -> Option<Vec<u8>> {
        let paused = self.last_push.is_some_and(|at| now.duration_since(at) >= PARTIAL_FRAME_WAIT);
        if paused { self.take() } else { None }
    }
}

/// Samples of silence to send after `idle` with nothing sent.
pub fn silence_samples_for(idle: Duration) -> usize {
    if idle < GAP_BEFORE_SILENCE {
        return 0;
    }
    idle.min(MAX_SILENCE_FILL).as_millis() as usize * SAMPLE_RATE / 1000
}

/// A Flux server message, as far as NexQ reads it.
#[derive(Debug)]
pub enum FluxMessage {
    Connected,
    TurnInfo(TurnInfo),
    /// A fatal error; the server closes the connection after it.
    Error { code: String, description: String },
    Warning { code: String, description: String },
    Other,
}

#[derive(Debug, Deserialize)]
pub struct TurnInfo {
    pub event: String,
    #[serde(default)]
    pub transcript: String,
    #[serde(default)]
    pub words: Vec<FluxWord>,
}

#[derive(Debug, Deserialize)]
pub struct FluxWord {
    /// Seconds on Deepgram's clock (audio received on this connection).
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
    /// A number, or a number in a string.
    #[serde(default)]
    pub confidence: serde_json::Value,
}

impl FluxMessage {
    /// Parse a text frame; `None` when it isn't valid JSON.
    pub fn parse(text: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let field = |name: &str| value.get(name).and_then(|v| v.as_str()).unwrap_or("").to_string();
        Some(match value.get("type").and_then(|t| t.as_str()) {
            Some("Connected") => FluxMessage::Connected,
            Some("TurnInfo") => match serde_json::from_value::<TurnInfo>(value) {
                Ok(info) => FluxMessage::TurnInfo(info),
                Err(_) => FluxMessage::Other,
            },
            Some("Error") => FluxMessage::Error { code: field("code"), description: field("description") },
            Some("Warning") => FluxMessage::Warning { code: field("code"), description: field("description") },
            _ => FluxMessage::Other,
        })
    }
}

/// Turns Flux's TurnInfo events into transcript results for one party.
pub struct FluxTurns {
    party: String,
    /// The open turn's latest result (an interim), until its EndOfTurn.
    open: Option<TranscriptResult>,
}

impl FluxTurns {
    pub fn new(party: &str) -> Self {
        Self { party: party.to_string(), open: None }
    }

    /// The result for `info`, if it carries text. `epoch_at` maps an offset (ms)
    /// on Deepgram's clock to wall-clock time; `now_ms` dates a turn without words.
    pub fn on_turn_info(
        &mut self,
        info: &TurnInfo,
        epoch_at: impl Fn(u64) -> Option<u64>,
        now_ms: u64,
    ) -> Option<TranscriptResult> {
        let ended = info.event == "EndOfTurn";
        let open = if ended { self.open.take() } else { self.open.clone() };
        let mut text = info.transcript.trim().to_string();
        // TurnResumed may come without words: the turn's latest text goes out again.
        if text.is_empty() && info.event == "TurnResumed" {
            text = open.as_ref().map(|o| o.text.clone()).unwrap_or_default();
        }
        if text.is_empty() {
            return None;
        }

        let first_start = info.words.first().and_then(|w| w.start).map(seconds_to_ms);
        let last_end = info.words.iter().rev().find_map(|w| w.end).map(seconds_to_ms);
        let timestamp_ms = first_start
            .and_then(&epoch_at)
            .or(open.as_ref().map(|o| o.timestamp_ms))
            .unwrap_or(now_ms);
        let turn = match info.event.as_str() {
            "EagerEndOfTurn" => Some(TurnSignal::EagerEnd),
            "TurnResumed" => Some(TurnSignal::Resumed),
            "EndOfTurn" => Some(TurnSignal::End),
            _ => None,
        };
        let duration_ms = match (ended, first_start, last_end) {
            (true, Some(start), Some(end)) => Some(end.saturating_sub(start)),
            _ => None,
        };
        let result = TranscriptResult {
            text,
            is_final: ended,
            confidence: mean_confidence(&info.words),
            timestamp_ms,
            speaker: Some(self.party.clone()),
            language: None,
            segment_id: None,
            duration_ms,
            speaker_tag: None,
            turn,
        };
        if !ended {
            self.open = Some(result.clone());
        }
        Some(result)
    }

    /// The open turn's latest text as a final, for when the stream ends before
    /// its EndOfTurn (CloseStream, a lost connection). Flux never said the
    /// speaker finished, so it carries no turn signal. Reported once.
    pub fn finish_open_turn(&mut self) -> Option<TranscriptResult> {
        let open = self.open.take()?;
        Some(TranscriptResult { is_final: true, turn: None, duration_ms: None, ..open })
    }
}

fn seconds_to_ms(seconds: f64) -> u64 {
    (seconds.max(0.0) * 1000.0).round() as u64
}

/// Mean word confidence (Flux sends numbers, sometimes as strings); 0.9 without words.
fn mean_confidence(words: &[FluxWord]) -> f32 {
    let values: Vec<f64> = words
        .iter()
        .filter_map(|w| match &w.confidence {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.parse().ok(),
            _ => None,
        })
        .collect();
    if values.is_empty() {
        return 0.9;
    }
    (values.iter().sum::<f64>() / values.len() as f64) as f32
}

#[cfg(test)]
mod frame_tests {
    use super::*;

    #[test]
    fn small_chunks_become_80_ms_frames_in_order() {
        let (mut frames, now) = (FrameBatcher::default(), Instant::now());
        for _ in 0..7 {
            assert_eq!(frames.push(vec![1; 320], now), None);
        }
        let frame = frames.push(vec![2; 320], now).expect("a full frame");
        assert_eq!(frame.len(), FRAME_BYTES);
        assert_eq!((frame[0], frame[FRAME_BYTES - 1]), (1, 2));
        assert_eq!(frames.take(), None);
    }

    #[test]
    fn a_chunk_of_a_full_frame_or_more_goes_straight_out() {
        let (mut frames, now) = (FrameBatcher::default(), Instant::now());
        assert_eq!(frames.push(vec![3; 3200], now).map(|f| f.len()), Some(3200));
    }

    #[test]
    fn a_partial_frame_waits_for_more_audio_then_goes_out_when_audio_pauses() {
        let (mut frames, now) = (FrameBatcher::default(), Instant::now());
        assert_eq!(frames.take_if_paused(now), None);
        assert_eq!(frames.push(vec![4; 320], now), None);
        assert_eq!(frames.take_if_paused(now + PARTIAL_FRAME_WAIT / 2), None);
        assert_eq!(frames.take_if_paused(now + PARTIAL_FRAME_WAIT).map(|f| f.len()), Some(320));
        assert_eq!(frames.take_if_paused(now + PARTIAL_FRAME_WAIT * 2), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(model: &str) -> DeepgramConfig {
        DeepgramConfig {
            model: model.to_string(),
            smart_format: true,
            diarize: true,
            dictation: true,
            numerals: true,
            keyterms: vec!["NexQ".into(), "turn detection".into()],
            ..DeepgramConfig::default()
        }
    }

    fn params(url: &str) -> Vec<String> {
        url.split_once('?').unwrap().1.split('&').map(str::to_string).collect()
    }

    #[test]
    fn flux_models_are_recognized() {
        assert!(is_flux_model("flux-general-en"));
        assert!(is_flux_model("flux-general-multi"));
        assert!(!is_flux_model("nova-3"));
    }

    #[test]
    fn the_english_url_has_the_low_latency_profile_and_no_nova_options() {
        let url = ws_url("wss://api.deepgram.com/v2/listen", &config("flux-general-en"), "en-US");
        assert!(url.starts_with("wss://api.deepgram.com/v2/listen?"));
        let p = params(&url);
        for expected in [
            "model=flux-general-en", "encoding=linear16", "sample_rate=16000",
            "eager_eot_threshold=0.4", "eot_threshold=0.7", "eot_timeout_ms=6000",
            "numerals=true", "keyterm=NexQ", "keyterm=turn%20detection",
        ] {
            assert!(p.contains(&expected.to_string()), "missing {expected} in {url}");
        }
        for nova_only in ["smart_format", "diarize", "dictation", "endpointing", "interim_results",
                          "punctuate", "vad_events", "language=", "channels", "language_hint"] {
            assert!(!url.contains(nova_only), "{nova_only} must not be sent to Flux: {url}");
        }
    }

    #[test]
    fn multilingual_flux_gets_a_hint_only_for_its_ten_languages() {
        let es = ws_url("wss://x/v2/listen", &config("flux-general-multi"), "es");
        assert!(params(&es).contains(&"language_hint=es".to_string()));
        let pt = ws_url("wss://x/v2/listen", &config("flux-general-multi"), "pt-BR");
        assert!(params(&pt).contains(&"language_hint=pt".to_string()));
        let ko = ws_url("wss://x/v2/listen", &config("flux-general-multi"), "ko");
        assert!(!ko.contains("language_hint"), "Flux auto-detects a language it can't be hinted: {ko}");
    }

    #[test]
    fn silence_fills_only_real_gaps() {
        assert_eq!(silence_samples_for(Duration::from_millis(149)), 0);
        assert_eq!(silence_samples_for(Duration::from_millis(150)), 2_400);
        assert_eq!(silence_samples_for(Duration::from_secs(5)), 16_000);
    }

    fn turn(event: &str, transcript: &str, words: &[(f64, f64)]) -> TurnInfo {
        let words: Vec<serde_json::Value> = words
            .iter()
            .map(|(s, e)| serde_json::json!({"word": "w", "start": s, "end": e, "confidence": "0.9"}))
            .collect();
        match FluxMessage::parse(
            &serde_json::json!({
                "type": "TurnInfo", "request_id": "r", "sequence_id": 3, "event": event, "turn_index": 0,
                "audio_window_start": "0.0", "audio_window_end": "1.0", "transcript": transcript,
                "words": words, "end_of_turn_confidence": "0.5",
            })
            .to_string(),
        ) {
            Some(FluxMessage::TurnInfo(info)) => info,
            other => panic!("not a TurnInfo: {other:?}"),
        }
    }

    /// Deepgram's clock starts at wall-clock time 1_000_000.
    fn clock(offset_ms: u64) -> Option<u64> {
        Some(1_000_000 + offset_ms)
    }

    #[test]
    fn parses_the_message_types_nexq_reads() {
        assert!(matches!(FluxMessage::parse(r#"{"type":"Connected","request_id":"r","sequence_id":0}"#), Some(FluxMessage::Connected)));
        assert!(matches!(
            FluxMessage::parse(r#"{"type":"Error","sequence_id":4,"code":"INTERNAL_SERVER_ERROR","description":"boom"}"#),
            Some(FluxMessage::Error { code, .. }) if code == "INTERNAL_SERVER_ERROR"
        ));
        assert!(matches!(FluxMessage::parse(r#"{"type":"Warning","request_id":"r","sequence_id":5,"code":"W","description":"d"}"#), Some(FluxMessage::Warning { .. })));
        assert!(matches!(FluxMessage::parse(r#"{"type":"ConfigureSuccess"}"#), Some(FluxMessage::Other)));
        assert!(FluxMessage::parse("not json").is_none());
    }

    #[test]
    fn a_turn_becomes_interims_with_signals_then_one_final() {
        let mut turns = FluxTurns::new("Them");
        assert!(turns.on_turn_info(&turn("StartOfTurn", "", &[]), clock, 5).is_none());

        let update = turns.on_turn_info(&turn("Update", "What would", &[(1.0, 1.3), (1.3, 1.6)]), clock, 5).unwrap();
        assert_eq!((update.is_final, update.turn, update.text.as_str()), (false, None, "What would"));
        assert_eq!(update.timestamp_ms, 1_001_000);
        assert_eq!(update.speaker.as_deref(), Some("Them"));

        let eager = turns.on_turn_info(&turn("EagerEndOfTurn", "What would you do?", &[(1.0, 1.3), (1.3, 2.4)]), clock, 5).unwrap();
        assert_eq!((eager.is_final, eager.turn), (false, Some(TurnSignal::EagerEnd)));

        let resumed = turns.on_turn_info(&turn("TurnResumed", "", &[]), clock, 5).unwrap();
        assert_eq!((resumed.is_final, resumed.turn), (false, Some(TurnSignal::Resumed)));
        assert_eq!(resumed.text, "What would you do?");

        let end = turns.on_turn_info(&turn("EndOfTurn", " What would you do first? ", &[(1.0, 1.3), (1.3, 3.0)]), clock, 5).unwrap();
        assert_eq!((end.is_final, end.turn, end.text.as_str()), (true, Some(TurnSignal::End), "What would you do first?"));
        assert_eq!((end.timestamp_ms, end.duration_ms), (1_001_000, Some(2_000)));
        assert!((end.confidence - 0.9).abs() < 1e-6);
        // The turn ended: nothing left to finish.
        assert!(turns.finish_open_turn().is_none());
    }

    #[test]
    fn an_open_turn_is_finished_once_without_a_signal() {
        let mut turns = FluxTurns::new("Them");
        turns.on_turn_info(&turn("EagerEndOfTurn", "Half a sente", &[(2.0, 2.5)]), clock, 5);
        let last = turns.finish_open_turn().unwrap();
        assert_eq!((last.is_final, last.turn, last.text.as_str()), (true, None, "Half a sente"));
        assert_eq!(last.timestamp_ms, 1_002_000);
        assert!(turns.finish_open_turn().is_none());
    }

    #[test]
    fn a_turn_without_words_is_dated_by_its_arrival() {
        let mut turns = FluxTurns::new("You");
        let update = turns.on_turn_info(&turn("Update", "Hello", &[]), clock, 42).unwrap();
        assert_eq!(update.timestamp_ms, 42);
        assert!(turns.on_turn_info(&turn("EndOfTurn", "  ", &[]), clock, 43).is_none());
    }
}
