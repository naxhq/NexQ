//! Mixes the mic and system streams into the single recording track.
//!
//! Pairing samples by count only keeps the two sides aligned while both
//! deliver continuously. When one side stalls (device reconnecting, Windows
//! loopback sending nothing while nothing plays) its later samples would land
//! on the wrong time in the file, for the rest of the recording. This mixer
//! places each side on the capture clock instead: a side that falls behind is
//! filled with silence, so both stay aligned.
//!
//! Every chunk is placed by the time it was captured (the end of its buffer),
//! not by when the loop got to it, so a queue backlog is not mistaken for a
//! gap. Silence is only counted, never allocated, and output goes to a sink in
//! blocks of at most [`BLOCK_SAMPLES`], so even an hour-long outage costs a
//! bounded amount of memory.
//!
//! Pure and synchronous. The caller passes the time (milliseconds on any
//! clock shared by both sides) with every call, so tests run without real time.

use std::collections::VecDeque;

/// Recording format: 16 kHz mono.
const SAMPLES_PER_MS: u64 = 16;

/// Largest block handed to the sink: 1 s.
pub const BLOCK_SAMPLES: usize = 16_000;

/// A chunk that ends more than this behind the clock is preceded by silence
/// for the missing time. Smaller lags are scheduling jitter.
const GAP_FILL_MS: u64 = 30;
/// A side that has delivered nothing and trails the clock by more than this is
/// padded with silence without waiting for its next chunk, so the other
/// side's samples never wait long (and never pile up). Above the 80 ms echo
/// cancellation hold-back plus chunk and scheduling jitter, so a side that is
/// merely delayed is not mistaken for a stalled one.
const STALL_MS: u64 = 250;
/// How far behind the clock a stalled side is left after padding. Its next
/// chunk then still finds a gap and is placed exactly.
const STALL_KEEP_MS: u64 = 60;
/// Hard cap on how far one side may run ahead of the other.
const MAX_LEAD_MS: u64 = 2000;
/// Gain applied to the sum of both sides (kept from the original mixer).
const MIX_GAIN: i32 = 4;

/// Milliseconds since the Unix epoch: the clock the capture threads stamp
/// their chunks with, so the loops can tick the mixer on the same clock.
pub fn wall_clock_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MixSide {
    Mic,
    System,
}

enum Seg {
    Real { data: Vec<i16>, pos: usize },
    Silence(u64),
}

#[derive(Default)]
struct SideBuf {
    /// Samples (real and silence) not yet mixed out, oldest first.
    queue: VecDeque<Seg>,
    /// Samples in `queue`.
    queued: u64,
    /// Samples accepted so far, silence included: this side's position on the
    /// recording timeline.
    total: u64,
}

impl SideBuf {
    /// Silence is a count, not a buffer.
    fn pad(&mut self, samples: u64) {
        if samples == 0 {
            return;
        }
        match self.queue.back_mut() {
            Some(Seg::Silence(n)) => *n += samples,
            _ => self.queue.push_back(Seg::Silence(samples)),
        }
        self.queued += samples;
        self.total += samples;
    }

    fn add(&mut self, samples: &[i16]) {
        self.queue.push_back(Seg::Real {
            data: samples.to_vec(),
            pos: 0,
        });
        self.queued += samples.len() as u64;
        self.total += samples.len() as u64;
    }

    /// Adds the next `acc.len()` samples to `acc` and removes them.
    fn mix_into(&mut self, acc: &mut [i32]) {
        let mut off = 0;
        while off < acc.len() {
            let need = acc.len() - off;
            let Some(front) = self.queue.front_mut() else { break };
            let done = match front {
                Seg::Real { data, pos } => {
                    let take = need.min(data.len() - *pos);
                    for (a, &v) in acc[off..off + take].iter_mut().zip(&data[*pos..]) {
                        *a += v as i32;
                    }
                    *pos += take;
                    off += take;
                    *pos == data.len()
                }
                Seg::Silence(n) => {
                    let take = (need as u64).min(*n);
                    *n -= take;
                    off += take as usize;
                    *n == 0
                }
            };
            if done {
                self.queue.pop_front();
            }
        }
        self.queued -= off as u64;
    }
}

