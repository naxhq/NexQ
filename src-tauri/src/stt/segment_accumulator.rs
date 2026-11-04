// Segment Accumulator — merges consecutive STT finals from the same speaker
// into one paragraph until a pause, a speaker change or the paragraph cap.
//
// Sits between the STT provider output and IPC event emission.
// Interim results pass through immediately (same segment ID for in-place replacement).
// Final results are merged into the current paragraph (re-emitted under the
// same ID with the longer text) until one of these starts a new paragraph:
// - the silence between the END of the previous final and the START of the
//   new one reaches the pause threshold (a final's end is start + duration;
//   when the provider gives no duration, the time the previous final arrived);
// - the speaker or the diarization speaker tag changes;
// - the paragraph already spans MAX_PARAGRAPH_MS (so long monologues still
//   get fresh timestamps).

use super::provider::{TranscriptResult, TurnSignal};

/// A paragraph that already spans this long ends at the next final.
pub const MAX_PARAGRAPH_MS: u64 = 60_000;

/// Timestamps at or above this are epoch ms (2001+); smaller ones are
/// relative to the STT stream's start.
const EPOCH_MS_FLOOR: u64 = 1_000_000_000_000;

/// Rough speaking time of `text` (~150 words per minute).
fn estimated_speech_ms(text: &str) -> u64 {
    text.split_whitespace().count() as u64 * 400
}

/// Wall-clock time in epoch milliseconds (injectable for tests).
pub type Clock = Box<dyn Fn() -> u64 + Send>;

fn epoch_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Output from the accumulator — one or two segments per `feed_result` call.
#[derive(Debug, Clone)]
pub struct AccumulatorOutput {
    pub id: String,
    pub text: String,
    pub speaker: String,
    /// Diarization tag of the paragraph's speaker ("S1", "S2"...), if any.
    pub speaker_tag: Option<String>,
    pub timestamp_ms: u64,
    pub is_final: bool,
    pub confidence: f32,
    /// The provider's turn signal for the result this output reports. A
    /// paragraph closed by a new one carries none.
    pub turn: Option<TurnSignal>,
}

pub struct SegmentAccumulator {
    /// Configurable pause duration in ms (default: 3000ms)
    pause_threshold_ms: u64,
    /// Accumulated text for the current (in-progress) segment
    current_text: String,
    /// Speaker for the current segment
    current_speaker: String,
    /// Diarization tag for the current segment
    current_tag: Option<String>,
    /// Start of the first final in the current segment
    current_start_ms: u64,
    /// End of the most recent final (start + duration, or its arrival time)
    last_end_ms: u64,
    /// Monotonic counter for generating unique segment IDs
    segment_counter: u64,
    /// Whether we have an active accumulated segment
    has_active: bool,
    clock: Clock,
}

impl SegmentAccumulator {
    pub fn new(pause_threshold_ms: u64) -> Self {
        Self::with_clock(pause_threshold_ms, Box::new(epoch_now_ms))
    }

    /// Like `new`, with the clock used when a final has no duration.
    pub fn with_clock(pause_threshold_ms: u64, clock: Clock) -> Self {
        Self {
            pause_threshold_ms,
            current_text: String::new(),
            current_speaker: String::new(),
            current_tag: None,
            current_start_ms: 0,
            last_end_ms: 0,
            segment_counter: 0,
            has_active: false,
            clock,
        }
    }

    fn output(&self, is_final: bool, confidence: f32) -> AccumulatorOutput {
        AccumulatorOutput {
            id: format!("acc_{}", self.segment_counter),
            text: self.current_text.clone(),
            speaker: self.current_speaker.clone(),
            speaker_tag: self.current_tag.clone(),
            timestamp_ms: self.current_start_ms,
            is_final,
            confidence,
            turn: None,
        }
    }

