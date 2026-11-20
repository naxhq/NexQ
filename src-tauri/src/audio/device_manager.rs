// Sub-PRD 3: Audio device enumeration and monitoring

use cpal::traits::{DeviceTrait, HostTrait};

use super::{AudioDevice, AudioDeviceList};

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