#[derive(Default)]
pub struct RecordingMixer {
    mic: SideBuf,
    sys: SideBuf,
    /// Clock time (ms) of sample 0 of the recording.
    start_ms: Option<u64>,
}

impl RecordingMixer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a chunk from `side` that was captured up to `end_ms` (the time its
    /// last sample was recorded). Whatever is now ready goes to `sink`.
    pub fn push(
        &mut self,
        side: MixSide,
        samples: &[i16],
        end_ms: u64,
        sink: &mut dyn FnMut(&[i16]),
    ) {
        if !samples.is_empty() {
            let len = samples.len() as u64;
            let start = *self
                .start_ms
                .get_or_insert_with(|| end_ms.saturating_sub(len / SAMPLES_PER_MS));
            let expected = end_ms.saturating_sub(start) * SAMPLES_PER_MS;
            let buf = self.side_mut(side);
            let end = buf.total + len;
            if expected > end + GAP_FILL_MS * SAMPLES_PER_MS {
                buf.pad(expected - end);
            }
            buf.add(samples);
        }
        self.tick(end_ms, sink);
    }

    /// Advance to `now_ms` without new samples: pads a side that has stalled
    /// and hands what is ready to `sink`. Call it regularly while no audio
    /// arrives, so silence is written as time passes. Only call it when no
    /// captured audio is still queued upstream.
    pub fn tick(&mut self, now_ms: u64, sink: &mut dyn FnMut(&[i16])) {
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
        self.take_ready(sink);
    }

    /// End of the recording: everything still buffered, the shorter side
    /// completed with silence.
    pub fn finish(&mut self, sink: &mut dyn FnMut(&[i16])) {
        self.take_ready(sink);
        let (m, s) = (self.mic.queued, self.sys.queued);
        if m != s {
            self.mic.pad(m.max(s) - m);
            self.sys.pad(m.max(s) - s);
            self.take_ready(sink);
        }
    }

    /// Most samples either side is holding back, silence included (for
    /// bounding tests).
    pub fn buffered_samples(&self) -> usize {
        self.mic.queued.max(self.sys.queued) as usize
    }

    fn side_mut(&mut self, side: MixSide) -> &mut SideBuf {
        match side {
            MixSide::Mic => &mut self.mic,
            MixSide::System => &mut self.sys,
        }
    }

    /// Mixes what both sides have, in blocks of at most `BLOCK_SAMPLES`.
    fn take_ready(&mut self, sink: &mut dyn FnMut(&[i16])) {
        let mut n = self.mic.queued.min(self.sys.queued);
        let mut acc = Vec::new();
        let mut out = Vec::new();
        while n > 0 {
            let block = (n as usize).min(BLOCK_SAMPLES);
            acc.clear();
            acc.resize(block, 0i32);
            self.mic.mix_into(&mut acc);
            self.sys.mix_into(&mut acc);
            out.clear();
            out.extend(
                acc.iter()
                    .map(|&v| (v * MIX_GAIN).clamp(-32768, 32767) as i16),
            );
            sink(&out);
            n -= block as u64;
        }
    }
}

/// Capture times of a stream that passes through a stage which holds samples
/// back (echo cancellation keeps ~80 ms and a partial frame). The stage
/// returns the same samples in the same order, only later, so each output
/// sample keeps the capture time of the input sample it came from. Tracking
/// that keeps a delayed side from looking late, and places samples released
/// after a gap at the time they were really captured.
#[derive(Default)]
pub struct CaptureTimes {
    /// Input chunks not yet fully released: samples left and capture time of
    /// the chunk's last sample, oldest first.
    queue: VecDeque<(usize, u64)>,
}

impl CaptureTimes {
    pub fn new() -> Self {
        Self::default()
    }

    /// A chunk of `len` samples entered the stage; captured up to `end_ms`.
    pub fn input(&mut self, len: usize, end_ms: u64) {
        if len > 0 {
            self.queue.push_back((len, end_ms));
        }
    }