    /// Process a transcript result and return accumulated outputs.
    ///
    /// Returns 0-2 outputs:
    /// - Interim result: emits a single interim output with the accumulated text + interim text
    /// - Final result continuing the paragraph: merges text, returns the updated final
    /// - Final result starting a new paragraph: finalizes the old one + starts the new one
    pub fn feed_result(&mut self, result: TranscriptResult) -> Vec<AccumulatorOutput> {
        let speaker = result
            .speaker
            .clone()
            .unwrap_or_else(|| "Unknown".to_string());

        // Interim results: pass through with accumulated prefix for display
        if !result.is_final {
            if self.has_active {
                // Shown as the end of the current line (same id, speaker and
                // tag), so the interim replaces it in place instead of
                // adding a duplicate line in the UI.
                let mut out = self.output(false, result.confidence);
                out.text = format!("{} {}", self.current_text, result.text);
                out.turn = result.turn;
                return vec![out];
            }
            return vec![AccumulatorOutput {
                id: format!("acc_{}", self.segment_counter + 1),
                text: result.text.clone(),
                speaker,
                speaker_tag: result.speaker_tag.clone(),
                timestamp_ms: result.timestamp_ms,
                is_final: false,
                confidence: result.confidence,
                turn: result.turn,
            }];
        }

        let end_ms = match result.duration_ms {
            Some(duration) => result.timestamp_ms + duration,
            // Epoch-stamped final: it arrives about when the speech ends.
            None if result.timestamp_ms >= EPOCH_MS_FLOOR => (self.clock)().max(result.timestamp_ms),
            // Stamped relative to its stream (whisper.cpp, Groq, Azure...):
            // the wall clock is another time base, so estimate the end
            // from the words spoken.
            None => result.timestamp_ms + estimated_speech_ms(&result.text),
        };

        let mut outputs = Vec::new();
        if self.has_active && !self.starts_new_paragraph(&result, &speaker) {
            if !self.current_text.is_empty() {
                self.current_text.push(' ');
            }
            self.current_text.push_str(&result.text);
            self.last_end_ms = self.last_end_ms.max(end_ms);
            // Updated paragraph as a final (replaces the previous one with the same ID)
            outputs.push(AccumulatorOutput { turn: result.turn, ..self.output(true, result.confidence) });
            return outputs;
        }

        if self.has_active && !self.current_text.is_empty() {
            outputs.push(self.output(true, result.confidence));
        }
        self.segment_counter += 1;
        self.current_text = result.text.clone();
        self.current_speaker = speaker;
        self.current_tag = result.speaker_tag.clone();
        self.current_start_ms = result.timestamp_ms;
        self.last_end_ms = end_ms;
        self.has_active = true;
        // The new paragraph as a final (it may get merged with later results)
        outputs.push(AccumulatorOutput { turn: result.turn, ..self.output(true, result.confidence) });
        outputs
    }

    /// Whether the final `result` (from `speaker`) ends the current paragraph.
    fn starts_new_paragraph(&self, result: &TranscriptResult, speaker: &str) -> bool {
        let speaker_changed = speaker != self.current_speaker;
        // A final without a tag (diarization off, or no word data) keeps the current one.
        let tag_changed = result.speaker_tag.is_some() && result.speaker_tag != self.current_tag;
        let pause = result.timestamp_ms.saturating_sub(self.last_end_ms) >= self.pause_threshold_ms;
        let long = self.last_end_ms.saturating_sub(self.current_start_ms) >= MAX_PARAGRAPH_MS;
        speaker_changed || tag_changed || pause || long
    }

    /// Force-finalize the current accumulated segment (e.g., on meeting end).
    pub fn flush(&mut self) -> Option<AccumulatorOutput> {
        if self.has_active && !self.current_text.is_empty() {
            let output = self.output(true, 1.0);
            self.current_text.clear();
            self.has_active = false;
            Some(output)
        } else {
            None
        }
    }

