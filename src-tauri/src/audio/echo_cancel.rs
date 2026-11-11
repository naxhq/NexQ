//! Echo cancellation for "You".
//!
//! Without headphones the microphone also hears the other side through the
//! speakers, and both parties' STT transcribe the same words. The audio
//! captured from the output ("Them") is what the speakers play, so it is the
//! reference: WebRTC's echo canceller (AEC3, the pure-Rust `sonora` port)
//! learns the speaker-to-microphone path and removes it from the mic audio.
//!
//! Both streams are 16 kHz mono and arrive as separate chunks. AEC3 needs the
//! reference before the mic audio that contains its echo, and it can only
//! find the echo within about half a second of it. So the mic is held back
//! (`HOLD_BACK`), and each mic frame is cancelled against the reference that
//! arrived a few frames (`CUSHION`) before the newest: the echo then sits a
//! steady ~50 ms plus the acoustic delay after its reference.
//!
//! The two streams come from different devices and don't stay in step by
//! themselves: an output that sends nothing while silent (WASAPI loopback),
//! a device whose clock runs a little fast, a dropped chunk. When the queued
//! reference runs out, silence stands in until the cushion has refilled; when
//! it keeps more than it should, the excess goes. Either way the alignment
//! returns to the same place, where AEC3 already expects the echo.

use std::collections::VecDeque;

use sonora::config::EchoCanceller as Aec3;
use sonora::{AudioProcessing, Config, StreamConfig};

const SAMPLE_RATE: usize = 16_000;
/// AEC3 works on 10 ms frames.
const FRAME: usize = SAMPLE_RATE / 100;
/// Mic audio waits this long before it's cancelled.
const HOLD_BACK: usize = 8 * FRAME; // 80 ms
/// Reference frames queued ahead of the mic frame being cancelled: room for
/// the uneven timing of the two streams' chunks.
const CUSHION: usize = 4;
/// A queue that never fell below this for `CHECK_EVERY` frames holds more
/// than the cushion: the reference runs ahead.
const TOO_MANY: usize = CUSHION + 3;
/// Mic frames between checks of the queue (0.5 s).
const CHECK_EVERY: u64 = 50;
/// With no mic audio coming at all, the reference stops piling up here.
const MAX_QUEUED: usize = 200 * FRAME; // 2 s

