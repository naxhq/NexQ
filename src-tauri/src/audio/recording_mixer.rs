//! Mixes the mic and system streams into the single recording track.
//!
//! Pairing samples by count only keeps the two sides aligned while both
//! deliver continuously. When one side stalls (device reconnecting, Windows
//! loopback sending nothing while nothing plays) its later samples would land
//! on the wrong time in the file, for the rest of the recording. This mixer
//! places each side on the wall clock instead: a side that falls behind is
//! filled with silence, so both stay aligned.
//!
//! Pure and synchronous. The caller passes the time (milliseconds on any
//! monotonic clock) with every call, so tests run without real time.

/// Recording format: 16 kHz mono.
const SAMPLES_PER_MS: u64 = 16;

/// A chunk that ends more than this behind the wall clock is preceded by
/// silence for the missing time. Smaller lags are scheduling jitter.
const GAP_FILL_MS: u64 = 30;
/// A side that has delivered nothing and trails the wall clock by more than
/// this is padded with silence without waiting for its next chunk, so the
/// other side's samples never wait long (and never pile up).
const STALL_MS: u64 = 150;
/// How far behind the wall clock a stalled side is left after padding. Its
/// next chunk then still finds a gap and is placed exactly.
const STALL_KEEP_MS: u64 = 60;
/// Hard cap on how far one side may run ahead of the other.
const MAX_LEAD_MS: u64 = 2000;
/// Gain applied to the sum of both sides (kept from the original mixer).
const MIX_GAIN: i32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MixSide {
    Mic,
    System,
}

#[derive(Default)]
struct SideBuf {
    /// Samples (real and padding) not yet mixed out.
    pending: Vec<i16>,
    /// Samples accepted so far, padding included: this side's position on the
    /// recording timeline.
    total: u64,
}

impl SideBuf {
    fn pad(&mut self, samples: u64) {
        if samples == 0 {
            return;
        }
        self.pending.resize(self.pending.len() + samples as usize, 0);
        self.total += samples;
    }
}

#[derive(Default)]
pub struct RecordingMixer {
    mic: SideBuf,
    sys: SideBuf,
    /// Wall-clock time (ms) of sample 0 of the recording.
    start_ms: Option<u64>,
}