    /// `len` samples left the stage. Returns them as `(count, end_ms)` pieces
    /// in order, `end_ms` being the capture time of each piece's last sample.
    pub fn output(&mut self, mut len: usize) -> Vec<(usize, u64)> {
        let mut pieces = Vec::new();
        while len > 0 {
            let Some((left, end_ms)) = self.queue.front_mut() else { break };
            let take = len.min(*left);
            *left -= take;
            len -= take;
            pieces.push((take, end_ms.saturating_sub(*left as u64 / SAMPLES_PER_MS)));
            if *left == 0 {
                self.queue.pop_front();
            }
        }
        pieces
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

    /// Echo cancellation's hold-back: 80 ms, whole 10 ms frames.
    const AEC_HOLD: usize = 8 * 160;
    const AEC_FRAME: usize = 160;

    /// Collects the mixer's output and the largest block it was handed.
    #[derive(Default)]
    struct Collect {
        out: Vec<i16>,
        max_block: usize,
    }

    impl Collect {
        fn sink(&mut self) -> impl FnMut(&[i16]) + '_ {
            |block: &[i16]| {
                self.max_block = self.max_block.max(block.len());
                self.out.extend_from_slice(block);
            }
        }
    }

    /// The sample a side produces at wall-clock sample `idx`: silence, except a
    /// marker at each `marks` position. Because a chunk carries the markers of
    /// the time it was captured at, a marker's position in the output shows
    /// how far that side drifted from the capture clock.
    fn chunk(marks: &[usize], mark: i16, from: usize) -> Vec<i16> {
        (from..from + CHUNK)
            .map(|i| if marks.contains(&i) { mark } else { 0 })
            .collect()
    }

    /// Stand-in for the echo canceller: the same samples, in the same order,
    /// but only those older than the 80 ms hold-back, in whole 10 ms frames.
    #[derive(Default)]
    struct FakeAec {
        held: Vec<i16>,
    }

    impl FakeAec {
        fn process(&mut self, samples: &[i16]) -> Vec<i16> {
            self.held.extend_from_slice(samples);
            let frames = self.held.len().saturating_sub(AEC_HOLD) / AEC_FRAME;
            self.held.drain(..frames * AEC_FRAME).collect()
        }
    }

