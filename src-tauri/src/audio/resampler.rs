// Sub-PRD 3: Sample rate conversion -> 16kHz mono PCM

/// Converts one audio stream, chunk after chunk, to mono at `to_rate`.
///
/// It keeps its place between chunks, so over time the output has exactly
/// `to_rate / from_rate` samples per input frame, whatever the chunk sizes.
/// Converting each chunk on its own rounds every chunk up (512 frames of
/// 48 kHz give 171 samples instead of 170.67), so each device's stream runs
/// fast by its own amount. That pulls the mic and the speaker audio apart by
/// almost half a millisecond per second, too much for echo cancellation.
///
/// Downsampling low-passes first (8th-order Butterworth just below the new
/// Nyquist frequency), so sound above it doesn't fold back into speech.
pub struct StreamResampler {
    channels: usize,
    same_rate: bool,
    /// Input frames per output sample.
    step: f64,
    /// Where the next output sample falls: 0.0 is `previous`, the last frame
    /// of the chunk before; the next chunk's first frame is at 1.0.
    position: f64,
    previous: f64,
    low_pass: Vec<Biquad>,
}

/// Q of the four biquads of an 8th-order Butterworth low-pass.
const BUTTERWORTH_8_Q: [f64; 4] = [0.5098, 0.6013, 0.9000, 2.5629];

impl StreamResampler {
    pub fn new(from_rate: u32, to_rate: u32, channels: u16) -> Self {
        let low_pass = if to_rate < from_rate {
            let cutoff = to_rate as f64 * 0.45;
            BUTTERWORTH_8_Q
                .iter()
                .map(|&q| Biquad::low_pass(from_rate as f64, cutoff, q))
                .collect()
        } else {
            Vec::new()
        };
        Self {
            channels: channels.max(1) as usize,
            same_rate: from_rate == to_rate,
            step: from_rate as f64 / to_rate.max(1) as f64,
            position: 1.0,
            previous: 0.0,
            low_pass,
        }
    }

    /// Converts the next chunk (interleaved when there are several channels).
    pub fn process(&mut self, input: &[i16]) -> Vec<i16> {
        let frames = input.len() / self.channels;
        if frames == 0 {
            return Vec::new();
        }
        let mono: Vec<f64> = input
            .chunks_exact(self.channels)
            .map(|frame| {
                let mut x = frame.iter().map(|&s| s as f64).sum::<f64>() / self.channels as f64;
                for biquad in &mut self.low_pass {
                    x = biquad.process(x);
                }
                x
            })
            .collect();
        if self.same_rate {
            return mono.into_iter().map(to_i16).collect();
        }

        let mut output = Vec::with_capacity((frames as f64 / self.step) as usize + 2);
        let end = frames as f64;
        while self.position < end {
            let index = self.position as usize;
            let fraction = self.position - index as f64;
            let a = if index == 0 {
                self.previous
            } else {
                mono[index - 1]
            };
            let b = mono[index];
            output.push(to_i16(a + (b - a) * fraction));
            self.position += self.step;
        }
        self.position -= end;
        self.previous = mono[frames - 1];
        output
    }
}

fn to_i16(sample: f64) -> i16 {
    sample.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

/// A second-order low-pass section (RBJ cookbook), transposed direct form II.
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn low_pass(sample_rate: f64, cutoff: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * cutoff / sample_rate;
        let alpha = w0.sin() / (2.0 * q);
        let cos = w0.cos();
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 - cos) / 2.0 / a0,
            b1: (1.0 - cos) / a0,
            b2: (1.0 - cos) / 2.0 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Converts one self-contained buffer to mono at `to_rate`. For a live
/// stream use one `StreamResampler` across all its chunks instead.
pub fn resample(input: &[i16], from_rate: u32, to_rate: u32, channels: u16) -> Vec<i16> {
    StreamResampler::new(from_rate, to_rate, channels).process(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, rate: u32, seconds: f64, channels: u16) -> Vec<i16> {
        let frames = (rate as f64 * seconds) as usize;
        (0..frames)
            .flat_map(|n| {
                let s =
                    (2.0 * std::f64::consts::PI * freq * n as f64 / rate as f64).sin() * 10_000.0;
                std::iter::repeat(s as i16).take(channels as usize)
            })
            .collect()
    }

    fn rms(samples: &[i16]) -> f64 {
        (samples.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }

    #[test]
    fn test_identity_resample() {
        let input = vec![100, 200, 300, 400, 500];
        let output = resample(&input, 16000, 16000, 1);
        assert_eq!(input, output);
    }

    #[test]
    fn test_downsample_48k_to_16k() {
        // 48kHz -> 16kHz is a 3:1 ratio
        let input: Vec<i16> = (0..480).map(|i| (i * 10) as i16).collect();
        let output = resample(&input, 48000, 16000, 1);
        assert_eq!(output.len(), 160);
    }

    #[test]
    fn test_stereo_to_mono() {
        // Stereo: L=100, R=200, L=300, R=400
        let input = vec![100i16, 200, 300, 400];
        assert_eq!(resample(&input, 16000, 16000, 2), vec![150, 350]);
    }

    #[test]
    fn test_empty_input() {
        let output = resample(&[], 48000, 16000, 1);
        assert!(output.is_empty());
    }

    /// The macOS output tap's 512-frame chunks and the built-in mic's
    /// ~953-frame chunks both come out at exactly 16 kHz.
    #[test]
    fn a_stream_in_odd_chunks_keeps_the_exact_rate() {
        let mut tap = StreamResampler::new(48_000, 16_000, 2);
        let out: usize = (0..9375).map(|_| tap.process(&[0; 1024]).len()).sum();
        assert_eq!(out, 1_600_000, "100 s of 48 kHz stereo in 512-frame chunks");

        let mut mic = StreamResampler::new(96_000, 16_000, 1);
        let (mut frames, mut out) = (0, 0);
        for j in 0.. {
            let n = if j % 7 < 4 { 953 } else { 952 };
            if frames + n > 9_600_000 {
                break;
            }
            frames += n;
            out += mic.process(&vec![0; n]).len();
        }
        assert!(
            (out as i64 - frames as i64 / 6).abs() <= 1,
            "{out} for {frames} frames"
        );
    }

    #[test]
    fn chunked_conversion_matches_converting_it_whole() {
        let input = tone(440.0, 48_000, 1.0, 1);
        let whole = resample(&input, 48_000, 16_000, 1);
        let mut stream = StreamResampler::new(48_000, 16_000, 1);
        let mut chunked = Vec::new();
        let mut start = 0;
        for size in [512, 333, 1000, 7, 2048].iter().cycle() {
            if start >= input.len() {
                break;
            }
            let end = (start + size).min(input.len());
            chunked.extend(stream.process(&input[start..end]));
            start = end;
        }
        assert_eq!(chunked, whole);
    }

    #[test]
    fn speech_band_passes_and_what_would_alias_is_filtered() {
        let speech = resample(&tone(1000.0, 48_000, 1.0, 1), 48_000, 16_000, 1);
        let kept = 20.0 * (rms(&speech[4000..]) / (10_000.0 / 2f64.sqrt())).log10();
        assert!(kept.abs() < 0.5, "1 kHz changed by {kept:.2} dB");

        // 12 kHz would fold back to 4 kHz at 16 kHz.
        let high = resample(&tone(12_000.0, 48_000, 1.0, 1), 48_000, 16_000, 1);
        let left = 20.0 * (rms(&high[4000..]) / (10_000.0 / 2f64.sqrt())).log10();
        assert!(left < -30.0, "12 kHz only down {:.1} dB", -left);
    }
}