impl RecordingMixer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a chunk that has just been received from `side` at `now_ms`.
    /// Returns the samples that are now ready to be written to the recording.
    pub fn push(&mut self, side: MixSide, samples: &[i16], now_ms: u64) -> Vec<i16> {
        if !samples.is_empty() {
            let len = samples.len() as u64;
            let start = *self
                .start_ms
                .get_or_insert_with(|| now_ms.saturating_sub(len / SAMPLES_PER_MS));
            let expected = now_ms.saturating_sub(start) * SAMPLES_PER_MS;
            let buf = self.side_mut(side);
            let end = buf.total + len;
            if expected > end + GAP_FILL_MS * SAMPLES_PER_MS {
                buf.pad(expected - end);
            }
            buf.pending.extend_from_slice(samples);
            buf.total += len;
        }
        self.tick(now_ms)
    }

    /// Advance to `now_ms` without new samples: pads a side that has stalled
    /// and returns what is ready to write.
    pub fn tick(&mut self, now_ms: u64) -> Vec<i16> {
        if let Some(start) = self.start_ms {
            let expected = now_ms.saturating_sub(start) * SAMPLES_PER_MS;
            let stall = STALL_MS * SAMPLES_PER_MS;
            let keep = STALL_KEEP_MS * SAMPLES_PER_MS;
            for buf in [&mut self.mic, &mut self.sys] {
                if expected > buf.total + stall {
                    buf.pad(expected - keep - buf.total);
                }
            }
            let max_lead = MAX_LEAD_MS * SAMPLES_PER_MS;
            if self.mic.total > self.sys.total + max_lead {
                let n = self.mic.total - max_lead - self.sys.total;
                self.sys.pad(n);
            } else if self.sys.total > self.mic.total + max_lead {
                let n = self.sys.total - max_lead - self.mic.total;
                self.mic.pad(n);
            }
        }
        self.take_ready()
    }

    /// End of the recording: everything still buffered, the shorter side
    /// completed with silence.
    pub fn finish(&mut self) -> Vec<i16> {
        let mut out = self.take_ready();
        let rest = self.mic.pending.len().max(self.sys.pending.len());
        if rest > 0 {
            let (m, s) = (self.mic.pending.len(), self.sys.pending.len());
            self.mic.pad((rest - m) as u64);
            self.sys.pad((rest - s) as u64);
            out.extend(self.take_ready());
        }
        out
    }

    /// Most samples either side is holding back (for bounding tests).
    pub fn buffered_samples(&self) -> usize {
        self.mic.pending.len().max(self.sys.pending.len())
    }

    fn side_mut(&mut self, side: MixSide) -> &mut SideBuf {
        match side {
            MixSide::Mic => &mut self.mic,
            MixSide::System => &mut self.sys,
        }
    }

    fn take_ready(&mut self) -> Vec<i16> {
        let n = self.mic.pending.len().min(self.sys.pending.len());
        if n == 0 {
            return Vec::new();
        }
        let mixed = self.mic.pending[..n]
            .iter()
            .zip(&self.sys.pending[..n])
            .map(|(&m, &s)| ((m as i32 + s as i32) * MIX_GAIN).clamp(-32768, 32767) as i16)
            .collect();
        self.mic.pending.drain(..n);
        self.sys.pending.drain(..n);
        mixed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHUNK_MS: u64 = 20;
    const CHUNK: usize = (CHUNK_MS * SAMPLES_PER_MS) as usize;
    /// Output alignment budget: 20 ms.
    const TOL: i64 = 20 * SAMPLES_PER_MS as i64;

    const MIC_MARK: i16 = 1000;
    const SYS_MARK: i16 = 2000;

    /// The sample a side produces at wall-clock sample `idx`: silence, except a
    /// marker at each `marks` position. Because a chunk carries the markers of
    /// the wall time it was captured at, a marker's position in the output
    /// shows how far that side drifted from the wall clock.
    fn chunk(marks: &[usize], mark: i16, from: usize) -> Vec<i16> {
        (from..from + CHUNK)
            .map(|i| if marks.contains(&i) { mark } else { 0 })
            .collect()
    }

    /// Run `total_ms` of 20 ms chunks per side through the mixer. A side is
    /// skipped while `gap(side, t_ms)` is true (its capture delivered nothing).
    fn simulate(
        total_ms: u64,
        mic_marks: &[usize],
        sys_marks: &[usize],
        gap: impl Fn(MixSide, u64) -> bool,
    ) -> (Vec<i16>, usize) {
        let mut mixer = RecordingMixer::new();
        let mut out = Vec::new();
        let mut max_buffered = 0;
        let mut t = 0;
        while t < total_ms {
            let from = (t * SAMPLES_PER_MS) as usize;
            let now = t + CHUNK_MS; // a chunk is delivered when it ends
            for (side, marks, mark) in [
                (MixSide::Mic, mic_marks, MIC_MARK),
                (MixSide::System, sys_marks, SYS_MARK),
            ] {
                if gap(side, t) {
                    continue;
                }
                out.extend(mixer.push(side, &chunk(marks, mark, from), now));
                max_buffered = max_buffered.max(mixer.buffered_samples());
            }
            // A side with nothing to deliver still lets time pass.
            out.extend(mixer.tick(now));
            t += CHUNK_MS;
        }
        out.extend(mixer.finish());
        (out, max_buffered)
    }

    /// Output positions of the mic and system markers placed at `idx`.
    fn marker_positions(out: &[i16], idx: usize) -> (usize, usize) {
        let mic = (MIC_MARK as i32 * MIX_GAIN) as i16;
        let sys = (SYS_MARK as i32 * MIX_GAIN) as i16;
        let both = ((MIC_MARK as i32 + SYS_MARK as i32) * MIX_GAIN) as i16;
        let near = |v: i16| {
            out.iter()
                .enumerate()
                .filter(|(i, &x)| x == v && (*i as i64 - idx as i64).abs() < 2000 * 16)
                .map(|(i, _)| i)
                .collect::<Vec<_>>()
        };
        if let Some(&p) = near(both).first() {
            return (p, p);
        }
        let m = *near(mic).first().expect("mic marker missing in output");
        let s = *near(sys).first().expect("system marker missing in output");
        (m, s)
    }

    fn assert_aligned(out: &[i16], idx: usize) {
        let (m, s) = marker_positions(out, idx);
        assert!((m as i64 - s as i64).abs() <= TOL, "sides apart: mic {m} sys {s}");
        assert!((m as i64 - idx as i64).abs() <= TOL, "mic {m} not at wall {idx}");
        assert!((s as i64 - idx as i64).abs() <= TOL, "sys {s} not at wall {idx}");
    }

    fn sample_at_ms(ms: u64) -> usize {
        (ms * SAMPLES_PER_MS) as usize
    }

    #[test]
    fn continuous_sides_mix_sample_for_sample() {
        let marks = [sample_at_ms(500), sample_at_ms(3000)];
        let (out, _) = simulate(4000, &marks, &marks, |_, _| false);
        assert_eq!(out.len(), sample_at_ms(4000));
        for (i, &v) in out.iter().enumerate() {
            let expect = if marks.contains(&i) {
                ((MIC_MARK as i32 + SYS_MARK as i32) * MIX_GAIN) as i16
            } else {
                0
            };
            assert_eq!(v, expect, "sample {i}");
        }
    }

    #[test]
    fn mic_gap_keeps_sides_aligned_afterwards() {
        let after = [sample_at_ms(6000)];
        // Mic delivers nothing for 1.3 s.
        let (out, max) = simulate(8000, &after, &after, |s, t| {
            s == MixSide::Mic && (2000..3300).contains(&t)
        });
        assert_aligned(&out, after[0]);
        assert!((out.len() as i64 - sample_at_ms(8000) as i64).abs() <= TOL);
        assert!(max < sample_at_ms(400), "buffered too much: {max}");
    }

    #[test]
    fn system_gap_keeps_sides_aligned_afterwards() {
        let after = [sample_at_ms(6000)];
        // Loopback sends nothing for 3 s of silence.
        let (out, max) = simulate(8000, &after, &after, |s, t| {
            s == MixSide::System && (1000..4000).contains(&t)
        });
        assert_aligned(&out, after[0]);
        assert!((out.len() as i64 - sample_at_ms(8000) as i64).abs() <= TOL);
        assert!(max < sample_at_ms(400), "buffered too much: {max}");
    }

    #[test]
    fn gap_on_each_side_in_turn() {
        let after = [sample_at_ms(9000)];
        let (out, _) = simulate(10000, &after, &after, |s, t| match s {
            MixSide::Mic => (1500..2700).contains(&t),
            MixSide::System => (4000..5100).contains(&t),
        });
        assert_aligned(&out, after[0]);
        assert!((out.len() as i64 - sample_at_ms(10000) as i64).abs() <= TOL);
    }

    #[test]
    fn audio_just_after_a_gap_lands_at_its_wall_time() {
        // Markers right after the gap ends, not far past it.
        let mic = [sample_at_ms(3300)];
        let sys = [sample_at_ms(3300)];
        let (out, _) = simulate(5000, &mic, &sys, |s, t| {
            s == MixSide::Mic && (2000..3300).contains(&t)
        });
        assert_aligned(&out, mic[0]);
    }

    #[test]
    fn one_side_never_present_does_not_buffer_without_bound() {
        let mut mixer = RecordingMixer::new();
        let mut written = 0usize;
        let mut max = 0;
        for t in (0..60_000).step_by(CHUNK_MS as usize) {
            let now = t + CHUNK_MS;
            written += mixer.push(MixSide::Mic, &vec![1; CHUNK], now).len();
            max = max.max(mixer.buffered_samples());
        }
        assert!(max < sample_at_ms(400), "buffered too much: {max}");
        // Output keeps up with the wall clock (within the stall allowance).
        assert!(written + sample_at_ms(400) >= sample_at_ms(60_000));
    }

    #[test]
    fn arrival_jitter_does_not_insert_silence() {
        let mut mixer = RecordingMixer::new();
        let mut written = 0;
        for i in 0..200u64 {
            // Every fifth chunk is 25 ms late; the rest are on time.
            let now = (i + 1) * CHUNK_MS + if i % 5 == 0 { 25 } else { 0 };
            written += mixer.push(MixSide::Mic, &vec![5; CHUNK], now).len();
            written += mixer.push(MixSide::System, &vec![5; CHUNK], now).len();
        }
        written += mixer.finish().len();
        assert_eq!(written, 200 * CHUNK);
    }

    #[test]
    fn finish_completes_the_shorter_side_with_silence() {
        let mut mixer = RecordingMixer::new();
        mixer.push(MixSide::Mic, &vec![100; CHUNK], 20);
        let out = mixer.finish();
        assert_eq!(out.len(), CHUNK);
        assert!(out.iter().all(|&v| v == 400));
    }
}
