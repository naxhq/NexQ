// Cartesia Realtime STT (Auto): WebSocket streaming with built-in turn detection
//
// Connects to wss://api.cartesia.ai/stt/turns/websocket (model ink-2) and sends
// 16 kHz mono PCM as binary frames. Cartesia decides where each speaker turn
// starts and ends, and reports it as events:
// - turn.update / turn.eager_end carry the turn so far (cumulative, never
//   revised) and become interim results
// - turn.end carries the finished turn and becomes the final result
// Cartesia sends no word timestamps, so a turn is stamped with the time its
// turn.start arrived.

use serde::Deserialize;

use crate::stt::provider::TranscriptResult;

/// Cartesia model used for realtime transcription with turn detection.
const MODEL: &str = "ink-2";

/// Cartesia API version sent as the `cartesia_version` query parameter.
const API_VERSION: &str = "2026-08-14";

/// Realtime STT (Auto) endpoint, without query parameters.
const DEFAULT_WS_URL: &str = "wss://api.cartesia.ai/stt/turns/websocket";

/// Sample rate of the audio sent to Cartesia (`sample_rate=16000`, mono).
const SAMPLE_RATE: u32 = 16_000;

/// Languages ink-2 detects on its own (ISO 639-1). There is no language parameter.
pub const SUPPORTED_LANGUAGES: [&str; 5] = ["en", "fr", "hi", "ja", "es"];

/// A message from Cartesia. Every message also carries `request_id`.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
enum ServerEvent {
    #[serde(rename = "connected")]
    Connected {
        #[serde(default)]
        request_id: String,
    },
    #[serde(rename = "turn.start")]
    TurnStart {},
    #[serde(rename = "turn.update")]
    TurnUpdate { transcript: String },
    #[serde(rename = "turn.eager_end")]
    TurnEagerEnd { transcript: String },
    #[serde(rename = "turn.resume")]
    TurnResume {},
    #[serde(rename = "turn.end")]
    TurnEnd { transcript: String },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        status_code: Option<u16>,
        #[serde(default)]
        title: String,
        #[serde(default)]
        message: String,
    },
    #[serde(other)]
    Unknown,
}

impl ServerEvent {
    /// Parse a text frame; `None` when it isn't valid JSON or lacks a `type`.
    fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

/// Turns Cartesia's turn events into transcript results for one party.
struct TurnTracker {
    party: String,
    /// Epoch ms when the open turn started; `None` between turns.
    turn_start_ms: Option<u64>,
    /// Latest cumulative text of the open turn.
    turn_text: String,
}

impl TurnTracker {
    fn new(party: &str) -> Self {
        Self {
            party: party.to_string(),
            turn_start_ms: None,
            turn_text: String::new(),
        }
    }

    /// The result for `event` received at `now_ms`, if it carries one.
    fn on_event(&mut self, event: &ServerEvent, now_ms: u64) -> Option<TranscriptResult> {
        match event {
            ServerEvent::TurnStart {} => {
                self.turn_start_ms = Some(now_ms);
                self.turn_text.clear();
                None
            }
            ServerEvent::TurnUpdate { transcript } | ServerEvent::TurnEagerEnd { transcript } => {
                let start = *self.turn_start_ms.get_or_insert(now_ms);
                self.turn_text = transcript.trim().to_string();
                if self.turn_text.is_empty() {
                    return None;
                }
                Some(self.result(self.turn_text.clone(), false, start, None))
            }
            ServerEvent::TurnEnd { transcript } => {
                let start = self.turn_start_ms.take().unwrap_or(now_ms);
                self.turn_text.clear();
                let text = transcript.trim();
                if text.is_empty() {
                    return None;
                }
                Some(self.result(text.to_string(), true, start, Some(now_ms.saturating_sub(start))))
            }
            _ => None,
        }
    }

    /// The open turn's latest text as a final, for when the connection ends
    /// before its turn.end. Clears the turn, so it is only reported once.
    fn finish_open_turn(&mut self, now_ms: u64) -> Option<TranscriptResult> {
        let start = self.turn_start_ms.take()?;
        let text = std::mem::take(&mut self.turn_text);
        if text.is_empty() {
            return None;
        }
        Some(self.result(text, true, start, Some(now_ms.saturating_sub(start))))
    }

    fn result(&self, text: String, is_final: bool, start_ms: u64, duration_ms: Option<u64>) -> TranscriptResult {
        TranscriptResult {
            text,
            is_final,
            // Cartesia reports no confidence; its text is never revised.
            confidence: 1.0,
            timestamp_ms: start_ms,
            speaker: Some(self.party.clone()),
            language: None,
            segment_id: None,
            duration_ms,
            speaker_tag: None,
        }
    }
}

/// The endpoint URL with every required query parameter. The API key goes in
/// the `X-API-Key` header, never in the URL.
fn build_ws_url(base_url: &str) -> String {
    format!(
        "{}?model={}&encoding=pcm_s16le&sample_rate={}&cartesia_version={}",
        base_url, MODEL, SAMPLE_RATE, API_VERSION
    )
}

/// 16-bit samples as little-endian bytes (`pcm_s16le`).
fn pcm_to_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(json: &str) -> ServerEvent {
        ServerEvent::parse(json).expect("valid event")
    }