    /// Update the pause threshold at runtime.
    pub fn set_pause_threshold(&mut self, ms: u64) {
        self.pause_threshold_ms = ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    const T0: u64 = 1_700_000_000_000;

    fn fin(text: &str, start: u64, duration: Option<u64>, tag: Option<&str>) -> TranscriptResult {
        TranscriptResult {
            text: text.into(),
            is_final: true,
            confidence: 0.9,
            timestamp_ms: start,
            speaker: Some("Them".into()),
            language: None,
            segment_id: None,
            duration_ms: duration,
            speaker_tag: tag.map(str::to_string),
            turn: None,
        }
    }

    fn interim(text: &str, start: u64) -> TranscriptResult {
        TranscriptResult { is_final: false, ..fin(text, start, None, None) }
    }

    fn acc() -> SegmentAccumulator {
        SegmentAccumulator::with_clock(3000, Box::new(|| panic!("clock not expected")))
    }

    /// Feed all results; return every output in order.
    fn feed_all(acc: &mut SegmentAccumulator, results: Vec<TranscriptResult>) -> Vec<AccumulatorOutput> {
        results.into_iter().flat_map(|r| acc.feed_result(r)).collect()
    }

    #[test]
    fn deepgram_continuous_speech_is_one_paragraph() {
        // ~4 s finals with 0.3-0.8 s gaps: start-to-start is always >= 3 s,
        // but the silence between them is short.
        let mut a = acc();
        let mut start = T0;
        let mut results = Vec::new();
        for (i, gap) in [300u64, 800, 500, 400, 700, 300].iter().enumerate() {
            results.push(fin(&format!("part{i}"), start, Some(4_000), None));
            start += 4_000 + gap;
        }
        let outs = feed_all(&mut a, results);
        assert!(outs.iter().all(|o| o.id == "acc_1" && o.is_final));
        assert_eq!(outs.last().unwrap().text, "part0 part1 part2 part3 part4 part5");
        assert_eq!(outs.last().unwrap().timestamp_ms, T0);
    }

    #[test]
    fn long_silence_starts_a_new_paragraph() {
        let mut a = acc();
        a.feed_result(fin("Hello there.", T0, Some(4_000), None));
        // 3.5 s of silence after the first final ended.
        let outs = a.feed_result(fin("New topic.", T0 + 7_500, Some(2_000), None));
        assert_eq!(outs.len(), 2);
        assert_eq!((outs[0].id.as_str(), outs[0].text.as_str()), ("acc_1", "Hello there."));
        assert_eq!((outs[1].id.as_str(), outs[1].text.as_str()), ("acc_2", "New topic."));
        assert_eq!(outs[1].timestamp_ms, T0 + 7_500);
    }

    #[test]
    fn paragraph_is_capped_at_sixty_seconds() {
        let mut a = acc();
        let mut ids = Vec::new();
        let mut start = T0;
        // 20 finals of 4 s with 0.5 s gaps = 90 s of continuous speech.
        for i in 0..20 {
            let outs = a.feed_result(fin(&format!("w{i}"), start, Some(4_000), None));
            ids.push(outs.last().unwrap().id.clone());
            start += 4_500;
        }
        // The paragraph spans >= 60 s after 14 finals (13 * 4.5 s + 4 s = 62.5 s).
        assert!(ids[..14].iter().all(|id| id == "acc_1"), "{ids:?}");
        assert!(ids[14..].iter().all(|id| id == "acc_2"), "{ids:?}");
    }

    #[test]
    fn speaker_tag_change_splits_and_untagged_final_continues() {
        let mut a = acc();
        a.feed_result(fin("I think so.", T0, Some(2_000), Some("S1")));
        let outs = a.feed_result(fin("No way.", T0 + 2_200, Some(1_000), Some("S2")));
        assert_eq!(outs.len(), 2);
        assert_eq!(outs[0].speaker_tag.as_deref(), Some("S1"));
        assert_eq!((outs[1].id.as_str(), outs[1].speaker_tag.as_deref()), ("acc_2", Some("S2")));
        assert_eq!(outs[1].speaker, "Them");
        // A final without word data keeps the current speaker's line.
        let outs = a.feed_result(fin("Really.", T0 + 3_400, Some(800), None));
        assert_eq!(outs.len(), 1);
        assert_eq!((outs[0].id.as_str(), outs[0].text.as_str()), ("acc_2", "No way. Really."));
        assert_eq!(outs[0].speaker_tag.as_deref(), Some("S2"));
    }

    #[test]
    fn speaker_change_splits() {
        let mut a = acc();
        a.feed_result(fin("Hi", T0, Some(500), None));
        let outs = a.feed_result(TranscriptResult { speaker: Some("User".into()), ..fin("Hey", T0 + 600, Some(500), None) });
        assert_eq!(outs.last().unwrap().id, "acc_2");
        assert_eq!(outs.last().unwrap().speaker, "User");
    }

    #[test]
    fn unknown_duration_measures_from_arrival_of_previous_final() {
        let now = Arc::new(AtomicU64::new(T0 + 2_500));
        let clock_now = now.clone();
        let mut a = SegmentAccumulator::with_clock(3000, Box::new(move || clock_now.load(Ordering::SeqCst)));
        // Final for speech that started at T0 arrives at T0 + 2.5 s.
        a.feed_result(fin("one", T0, None, None));
        // Next utterance starts 1 s after that arrival: same paragraph.
        now.store(T0 + 6_000, Ordering::SeqCst);
        let outs = a.feed_result(fin("two", T0 + 3_500, None, None));
        assert_eq!((outs[0].id.as_str(), outs[0].text.as_str()), ("acc_1", "one two"));
        // Next starts 4 s after the previous arrival: new paragraph.
        now.store(T0 + 11_000, Ordering::SeqCst);
        let outs = a.feed_result(fin("three", T0 + 10_000, None, None));
        assert_eq!(outs.last().unwrap().id, "acc_2");
    }

    #[test]
    fn stream_relative_timestamps_without_duration_stay_in_their_time_base() {
        // whisper.cpp / Groq style: ms since the stream started, no duration.
        let mut a = SegmentAccumulator::with_clock(3000, Box::new(|| panic!("clock not expected")));
        a.feed_result(fin("so we start to fine tune this", 1_200, None, None)); // ~2.4 s of speech
        let outs = a.feed_result(fin("almost cell by cell", 4_000, None, None));
        assert_eq!((outs[0].id.as_str(), outs[0].text.as_str()), ("acc_1", "so we start to fine tune this almost cell by cell"));
        // 5 s of silence after the estimated end: new paragraph.
        let outs = a.feed_result(fin("Next point", 10_600, None, None));
        assert_eq!(outs.last().unwrap().id, "acc_2");
    }

    #[test]
    fn interim_extends_the_current_line_in_place() {
        let mut a = acc();
        let first = a.feed_result(interim("hel", T0));
        assert_eq!((first[0].id.as_str(), first[0].is_final), ("acc_1", false));
        a.feed_result(fin("Hello.", T0, Some(1_000), Some("S1")));
        let outs = a.feed_result(interim("how are", T0 + 1_200));
        assert_eq!(outs.len(), 1);
        assert_eq!((outs[0].id.as_str(), outs[0].text.as_str()), ("acc_1", "Hello. how are"));
        assert!(!outs[0].is_final);
        assert_eq!(outs[0].timestamp_ms, T0);
        assert_eq!(outs[0].speaker_tag.as_deref(), Some("S1"));
    }

    fn signal(result: TranscriptResult, turn: TurnSignal) -> TranscriptResult {
        TranscriptResult { turn: Some(turn), ..result }
    }

    #[test]
    fn a_turn_signal_stays_on_the_output_for_its_result() {
        let mut a = acc();
        let eager = a.feed_result(signal(interim("What would", T0), TurnSignal::EagerEnd));
        assert_eq!(eager[0].turn, Some(TurnSignal::EagerEnd));

        let end = a.feed_result(signal(fin("What would you do?", T0, Some(1_000), None), TurnSignal::End));
        assert_eq!((end.len(), end[0].turn), (1, Some(TurnSignal::End)));

        // An interim extending the paragraph, then a final merged into it.
        let resumed = a.feed_result(signal(interim("And then", T0 + 1_500), TurnSignal::Resumed));
        assert_eq!(resumed[0].turn, Some(TurnSignal::Resumed));
        let merged = a.feed_result(signal(fin("And then?", T0 + 1_500, Some(800), None), TurnSignal::End));
        assert_eq!((merged.len(), merged[0].text.as_str()), (1, "What would you do? And then?"));
        assert_eq!(merged[0].turn, Some(TurnSignal::End));

        // Results without a signal carry none.
        assert_eq!(a.feed_result(interim("so", T0 + 2_500))[0].turn, None);
        assert_eq!(a.feed_result(fin("So.", T0 + 2_500, Some(300), None))[0].turn, None);
    }

    #[test]
    fn the_paragraph_a_new_one_closes_carries_no_signal() {
        let mut a = acc();
        a.feed_result(fin("Hello.", T0, Some(500), None));
        let outs = a.feed_result(signal(fin("New topic?", T0 + 10_000, Some(800), None), TurnSignal::End));
        assert_eq!(outs.len(), 2);
        assert_eq!((outs[0].text.as_str(), outs[0].turn), ("Hello.", None));
        assert_eq!((outs[1].text.as_str(), outs[1].turn), ("New topic?", Some(TurnSignal::End)));
        assert_eq!(a.flush().unwrap().turn, None);
    }

    #[test]
    fn flush_finalizes_once() {
        let mut a = acc();
        a.feed_result(fin("Bye.", T0, Some(500), None));
        let out = a.flush().unwrap();
        assert_eq!((out.id.as_str(), out.text.as_str(), out.is_final), ("acc_1", "Bye.", true));
        assert!(a.flush().is_none());
    }
}
