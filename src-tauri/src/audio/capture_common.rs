// Helpers shared by the cpal capture paths (mic, dual mic, system loopback).

use cpal::traits::DeviceTrait;
use cpal::{ErrorKind, FromSample, Sample, SampleFormat, SizedSample};

/// What a capture side does about an error from its stream's error callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamErrorAction {
    /// A buffer under/overrun: a recoverable glitch. Counted, logged at debug.
    CountXrun,
    /// The stream keeps running (it followed a new default device, or it
    /// didn't get real-time priority). Logged, nothing else.
    Warn,
    /// The stream is gone or no longer valid: rebuild that side. On WASAPI
    /// any read error has already ended the stream.
    Rebuild,
}

/// Classify every cpal 0.18.2 `ErrorKind`. Kinds added later rebuild: a
/// stream that reports something unknown can't be trusted to keep delivering.
pub fn classify_stream_error(kind: ErrorKind) -> StreamErrorAction {
    match kind {
        ErrorKind::Xrun => StreamErrorAction::CountXrun,
        ErrorKind::DeviceChanged | ErrorKind::RealtimeDenied => StreamErrorAction::Warn,
        ErrorKind::StreamInvalidated
        | ErrorKind::DeviceNotAvailable
        | ErrorKind::DeviceBusy
        | ErrorKind::HostUnavailable
        | ErrorKind::InvalidInput
        | ErrorKind::PermissionDenied
        | ErrorKind::ResourceExhausted
        | ErrorKind::UnsupportedConfig
        | ErrorKind::UnsupportedOperation
        | ErrorKind::BackendError
        | ErrorKind::Other => StreamErrorAction::Rebuild,
        _ => StreamErrorAction::Rebuild,
    }
}

/// Log a stream error at the level its classification calls for, for streams
/// nothing supervises (the device test in Settings).
pub fn log_stream_error(label: &str, err: &cpal::Error) {
    match classify_stream_error(err.kind()) {
        StreamErrorAction::CountXrun => log::debug!("{}: {:?}: {}", label, err.kind(), err),
        StreamErrorAction::Warn => log::warn!("{}: {:?}: {}", label, err.kind(), err),
        StreamErrorAction::Rebuild => log::error!("{}: {:?}: {}", label, err.kind(), err),
    }
}

/// Convert samples of any cpal sample type (i8, i32, I24, f64, ...) to i16.
pub fn samples_to_i16<T: Sample>(data: &[T]) -> Vec<i16>
where
    i16: FromSample<T>,
{
    data.iter().map(|&s| s.to_sample::<i16>()).collect()
}

/// f32 [-1.0, 1.0] to i16, clipped: the conversion capture has always used.
pub fn f32_to_i16(data: &[f32]) -> Vec<i16> {
    data.iter().map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).collect()
}

/// u16 [0, 65535] to i16 [-32768, 32767].
pub fn u16_to_i16(data: &[u16]) -> Vec<i16> {
    data.iter().map(|&s| (s as i32 - 32768) as i16).collect()
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

/// `build_converted` for a runtime `format`: every PCM format; DSD is
/// rejected. `build_pcm_input_stream` keeps its own F32/I16/U16 conversion
/// and sends the other formats here. F32 still ranks first among cpal's
/// choices and on WASAPI/CoreAudio the default config is the device's
/// mix/current format, so they are rare; they are here so an unusual device
/// or driver still opens instead of failing.
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
        SampleFormat::I16 => build_converted::<i16>(device, config, on_pcm, err_fn),
        SampleFormat::U16 => build_converted::<u16>(device, config, on_pcm, err_fn),
        SampleFormat::I24 => build_converted::<cpal::I24>(device, config, on_pcm, err_fn),
        SampleFormat::U24 => build_converted::<cpal::U24>(device, config, on_pcm, err_fn),
        SampleFormat::I32 => build_converted::<i32>(device, config, on_pcm, err_fn),
        SampleFormat::U32 => build_converted::<u32>(device, config, on_pcm, err_fn),
        SampleFormat::I64 => build_converted::<i64>(device, config, on_pcm, err_fn),
        SampleFormat::U64 => build_converted::<u64>(device, config, on_pcm, err_fn),
        SampleFormat::F32 => build_converted::<f32>(device, config, on_pcm, err_fn),
        SampleFormat::F64 => build_converted::<f64>(device, config, on_pcm, err_fn),
        other => Err(cpal::Error::with_message(
            ErrorKind::UnsupportedConfig,
            format!("Unsupported sample format: {:?}", other),
        )),
    }
}

/// Build an input stream for any PCM `format` whose samples reach `on_pcm` as
/// i16. F32, I16 and U16 keep the conversion capture has always used (F32
/// scaled by i16::MAX and clipped, I16 as is, U16 re-centred); every other
/// PCM format goes through `build_converted_for`; DSD is rejected.
pub fn build_pcm_input_stream(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    format: SampleFormat,
    mut on_pcm: impl FnMut(&[i16]) + Send + 'static,
    err_fn: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, cpal::Error> {
    match format {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| on_pcm(&f32_to_i16(data)),
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| on_pcm(data),
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| on_pcm(&u16_to_i16(data)),
            err_fn,
            None,
        ),
        other => build_converted_for(device, config, other, on_pcm, err_fn),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_kind_has_its_action() {
        use StreamErrorAction::*;
        let table = [
            (ErrorKind::Xrun, CountXrun),
            (ErrorKind::DeviceChanged, Warn),
            (ErrorKind::RealtimeDenied, Warn),
            (ErrorKind::StreamInvalidated, Rebuild),
            (ErrorKind::DeviceNotAvailable, Rebuild),
            (ErrorKind::DeviceBusy, Rebuild),
            (ErrorKind::HostUnavailable, Rebuild),
            (ErrorKind::InvalidInput, Rebuild),
            (ErrorKind::PermissionDenied, Rebuild),
            (ErrorKind::ResourceExhausted, Rebuild),
            (ErrorKind::UnsupportedConfig, Rebuild),
            (ErrorKind::UnsupportedOperation, Rebuild),
            (ErrorKind::BackendError, Rebuild),
            (ErrorKind::Other, Rebuild),
        ];
        for (kind, action) in table {
            assert_eq!(classify_stream_error(kind), action, "{kind:?}");
        }
    }

    #[test]
    fn f32_and_u16_keep_their_conversion() {
        assert_eq!(
            f32_to_i16(&[-2.0, -1.0, 0.0, 0.5, 1.0, 2.0]),
            vec![-32767, -32767, 0, 16383, 32767, 32767]
        );
        assert_eq!(u16_to_i16(&[0, 32768, 65535]), vec![i16::MIN, 0, i16::MAX]);
        assert_eq!(samples_to_i16(&[0u16, 32768, 65535]), u16_to_i16(&[0, 32768, 65535]));
    }

    #[test]
    fn u24_spans_the_i16_range() {
        let s = |v: i32| cpal::U24::new(v).unwrap();
        let out = samples_to_i16(&[s(0), s(1 << 23), s((1 << 24) - 1)]);
        assert_eq!(out, vec![i16::MIN, 0, i16::MAX]);
    }

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