    #[test]
    fn parses_every_event_type() {
        assert_eq!(
            event(r#"{"type":"connected","request_id":"r1"}"#),
            ServerEvent::Connected { request_id: "r1".into() }
        );
        assert_eq!(event(r#"{"type":"turn.start","request_id":"r1"}"#), ServerEvent::TurnStart {});
        assert_eq!(
            event(r#"{"type":"turn.update","transcript":"Hi I","request_id":"r1"}"#),
            ServerEvent::TurnUpdate { transcript: "Hi I".into() }
        );
        assert_eq!(
            event(r#"{"type":"turn.eager_end","transcript":"Hi I need","request_id":"r1"}"#),
            ServerEvent::TurnEagerEnd { transcript: "Hi I need".into() }
        );
        assert_eq!(event(r#"{"type":"turn.resume","request_id":"r1"}"#), ServerEvent::TurnResume {});
        assert_eq!(
            event(r#"{"type":"turn.end","transcript":"Hi I need help.","request_id":"r1"}"#),
            ServerEvent::TurnEnd { transcript: "Hi I need help.".into() }
        );
        assert_eq!(
            event(r#"{"type":"error","status_code":401,"title":"Unauthorized","message":"Invalid API key","error_code":"invalid_api_key"}"#),
            ServerEvent::Error { status_code: Some(401), title: "Unauthorized".into(), message: "Invalid API key".into() }
        );
    }

    #[test]
    fn unknown_or_malformed_messages_are_harmless() {
        assert_eq!(event(r#"{"type":"turn.something_new","x":1}"#), ServerEvent::Unknown);
        assert_eq!(ServerEvent::parse("not json"), None);
        assert_eq!(ServerEvent::parse(r#"{"transcript":"no type"}"#), None);
        let mut turns = TurnTracker::new("Them");
        assert!(turns.on_event(&ServerEvent::Unknown, 1_000).is_none());
    }

    #[test]
    fn a_turn_becomes_interims_then_one_final() {
        let mut turns = TurnTracker::new("Them");
        assert!(turns.on_event(&event(r#"{"type":"turn.start"}"#), 10_000).is_none());

        let update = turns.on_event(&event(r#"{"type":"turn.update","transcript":"Hi I"}"#), 10_400).unwrap();
        assert_eq!(update.text, "Hi I");
        assert!(!update.is_final);
        assert_eq!(update.timestamp_ms, 10_000);
        assert_eq!(update.speaker.as_deref(), Some("Them"));

        let eager = turns.on_event(&event(r#"{"type":"turn.eager_end","transcript":"Hi I need to cancel"}"#), 11_000).unwrap();
        assert!(!eager.is_final);
        assert_eq!(eager.text, "Hi I need to cancel");
        assert!(turns.on_event(&event(r#"{"type":"turn.resume"}"#), 11_100).is_none());

        let end = turns.on_event(&event(r#"{"type":"turn.end","transcript":"Hi I need to cancel my plan. "}"#), 12_500).unwrap();
        assert!(end.is_final);
        assert_eq!(end.text, "Hi I need to cancel my plan.");
        assert_eq!(end.timestamp_ms, 10_000);
        assert_eq!(end.duration_ms, Some(2_500));
        assert_eq!(end.language, None);
        assert_eq!(end.speaker_tag, None);
    }

    #[test]
    fn empty_turns_produce_nothing() {
        let mut turns = TurnTracker::new("You");
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 1_000);
        assert!(turns.on_event(&event(r#"{"type":"turn.update","transcript":"  "}"#), 1_200).is_none());
        assert!(turns.on_event(&event(r#"{"type":"turn.end","transcript":""}"#), 1_500).is_none());
        assert!(turns.finish_open_turn(2_000).is_none());
    }

    #[test]
    fn a_turn_without_turn_start_is_stamped_at_its_first_event() {
        let mut turns = TurnTracker::new("Them");
        let update = turns.on_event(&event(r#"{"type":"turn.update","transcript":"Hello"}"#), 5_000).unwrap();
        assert_eq!(update.timestamp_ms, 5_000);
        let end = turns.on_event(&event(r#"{"type":"turn.end","transcript":"Hello there"}"#), 6_000).unwrap();
        assert_eq!((end.timestamp_ms, end.duration_ms), (5_000, Some(1_000)));
    }

    #[test]
    fn an_open_turn_is_finished_once_with_its_latest_text() {
        let mut turns = TurnTracker::new("Them");
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 1_000);
        turns.on_event(&event(r#"{"type":"turn.update","transcript":"half a sente"}"#), 1_600);
        let last = turns.finish_open_turn(2_000).unwrap();
        assert!(last.is_final);
        assert_eq!(last.text, "half a sente");
        assert_eq!((last.timestamp_ms, last.duration_ms), (1_000, Some(1_000)));
        assert!(turns.finish_open_turn(3_000).is_none());
        // A turn that already ended leaves nothing to finish.
        turns.on_event(&event(r#"{"type":"turn.start"}"#), 4_000);
        turns.on_event(&event(r#"{"type":"turn.end","transcript":"Done."}"#), 4_500);
        assert!(turns.finish_open_turn(5_000).is_none());
    }

    #[test]
    fn url_has_required_params_and_no_key() {
        let url = build_ws_url(DEFAULT_WS_URL);
        assert_eq!(
            url,
            "wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000&cartesia_version=2026-08-14"
        );
        assert!(!url.to_lowercase().contains("key"));
    }

    #[test]
    fn pcm_is_little_endian() {
        assert_eq!(pcm_to_bytes(&[1, -2, 0x1234]), vec![0x01, 0x00, 0xFE, 0xFF, 0x34, 0x12]);
    }
}
