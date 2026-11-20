// Helpers shared by the cpal capture paths (mic, dual mic, system loopback).

use cpal::traits::DeviceTrait;
use cpal::{FromSample, Sample, SampleFormat, SizedSample};

/// Log a stream error. cpal 0.18.2 reports buffer under/overruns through the
/// error callback; they are recoverable glitches, not failures.
pub fn log_stream_error(label: &str, err: &cpal::Error) {
    if err.kind() == cpal::ErrorKind::Xrun {
        log::debug!("{}: {:?}: {}", label, err.kind(), err);
    } else {
        log::error!("{}: {:?}: {}", label, err.kind(), err);
    }
}

/// Convert samples of any cpal sample type (i8, i32, I24, f64, ...) to i16.
pub fn samples_to_i16<T: Sample>(data: &[T]) -> Vec<i16>
where
    i16: FromSample<T>,
{
    data.iter().map(|&s| s.to_sample::<i16>()).collect()
}

/// Build an input stream whose samples of type `T` reach `on_pcm` as i16.
pub fn build_converted<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut on_pcm: impl FnMut(&[i16]) + Send + 'static,
    err_fn: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    i16: FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| on_pcm(&samples_to_i16(data)),
        err_fn,
        None,
    )
}

/// `build_converted` for a runtime `format`: every format except the
/// F32/I16/U16 ones the capture paths handle themselves. F32 still ranks
/// first among cpal's choices and on WASAPI/CoreAudio the default config is
/// the device's mix/current format, so these are rare; they are here so an
/// unusual device or driver still opens instead of failing.
pub fn build_converted_for(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    format: SampleFormat,
    on_pcm: impl FnMut(&[i16]) + Send + 'static,
    err_fn: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, cpal::Error> {
    match format {
        SampleFormat::I8 => build_converted::<i8>(device, config, on_pcm, err_fn),
        SampleFormat::U8 => build_converted::<u8>(device, config, on_pcm, err_fn),
        SampleFormat::I24 => build_converted::<cpal::I24>(device, config, on_pcm, err_fn),
        SampleFormat::I32 => build_converted::<i32>(device, config, on_pcm, err_fn),
        SampleFormat::I64 => build_converted::<i64>(device, config, on_pcm, err_fn),
        SampleFormat::U32 => build_converted::<u32>(device, config, on_pcm, err_fn),
        SampleFormat::U64 => build_converted::<u64>(device, config, on_pcm, err_fn),
        SampleFormat::F64 => build_converted::<f64>(device, config, on_pcm, err_fn),
        other => Err(cpal::Error::with_message(
            cpal::ErrorKind::UnsupportedConfig,
            format!("Unsupported sample format: {:?}", other),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i8_and_u8_span_the_i16_range() {
        assert_eq!(samples_to_i16(&[i8::MIN, 0, i8::MAX]), vec![i16::MIN, 0, 32512]);
        assert_eq!(samples_to_i16(&[u8::MIN, 128, u8::MAX]), vec![i16::MIN, 0, 32512]);
    }

    #[test]
    fn i24_spans_the_i16_range() {
        let s = |v: i32| cpal::I24::new(v).unwrap();
        let out = samples_to_i16(&[s(-(1 << 23)), s(0), s(1 << 8), s((1 << 23) - 1)]);
        assert_eq!(out, vec![i16::MIN, 0, 1, i16::MAX]);
    }

    #[test]
    fn i32_and_u32_span_the_i16_range() {
        let out = samples_to_i16(&[i32::MIN, 0, 1 << 16, i32::MAX]);
        assert_eq!(out, vec![i16::MIN, 0, 1, i16::MAX]);
        assert_eq!(samples_to_i16(&[u32::MIN, 1 << 31, u32::MAX]), vec![i16::MIN, 0, i16::MAX]);
    }

    #[test]
    fn i64_and_u64_span_the_i16_range() {
        assert_eq!(samples_to_i16(&[i64::MIN, 0, i64::MAX]), vec![i16::MIN, 0, i16::MAX]);
        assert_eq!(samples_to_i16(&[u64::MIN, 1 << 63, u64::MAX]), vec![i16::MIN, 0, i16::MAX]);
    }

    #[test]
    fn f64_spans_the_i16_range_and_clips() {
        assert_eq!(samples_to_i16(&[-1.0f64, 0.0, 1.0]), vec![i16::MIN, 0, i16::MAX]);
        assert_eq!(samples_to_i16(&[-2.0f64, 2.0]), vec![i16::MIN, i16::MAX]);
    }
}