    /// Run `total_ms` of 20 ms chunks per side through the mixer. A side is
    /// skipped while `gap(side, t_ms)` is true (its capture delivered nothing).
    /// With `mic_delay` the mic goes through a stage that holds audio back, the
    /// way echo cancellation does.
    fn simulate(
        total_ms: u64,
        mic_marks: &[usize],
        sys_marks: &[usize],
        mic_delay: bool,
        gap: impl Fn(MixSide, u64) -> bool,
    ) -> (Collect, usize) {
        let mut mixer = RecordingMixer::new();
        let mut got = Collect::default();
        let mut max_buffered = 0;
        let mut aec = FakeAec::default();
        let mut times = CaptureTimes::new();
        let mut t = 0;
        while t < total_ms {
            let from = (t * SAMPLES_PER_MS) as usize;
            let now = t + CHUNK_MS; // a chunk is captured when it ends
            for (side, marks, mark) in [
                (MixSide::Mic, mic_marks, MIC_MARK),
                (MixSide::System, sys_marks, SYS_MARK),
            ] {
                if gap(side, t) {
                    continue;
                }
                let pcm = chunk(marks, mark, from);
                if side == MixSide::Mic && mic_delay {
                    times.input(pcm.len(), now);
                    let released = aec.process(&pcm);
                    let mut off = 0;
                    for (n, end) in times.output(released.len()) {
                        mixer.push(side, &released[off..off + n], end, &mut got.sink());
                        off += n;
                    }
                } else {
                    mixer.push(side, &pcm, now, &mut got.sink());
                }
                max_buffered = max_buffered.max(mixer.buffered_samples());
            }
            // A side with nothing to deliver still lets time pass.
            mixer.tick(now, &mut got.sink());
            t += CHUNK_MS;
        }
        mixer.finish(&mut got.sink());
        (got, max_buffered)
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
        let (got, _) = simulate(4000, &marks, &marks, false, |_, _| false);
        assert_eq!(got.out.len(), sample_at_ms(4000));
        for (i, &v) in got.out.iter().enumerate() {
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
        let (got, max) = simulate(8000, &after, &after, false, |s, t| {
            s == MixSide::Mic && (2000..3300).contains(&t)
        });
        assert_aligned(&got.out, after[0]);
        assert!((got.out.len() as i64 - sample_at_ms(8000) as i64).abs() <= TOL);
        assert!(max < sample_at_ms(500), "buffered too much: {max}");
    }

    #[test]
    fn system_gap_keeps_sides_aligned_afterwards() {
        let after = [sample_at_ms(6000)];
        // Loopback sends nothing for 3 s of silence.
        let (got, max) = simulate(8000, &after, &after, false, |s, t| {
            s == MixSide::System && (1000..4000).contains(&t)
        });
        assert_aligned(&got.out, after[0]);
        assert!((got.out.len() as i64 - sample_at_ms(8000) as i64).abs() <= TOL);
        assert!(max < sample_at_ms(500), "buffered too much: {max}");
    }

    #[test]
    fn gap_on_each_side_in_turn() {
        let after = [sample_at_ms(9000)];
        let (got, _) = simulate(10000, &after, &after, false, |s, t| match s {
            MixSide::Mic => (1500..2700).contains(&t),
            MixSide::System => (4000..5100).contains(&t),
        });
        assert_aligned(&got.out, after[0]);
        assert!((got.out.len() as i64 - sample_at_ms(10000) as i64).abs() <= TOL);
    }

    #[test]
    fn audio_just_after_a_gap_lands_at_its_wall_time() {
        // Markers right after the gap ends, not far past it.
        let mic = [sample_at_ms(3300)];
        let sys = [sample_at_ms(3300)];
        let (got, _) = simulate(5000, &mic, &sys, false, |s, t| {
            s == MixSide::Mic && (2000..3300).contains(&t)
        });
        assert_aligned(&got.out, mic[0]);
    }

    #[test]
    fn one_side_never_present_does_not_buffer_without_bound() {
        let mut mixer = RecordingMixer::new();
        let mut got = Collect::default();
        let mut max = 0;
        for t in (0..60_000).step_by(CHUNK_MS as usize) {
            let now = t + CHUNK_MS;
            mixer.push(MixSide::Mic, &vec![1; CHUNK], now, &mut got.sink());
            max = max.max(mixer.buffered_samples());
        }
        assert!(max < sample_at_ms(500), "buffered too much: {max}");
        // Output keeps up with the clock (within the stall allowance).
        assert!(got.out.len() + sample_at_ms(500) >= sample_at_ms(60_000));
    }

    #[test]
    fn arrival_jitter_does_not_insert_silence() {
        let mut mixer = RecordingMixer::new();
        let mut got = Collect::default();
        for i in 0..200u64 {
            // Every fifth chunk is stamped 25 ms late; the rest are on time.
            let now = (i + 1) * CHUNK_MS + if i % 5 == 0 { 25 } else { 0 };
            mixer.push(MixSide::Mic, &vec![5; CHUNK], now, &mut got.sink());
            mixer.push(MixSide::System, &vec![5; CHUNK], now, &mut got.sink());
        }
        mixer.finish(&mut got.sink());
        assert_eq!(got.out.len(), 200 * CHUNK);
    }

    #[test]
    fn finish_completes_the_shorter_side_with_silence() {
        let mut mixer = RecordingMixer::new();
        let mut got = Collect::default();
        mixer.push(MixSide::Mic, &vec![100; CHUNK], 20, &mut got.sink());
        mixer.finish(&mut got.sink());
        assert_eq!(got.out.len(), CHUNK);
        assert!(got.out.iter().all(|&v| v == 400));
    }

    #[test]
    fn hour_long_outage_with_ticks_never_buffers_or_allocates_much() {
        let hour_ms = 3_600_000u64;
        let mut mixer = RecordingMixer::new();
        let mut got = Collect::default();
        let mut max = 0;
        // Two seconds of both sides, then nothing from either for an hour,
        // ticked every 100 ms like the capture loops do while idle.
        for t in (0..2000).step_by(CHUNK_MS as usize) {
            let now = t + CHUNK_MS;
            mixer.push(MixSide::Mic, &vec![1; CHUNK], now, &mut got.sink());
            mixer.push(MixSide::System, &vec![1; CHUNK], now, &mut got.sink());
        }
        for now in (2000..=hour_ms).step_by(100) {
            mixer.tick(now, &mut got.sink());
            max = max.max(mixer.buffered_samples());
        }
        // Both come back with a marker at the one-hour mark.
        let mut back = vec![0i16; CHUNK];
        back[0] = MIC_MARK;
        mixer.push(MixSide::Mic, &back, hour_ms + CHUNK_MS, &mut got.sink());
        back[0] = SYS_MARK;
        mixer.push(MixSide::System, &back, hour_ms + CHUNK_MS, &mut got.sink());
        mixer.finish(&mut got.sink());

        assert!(max < sample_at_ms(500), "buffered too much: {max}");
        assert!(got.max_block <= BLOCK_SAMPLES, "block of {}", got.max_block);
        assert!((got.out.len() as i64 - sample_at_ms(hour_ms + CHUNK_MS) as i64).abs() <= TOL);
        assert_aligned(&got.out, sample_at_ms(hour_ms));
    }

    #[test]
    fn hour_long_outage_without_ticks_still_writes_bounded_blocks() {
        let hour_ms = 3_600_000u64;
        let mut mixer = RecordingMixer::new();
        let mut got = Collect::default();
        for t in (0..2000).step_by(CHUNK_MS as usize) {
            let now = t + CHUNK_MS;
            mixer.push(MixSide::Mic, &vec![1; CHUNK], now, &mut got.sink());
            mixer.push(MixSide::System, &vec![1; CHUNK], now, &mut got.sink());
        }
        // Nobody ticked: the first sign of life is an hour later.
        let mut back = vec![0i16; CHUNK];
        back[0] = MIC_MARK;
        mixer.push(MixSide::Mic, &back, hour_ms + CHUNK_MS, &mut got.sink());
        back[0] = SYS_MARK;
        mixer.push(MixSide::System, &back, hour_ms + CHUNK_MS, &mut got.sink());
        mixer.finish(&mut got.sink());

        assert!(got.max_block <= BLOCK_SAMPLES, "block of {}", got.max_block);
        assert!((got.out.len() as i64 - sample_at_ms(hour_ms + CHUNK_MS) as i64).abs() <= TOL);
        assert_aligned(&got.out, sample_at_ms(hour_ms));
    }

    #[test]
    fn queued_audio_then_a_one_sided_gap_stays_aligned() {
        // The loop was stalled (STT starting up) while both sides kept
        // capturing, then drained the whole queue in one burst. Chunks carry
        // the time they were captured, so the burst is not a gap and the
        // one-sided gap after it is placed right.
        let after = [sample_at_ms(5500)];
        let mut mixer = RecordingMixer::new();
        let mut got = Collect::default();
        let push = |mixer: &mut RecordingMixer, got: &mut Collect, t: u64, with_sys: bool| {
            let from = (t * SAMPLES_PER_MS) as usize;
            let now = t + CHUNK_MS;
            mixer.push(MixSide::Mic, &chunk(&after, MIC_MARK, from), now, &mut got.sink());
            if with_sys {
                mixer.push(MixSide::System, &chunk(&after, SYS_MARK, from), now, &mut got.sink());
            }
        };
        // 3 s of both sides, all delivered at once (no ticks between).
        for t in (0..3000).step_by(CHUNK_MS as usize) {
            push(&mut mixer, &mut got, t, true);
        }
        let so_far = got.out.len();
        assert!(
            (so_far as i64 - sample_at_ms(3000) as i64).abs() <= TOL,
            "burst lost or gained audio: {so_far}"
        );
        // Then the system side goes quiet for 1.5 s.
        for t in (3000..8000).step_by(CHUNK_MS as usize) {
            push(&mut mixer, &mut got, t, !(3000..4500).contains(&t));
        }
        mixer.finish(&mut got.sink());
        assert_aligned(&got.out, after[0]);
        assert!((got.out.len() as i64 - sample_at_ms(8000) as i64).abs() <= TOL);
    }

    #[test]
    fn capture_times_follow_the_held_back_samples() {
        let mut times = CaptureTimes::new();
        // 20 ms captured up to t=1000; the stage hands back only 160 samples.
        times.input(320, 1000);
        assert_eq!(times.output(160), vec![(160, 990)]);
        // The next chunk arrives; the stage releases the rest and part of it.
        times.input(320, 1020);
        assert_eq!(times.output(160 + 160), vec![(160, 1000), (160, 1010)]);
        // Nothing pending: nothing to place.
        assert!(times.output(0).is_empty());
    }

    #[test]
    fn delayed_mic_shows_no_shift_and_no_inserted_silence() {
        // Mic audio held back like echo cancellation does (80 ms plus a
        // partial frame); capture is continuous.
        let marks = [sample_at_ms(500), sample_at_ms(2500), sample_at_ms(5000)];
        let (got, _) = simulate(6000, &marks, &marks, true, |_, _| false);
        let both = ((MIC_MARK as i32 + SYS_MARK as i32) * MIX_GAIN) as i16;
        // Everything the stage released (all but its hold-back) is in place.
        let checked = sample_at_ms(6000) - AEC_HOLD - AEC_FRAME;
        assert!(got.out.len() >= checked);
        for (i, &v) in got.out[..checked].iter().enumerate() {
            let expect = if marks.contains(&i) { both } else { 0 };
            assert_eq!(v, expect, "sample {i}");
        }
    }

    #[test]
    fn delayed_mic_with_a_gap_keeps_sides_aligned() {
        let after = [sample_at_ms(3400), sample_at_ms(6000)];
        let (got, max) = simulate(8000, &after, &after, true, |s, t| {
            s == MixSide::Mic && (2000..3300).contains(&t)
        });
        assert_aligned(&got.out, after[0]);
        assert_aligned(&got.out, after[1]);
        assert!(max < sample_at_ms(500), "buffered too much: {max}");
    }

    #[test]
    fn delayed_mic_released_all_at_once_when_cancellation_stops() {
        // Cancellation is switched off mid-meeting: the held-back samples come
        // out together with the current chunk, as one larger release.
        let mut mixer = RecordingMixer::new();
        let mut got = Collect::default();
        let mut aec = FakeAec::default();
        let mut times = CaptureTimes::new();
        let marker = sample_at_ms(1000);
        for t in (0..2000).step_by(CHUNK_MS as usize) {
            let from = (t * SAMPLES_PER_MS) as usize;
            let now = t + CHUNK_MS;
            let sys = chunk(&[marker], SYS_MARK, from);
            let mic = chunk(&[marker], MIC_MARK, from);
            mixer.push(MixSide::System, &sys, now, &mut got.sink());
            times.input(mic.len(), now);
            let released = if t == 1000 {
                // Off: held-back audio plus this chunk.
                let mut all = std::mem::take(&mut aec.held);
                all.extend_from_slice(&mic);
                all
            } else if t > 1000 {
                mic.clone()
            } else {
                aec.process(&mic)
            };
            let mut off = 0;
            for (n, end) in times.output(released.len()) {
                mixer.push(MixSide::Mic, &released[off..off + n], end, &mut got.sink());
                off += n;
            }
        }
        mixer.finish(&mut got.sink());
        assert_aligned(&got.out, marker);
        assert!((got.out.len() as i64 - sample_at_ms(2000) as i64).abs() <= TOL);
    }
}