pub struct EchoCanceller {
    apm: AudioProcessing,
    /// Reference samples not given to AEC3 yet, oldest first.
    reference: VecDeque<i16>,
    /// Mic samples not processed yet (the hold-back and a partial frame).
    mic: Vec<i16>,
    /// The reference ran out: silence until `CUSHION` frames are queued.
    refilling: bool,
    /// Fewest reference frames queued at a mic frame since the last check.
    fewest_queued: usize,
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
            reference: VecDeque::with_capacity(16 * FRAME),
            mic: Vec::with_capacity(HOLD_BACK + 4 * FRAME),
            refilling: true,
            fewest_queued: usize::MAX,
            mic_frames: 0,
        }
    }

    /// What the speakers play (the other side): the echo to remove.
    pub fn push_reference(&mut self, samples: &[i16]) {
        self.reference.extend(samples);
        if self.reference.len() > MAX_QUEUED {
            let excess = self.reference.len() - CUSHION * FRAME;
            self.reference.drain(..excess);
        }
    }

    /// The mic audio with the echo removed: everything older than the
    /// hold-back, in whole frames. The rest waits for the next call.
    pub fn process_mic(&mut self, samples: &[i16]) -> Vec<i16> {
        self.mic.extend_from_slice(samples);
        let frames = self.mic.len().saturating_sub(HOLD_BACK) / FRAME;
        let mut out = vec![0i16; frames * FRAME];
        for (i, cleaned) in out.chunks_exact_mut(FRAME).enumerate() {
            let reference = self.next_reference();
            let mut unused = [0i16; FRAME];
            let _ = self.apm.process_render_i16(&reference, &mut unused);
            let frame = &self.mic[i * FRAME..(i + 1) * FRAME];
            if self.apm.process_capture_i16(frame, cleaned).is_err() {
                cleaned.copy_from_slice(frame);
            }
        }
        self.mic.drain(..frames * FRAME);
        out
    }

    /// The reference frame for the next mic frame.
    fn next_reference(&mut self) -> [i16; FRAME] {
        let queued = self.reference.len() / FRAME;
        if queued == 0 {
            self.refilling = true;
        } else if self.refilling && queued >= CUSHION {
            self.refilling = false;
        }
        self.fewest_queued = self.fewest_queued.min(queued);

        self.mic_frames += 1;
        if self.mic_frames.is_multiple_of(CHECK_EVERY) {
            if !self.refilling && self.fewest_queued > TOO_MANY {
                let excess = (self.fewest_queued - CUSHION) * FRAME;
                self.reference.drain(..excess);
            }
            self.fewest_queued = usize::MAX;
        }

        let mut frame = [0i16; FRAME];
        if !self.refilling {
            for (slot, sample) in frame.iter_mut().zip(self.reference.drain(..FRAME)) {
                *slot = sample;
            }
        }
        frame
    }

    /// The mic audio still held back, unprocessed (when cancellation is
    /// switched off mid-meeting, so none of it is lost).
    pub fn take_held_back(&mut self) -> Vec<i16> {
        std::mem::take(&mut self.mic)
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

    // ── The capture pipeline as on a MacBook ───────────────────────────────
    // The output tap delivers 512-frame chunks of 48 kHz stereo, the built-in
    // mic ~953-frame chunks of 96 kHz mono, and each stream is resampled to
    // 16 kHz on its way into the capture loop. Minutes of it, to catch drift.

    use crate::audio::resampler::StreamResampler;

    /// Far-end speech at 48 kHz: 4 s talk spurts, 2 s pauses.
    fn far_end_48k(seconds: usize) -> Vec<f32> {
        let mut x = 0x9e37_79b9u32;
        let (mut low, mut low2) = (0.0f32, 0.0f32);
        (0..seconds * 48_000)
            .map(|n| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                let white = (x as f32 / u32::MAX as f32) * 2.0 - 1.0;
                low = 0.6 * low + 0.4 * white;
                low2 = 0.6 * low2 + 0.4 * low;
                let t = n as f32 / 48_000.0;
                let syllable = (t * 2.0 * std::f32::consts::PI * 3.0).sin().abs();
                if t % 6.0 < 4.0 {
                    low2 * syllable * 9000.0
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// The far end's 48 kHz signal at a fractional position.
    fn at(far: &[f32], pos: f64) -> f32 {
        if pos < 0.0 {
            return 0.0;
        }
        let i = pos as usize;
        let f = (pos - i as f64) as f32;
        let a = far.get(i).copied().unwrap_or(0.0);
        let b = far.get(i + 1).copied().unwrap_or(0.0);
        a + (b - a) * f
    }

    struct Chunk {
        arrives: f64,
        system: bool,
        pcm: Vec<i16>,
    }

    /// The two capture streams as chunks in order of arrival. The mic hears
    /// the speaker `delay_ms` later with a reflection; its clock runs
    /// `mic_ppm` fast. `resample(rate, channels)` makes each stream's
    /// converter.
    fn capture<R: FnMut(&[i16]) -> Vec<i16>>(
        far: &[f32],
        delay_ms: f64,
        mic_ppm: f64,
        resample: impl Fn(u32, u16) -> R,
    ) -> Vec<Chunk> {
        let mut chunks = Vec::new();
        let mut tap = resample(48_000, 2);
        for (k, block) in far.chunks(512).enumerate() {
            let stereo: Vec<i16> = block.iter().flat_map(|&s| [s as i16, s as i16]).collect();
            chunks.push(Chunk {
                arrives: ((k + 1) * 512) as f64 / 48_000.0 + 0.001,
                system: true,
                pcm: tap(&stereo),
            });
        }
        let mic_rate = 96_000.0 * (1.0 + mic_ppm * 1e-6);
        let len = (far.len() as f64 / 48_000.0 * mic_rate) as usize;
        let mut mic = resample(96_000, 1);
        let (mut start, mut j) = (0, 0);
        while start < len {
            let end = (start + if j % 7 < 4 { 953 } else { 952 }).min(len);
            let pcm: Vec<i16> = (start..end)
                .map(|n| {
                    let p = n as f64 / mic_rate * 48_000.0 - delay_ms * 48.0;
                    (0.5 * at(far, p) + 0.2 * at(far, p - 150.0)) as i16
                })
                .collect();
            chunks.push(Chunk {
                arrives: end as f64 / mic_rate + 0.001,
                system: false,
                pcm: mic(&pcm),
            });
            start = end;
            j += 1;
        }
        chunks.sort_by(|a, b| a.arrives.total_cmp(&b.arrives));
        chunks
    }

    /// Echo reduction (dB) in each `window`-second stretch.
    fn reduction_over_time(chunks: Vec<Chunk>, window: usize) -> Vec<f64> {
        let mut filter = MicEchoFilter::new();
        let (mut raw, mut out) = (Vec::new(), Vec::new());
        for chunk in chunks {
            if chunk.system {
                filter.reference(true, &chunk.pcm);
            } else {
                raw.extend_from_slice(&chunk.pcm);
                out.extend(filter.mic(true, chunk.pcm));
            }
        }
        out.chunks_exact(window * SAMPLE_RATE)
            .zip(raw.chunks_exact(window * SAMPLE_RATE))
            .map(|(out, raw)| db(energy(raw) / energy(out).max(1.0)))
            .collect()
    }

    fn streaming(rate: u32, channels: u16) -> impl FnMut(&[i16]) -> Vec<i16> {
        let mut resampler = StreamResampler::new(rate, 16_000, channels);
        move |chunk| resampler.process(chunk)
    }

    /// The meeting that went wrong: each chunk resampled on its own made the
    /// tap's stream 0.2% fast and the mic's 0.15%, and after a minute the
    /// echo was barely touched. Resampled as streams, it stays removed.
    #[test]
    fn macbook_tap_and_mic_stay_aligned_for_minutes() {
        let far = far_end_48k(90);
        let per_10s = reduction_over_time(capture(&far, 15.0, 0.0, streaming), 10);
        for (i, reduction) in per_10s.iter().enumerate().skip(1) {
            assert!(
                *reduction > 20.0,
                "{}–{} s: echo only reduced by {reduction:.1} dB ({per_10s:.1?})",
                i * 10,
                i * 10 + 10
            );
        }
    }

    /// Mic and speakers on different clocks (a USB mic): the queue re-aligns.
    #[test]
    fn a_mic_with_its_own_clock_stays_aligned() {
        let far = far_end_48k(90);
        for ppm in [-300.0, 300.0] {
            let per_10s = reduction_over_time(capture(&far, 15.0, ppm, streaming), 10);
            let weak = per_10s.iter().skip(1).filter(|&&r| r < 20.0).count();
            assert!(weak <= 1, "mic clock {ppm:+} ppm: {per_10s:.1?}");
        }
    }

    #[test]
    #[ignore = "four minutes of audio per case; run with --ignored --nocapture"]
    fn macbook_pipeline_report() {
        let far = far_end_48k(240);
        let chunked = |rate: u32, channels: u16| {
            move |c: &[i16]| crate::audio::resampler::resample(c, rate, 16_000, channels)
        };
        let fresh = |rate: u32, channels: u16| {
            // the old converter: every chunk on its own, rounded up
            move |c: &[i16]| {
                let mono: Vec<i16> = c
                    .chunks_exact(channels as usize)
                    .map(|f| (f.iter().map(|&s| s as i32).sum::<i32>() / channels as i32) as i16)
                    .collect();
                let ratio = rate as f64 / 16_000.0;
                let n = (mono.len() as f64 / ratio).ceil() as usize;
                (0..n)
                    .map(|i| {
                        let p = i as f64 * ratio;
                        let j = p as usize;
                        let f = p - j as f64;
                        match (mono.get(j), mono.get(j + 1)) {
                            (Some(&a), Some(&b)) => {
                                (a as f64 * (1.0 - f) + b as f64 * f).round() as i16
                            }
                            (Some(&a), None) => a,
                            _ => 0,
                        }
                    })
                    .collect::<Vec<_>>()
            }
        };
        let show = |name: &str, r: Vec<f64>| {
            println!(
                "{name:<40} {:?}",
                r.iter().map(|d| format!("{d:.0}")).collect::<Vec<_>>()
            );
        };
        show(
            "old converter (per chunk, rounded up)",
            reduction_over_time(capture(&far, 15.0, 0.0, fresh), 20),
        );
        show(
            "one-shot converter per chunk",
            reduction_over_time(capture(&far, 15.0, 0.0, chunked), 20),
        );
        show(
            "streaming converter",
            reduction_over_time(capture(&far, 15.0, 0.0, streaming), 20),
        );
        show(
            "streaming, mic clock +300 ppm",
            reduction_over_time(capture(&far, 15.0, 300.0, streaming), 20),
        );
        show(
            "streaming, mic clock -300 ppm",
            reduction_over_time(capture(&far, 15.0, -300.0, streaming), 20),
        );
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
