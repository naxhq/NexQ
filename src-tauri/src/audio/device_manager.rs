// Sub-PRD 3: Audio device enumeration and monitoring

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{FromSample, Sample};

use super::{AudioDevice, AudioDeviceList};

/// Log a stream error. cpal 0.18.2 reports buffer under/overruns through the
/// error callback; they are recoverable glitches, not failures.
pub fn log_stream_error(label: &str, err: &cpal::Error) {
    if err.kind() == cpal::ErrorKind::Xrun {
        log::debug!("{}: {}", label, err);
    } else {
        log::error!("{}: {}", label, err);
    }
}

/// Convert samples of any cpal sample type (i32, I24, ...) to i16. cpal 0.18
/// ranks the high-precision formats above F32/I16 for some devices' default
/// config, so the capture callbacks accept them and narrow them here.
pub fn samples_to_i16<T: Sample>(data: &[T]) -> Vec<i16>
where
    i16: FromSample<T>,
{
    data.iter().map(|&s| s.to_sample::<i16>()).collect()
}

/// Display name of a cpal device (the friendly name on Windows). Device IDs
/// saved in settings are these names, so keep them stable across cpal upgrades.
pub fn device_name(device: &cpal::Device) -> Result<String, cpal::Error> {
    device.description().map(|d| d.name().to_string())
}

/// Enumerate all available audio input and output devices.
/// Returns an AudioDeviceList with input devices (microphones) and
/// output devices (speakers/headphones, relevant for system audio loopback).
pub fn enumerate_devices() -> Result<AudioDeviceList, String> {
    let host = cpal::default_host();

    // Get default devices for marking
    let default_input_name = host
        .default_input_device()
        .and_then(|d| device_name(&d).ok());

    let default_output_name = host
        .default_output_device()
        .and_then(|d| device_name(&d).ok());

    // Enumerate input devices
    let mut inputs = Vec::new();
    match host.input_devices() {
        Ok(devices) => {
            for device in devices {
                let name = match device_name(&device) {
                    Ok(n) => n,
                    Err(e) => {
                        log::warn!("Failed to get input device name: {}", e);
                        continue;
                    }
                };

                let is_default = default_input_name
                    .as_ref()
                    .map(|d| d == &name)
                    .unwrap_or(false);

                inputs.push(AudioDevice {
                    id: name.clone(),
                    name: name.clone(),
                    is_input: true,
                    is_default,
                });
            }
        }
        Err(e) => {
            log::warn!("Failed to enumerate input devices: {}", e);
        }
    }

    // Enumerate output devices
    let mut outputs = Vec::new();
    match host.output_devices() {
        Ok(devices) => {
            for device in devices {
                let name = match device_name(&device) {
                    Ok(n) => n,
                    Err(e) => {
                        log::warn!("Failed to get output device name: {}", e);
                        continue;
                    }
                };

                let is_default = default_output_name
                    .as_ref()
                    .map(|d| d == &name)
                    .unwrap_or(false);

                outputs.push(AudioDevice {
                    id: name.clone(),
                    name: name.clone(),
                    is_input: false,
                    is_default,
                });
            }
        }
        Err(e) => {
            log::warn!("Failed to enumerate output devices: {}", e);
        }
    }

    log::info!(
        "Enumerated {} input and {} output devices",
        inputs.len(),
        outputs.len()
    );

    Ok(AudioDeviceList { inputs, outputs })
}

/// Find a cpal input device by its name/ID.
/// If device_id is "default" or empty, returns the default input device.
pub fn find_input_device(device_id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();

    if device_id.is_empty() || device_id == "default" {
        return host
            .default_input_device()
            .ok_or_else(|| "No default input device available".to_string());
    }

    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {}", e))?;

    for device in devices {
        if let Ok(name) = device_name(&device) {
            if name == device_id {
                return Ok(device);
            }
        }
    }

    Err(format!("Input device '{}' not found", device_id))
}

/// Find a cpal output device by its name/ID.
/// If device_id is "default" or empty, returns the default output device.
pub fn find_output_device(device_id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();

    if device_id.is_empty() || device_id == "default" {
        return host
            .default_output_device()
            .ok_or_else(|| "No default output device available".to_string());
    }

    let devices = host
        .output_devices()
        .map_err(|e| format!("Failed to enumerate output devices: {}", e))?;

    for device in devices {
        if let Ok(name) = device_name(&device) {
            if name == device_id {
                return Ok(device);
            }
        }
    }

    Err(format!("Output device '{}' not found", device_id))
}

/// Test whether an audio device can be opened successfully.
/// Returns Ok(true) if the device works, Ok(false) or Err if not.
pub fn test_device(device_id: &str) -> Result<bool, String> {
    // Try as input device first
    if let Ok(device) = find_input_device(device_id) {
        match device.default_input_config() {
            Ok(config) => {
                log::info!("Input device '{}' supports config: {:?}", device_id, config);
                return Ok(true);
            }
            Err(e) => {
                log::warn!("Input device '{}' config error: {}", device_id, e);
            }
        }
    }

    // Then try as output device
    if let Ok(device) = find_output_device(device_id) {
        match device.default_output_config() {
            Ok(config) => {
                log::info!("Output device '{}' supports config: {:?}", device_id, config);
                return Ok(true);
            }
            Err(e) => {
                log::warn!("Output device '{}' config error: {}", device_id, e);
            }
        }
    }

    Ok(false)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i32_samples_keep_their_top_16_bits() {
        let out = samples_to_i16(&[i32::MIN, 0, 1 << 16, i32::MAX]);
        assert_eq!(out, vec![i16::MIN, 0, 1, i16::MAX]);
    }

    #[test]
    fn i24_samples_scale_to_the_i16_range() {
        let lo = cpal::I24::new(-(1 << 23)).unwrap();
        let hi = cpal::I24::new((1 << 23) - 1).unwrap();
        let mid = cpal::I24::new(1 << 8).unwrap();
        let out = samples_to_i16(&[lo, cpal::I24::new(0).unwrap(), mid, hi]);
        assert_eq!(out, vec![i16::MIN, 0, 1, i16::MAX]);
    }
}
