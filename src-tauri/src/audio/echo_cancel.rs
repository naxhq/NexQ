//! Echo cancellation for "You".
//!
//! Without headphones the microphone also hears the other side through the
//! speakers, and both parties' STT transcribe the same words. The audio
//! captured from the output ("Them") is what the speakers play, so it is the
//! reference: WebRTC's echo canceller (AEC3, the pure-Rust `sonora` port)
//! learns the speaker-to-microphone path and removes it from the mic audio.
//!
//! Both streams are 16 kHz mono and arrive as separate chunks. AEC3 needs the
//! reference before the mic audio that contains its echo, so the mic is held
//! back by `HOLD_BACK`. An output that delivers nothing while it is silent
//! (WASAPI loopback) would let the reference fall behind for good, so silence
//! fills it in.

use sonora::config::EchoCanceller as Aec3;
use sonora::{AudioProcessing, Config, StreamConfig};

const SAMPLE_RATE: usize = 16_000;
/// AEC3 works on 10 ms frames.
const FRAME: usize = SAMPLE_RATE / 100;
/// Mic audio waits this long, so the reference for it has always arrived.
const HOLD_BACK: usize = 8 * FRAME; // 80 ms

pub struct EchoCanceller {
    apm: AudioProcessing,
    /// Reference samples short of a whole frame.
    reference: Vec<i16>,
    /// Mic samples not processed yet (the hold-back and a partial frame).
    mic: Vec<i16>,
    reference_frames: u64,
    mic_frames: u64,
}

impl EchoCanceller {
    pub fn new() -> Self {
        let stream = StreamConfig::new(SAMPLE_RATE as _, 1);
        let config = Config {
            echo_canceller: Some(Aec3::default()),
            ..Default::default()
        };
        Self {
            apm: AudioProcessing::builder()
                .config(config)
                .capture_config(stream)
                .render_config(stream)
                .build(),
            reference: Vec::with_capacity(4 * FRAME),
            mic: Vec::with_capacity(HOLD_BACK + 4 * FRAME),
            reference_frames: 0,
            mic_frames: 0,
        }
    }

    /// What the speakers play (the other side): the echo to remove.
    pub fn push_reference(&mut self, samples: &[i16]) {
        self.reference.extend_from_slice(samples);
        let whole = self.reference.len() / FRAME * FRAME;
        for start in (0..whole).step_by(FRAME) {
            let mut frame = [0i16; FRAME];
            frame.copy_from_slice(&self.reference[start..start + FRAME]);
            self.feed_reference(&frame);
        }
        self.reference.drain(..whole);
    }

    /// The mic audio with the echo removed: everything older than the
    /// hold-back, in whole frames. The rest waits for the next call.
    pub fn process_mic(&mut self, samples: &[i16]) -> Vec<i16> {
        self.mic.extend_from_slice(samples);
        let frames = self.mic.len().saturating_sub(HOLD_BACK) / FRAME;
        let mut out = vec![0i16; frames * FRAME];
        for (i, cleaned) in out.chunks_exact_mut(FRAME).enumerate() {
            // The reference went quiet: what the speakers play is silence.
            while self.reference_frames <= self.mic_frames {
                self.feed_reference(&[0; FRAME]);
            }
            let frame = &self.mic[i * FRAME..(i + 1) * FRAME];
            if self.apm.process_capture_i16(frame, cleaned).is_err() {
                cleaned.copy_from_slice(frame);
            }
            self.mic_frames += 1;
        }
        self.mic.drain(..frames * FRAME);
        out
    }

    /// The mic audio still held back, unprocessed (when cancellation is
    /// switched off mid-meeting, so none of it is lost).
    pub fn take_held_back(&mut self) -> Vec<i16> {
        std::mem::take(&mut self.mic)
    }

    fn feed_reference(&mut self, frame: &[i16; FRAME]) {
        let mut unused = [0i16; FRAME];
        let _ = self.apm.process_render_i16(frame, &mut unused);
        self.reference_frames += 1;
    }
}

impl Default for EchoCanceller {
    fn default() -> Self {
        Self::new()
    }
}

/// Echo cancellation in the capture loop: the "Them" output is the
/// reference, "You" comes out cleaned. `enabled` is read on every chunk, so
/// the setting applies mid-meeting.
pub struct MicEchoFilter {
    canceller: Option<EchoCanceller>,
}

impl MicEchoFilter {
    pub fn new() -> Self {
        Self { canceller: None }
    }

    pub fn reference(&mut self, enabled: bool, samples: &[i16]) {
        if enabled {
            self.canceller
                .get_or_insert_with(EchoCanceller::new)
                .push_reference(samples);
        }
    }

    /// The mic chunk to pass on; empty while the hold-back fills up.
    pub fn mic(&mut self, enabled: bool, samples: Vec<i16>) -> Vec<i16> {
        match (enabled, self.canceller.as_mut()) {
            (true, Some(canceller)) => canceller.process_mic(&samples),
            (true, None) => self
                .canceller
                .insert(EchoCanceller::new())
                .process_mic(&samples),
            (false, Some(_)) => {
                let mut held = self
                    .canceller
                    .take()
                    .map(|mut c| c.take_held_back())
                    .unwrap_or_default();
                held.extend_from_slice(&samples);
                held
            }
            (false, None) => samples,
        }
    }
}

impl Default for MicEchoFilter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Speech-like test signal: noise shaped by a slow syllable envelope,
    /// deterministic (xorshift).
    fn speechlike(seed: u32, len: usize, amplitude: f32) -> Vec<i16> {
        let mut x = seed.max(1);
        let mut low = 0.0f32;
        (0..len)
            .map(|n| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                let white = (x as f32 / u32::MAX as f32) * 2.0 - 1.0;
                low = 0.7 * low + 0.3 * white;
                let syllable = (n as f32 / SAMPLE_RATE as f32 * 2.0 * std::f32::consts::PI * 3.0)
                    .sin()
                    .abs();
                (low * syllable * amplitude) as i16
            })
            .collect()
    }

    /// The room: the speaker signal reaches the mic `delay` samples later,
    /// quieter, with one reflection.
    fn room(speaker: &[i16], delay: usize) -> Vec<i16> {
        (0..speaker.len())
            .map(|n| {
                let direct = if n >= delay {
                    speaker[n - delay] as f32 * 0.5
                } else {
                    0.0
                };
                let reflected = if n >= delay + 40 {
                    speaker[n - delay - 40] as f32 * 0.2
                } else {
                    0.0
                };
                (direct + reflected) as i16
            })
            .collect()
    }

    fn energy(samples: &[i16]) -> f64 {
        samples
            .iter()
            .map(|&s| (s as f64) * (s as f64))
            .sum::<f64>()
            / samples.len().max(1) as f64
    }

    fn db(ratio: f64) -> f64 {
        10.0 * ratio.log10()
    }

    /// Runs both streams through the canceller the way the capture loop
    /// does: reference and mic chunks of uneven sizes, interleaved, the
    /// reference ahead by `lead` samples. Returns the cleaned mic audio.
    fn run(
        reference: &[i16],
        mic: &[i16],
        lead: usize,
        gaps: &[std::ops::Range<usize>],
    ) -> Vec<i16> {
        let mut aec = EchoCanceller::new();
        let mut out = Vec::new();
        let (mut r, mut m) = (0, 0);
        while m < mic.len() {
            let target = (m + lead).min(reference.len());
            while r < target {
                let end = (r + 171).min(target);
                // A gap: the output sends nothing (WASAPI loopback in silence).
                if !gaps.iter().any(|g| g.contains(&r)) {
                    aec.push_reference(&reference[r..end]);
                }
                r = end;
            }
            let end = (m + 177).min(mic.len());
            out.extend(aec.process_mic(&mic[m..end]));
            m = end;
        }
        out
    }

    #[test]
    fn removes_the_echo_of_the_speakers() {
        let speaker = speechlike(7, SAMPLE_RATE * 8, 8000.0);
        let mic = room(&speaker, 480); // 30 ms speaker-to-mic
        let out = run(&speaker, &mic, 160, &[]);
        assert!(
            out.len() + HOLD_BACK + FRAME > mic.len(),
            "all but the hold-back comes out"
        );

        // After 4 s to converge. Output sample i is mic sample i, cleaned.
        let tail = SAMPLE_RATE * 4..out.len();
        let reduction = db(energy(&mic[tail.start..tail.end]) / energy(&out[tail]).max(1.0));
        assert!(reduction > 20.0, "echo only reduced by {reduction:.1} dB");
    }

    #[test]
    fn keeps_the_users_voice() {
        let voice = speechlike(11, SAMPLE_RATE * 4, 6000.0);
        let silence = vec![0i16; voice.len()];
        let out = run(&silence, &voice, 160, &[]);
        let tail = SAMPLE_RATE * 2..out.len();
        let kept = db(energy(&out[tail.clone()]) / energy(&voice[tail]));
        assert!(
            kept > -3.0,
            "voice lost {:.1} dB with nothing playing",
            -kept
        );
    }

    #[test]
    fn keeps_the_users_voice_over_the_other_side() {
        let speaker = speechlike(7, SAMPLE_RATE * 8, 8000.0);
        let voice = speechlike(23, SAMPLE_RATE * 8, 6000.0);
        let echo = room(&speaker, 480);
        let mic: Vec<i16> = echo
            .iter()
            .zip(&voice)
            .map(|(&e, &v)| e.saturating_add(v))
            .collect();
        let only_echo = run(&speaker, &echo, 160, &[]);
        let both = run(&speaker, &mic, 160, &[]);
        let tail = SAMPLE_RATE * 5..both.len();
        // What's left beyond the residual echo is the user's voice.
        let residual: Vec<i16> = both[tail.clone()]
            .iter()
            .zip(&only_echo[tail.clone()])
            .map(|(&b, &e)| b.saturating_sub(e))
            .collect();
        let kept = db(energy(&residual) / energy(&voice[tail]));
        assert!(
            kept > -10.0,
            "double-talk lost {:.1} dB of the user's voice",
            -kept
        );
    }

    /// The reference stops for a while (nothing playing on Windows) and comes
    /// back: the echo after it is still removed.
    #[test]
    fn a_silent_gap_in_the_reference_keeps_the_streams_aligned() {
        let mut speaker = speechlike(5, SAMPLE_RATE * 10, 8000.0);
        let gap = SAMPLE_RATE * 3..SAMPLE_RATE * 5;
        speaker[gap.clone()].fill(0);
        let mic = room(&speaker, 480);
        let out = run(&speaker, &mic, 160, &[gap]);
        let tail = SAMPLE_RATE * 7..out.len();
        let reduction = db(energy(&mic[tail.start..tail.end]) / energy(&out[tail]).max(1.0));
        assert!(
            reduction > 20.0,
            "echo after the gap only reduced by {reduction:.1} dB"
        );
    }

    /// The reference arriving a little after the mic still works: the
    /// hold-back absorbs it.
    #[test]
    fn a_late_reference_is_absorbed_by_the_hold_back() {
        let speaker = speechlike(9, SAMPLE_RATE * 8, 8000.0);
        let mic = room(&speaker, 480);
        let mut aec = EchoCanceller::new();
        let mut out = Vec::new();
        // The reference trails the mic by 40 ms.
        let lag = 640;
        for m in (0..mic.len()).step_by(160) {
            out.extend(aec.process_mic(&mic[m..m + 160]));
            if m >= lag {
                aec.push_reference(&speaker[m - lag..m - lag + 160]);
            }
        }
        let tail = SAMPLE_RATE * 4..out.len();
        let reduction = db(energy(&mic[tail.start..tail.end]) / energy(&out[tail]).max(1.0));
        assert!(reduction > 20.0, "echo only reduced by {reduction:.1} dB");
    }

    #[test]
    fn switching_off_mid_meeting_loses_no_audio() {
        let mut filter = MicEchoFilter::new();
        let mut total = 0;
        for _ in 0..20 {
            filter.reference(true, &[0; 160]);
            total += filter.mic(true, vec![100; 160]).len();
        }
        total += filter.mic(false, vec![100; 160]).len();
        assert_eq!(total, 21 * 160);
        assert_eq!(
            filter.mic(false, vec![1, 2, 3]),
            vec![1, 2, 3],
            "off: passed through as is"
        );
    }
}
