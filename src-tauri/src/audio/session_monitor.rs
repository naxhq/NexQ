// Audio Session Monitor — enumerates active Windows audio sessions (per-app awareness).
//
// Uses Windows Audio Session API (WASAPI) to list which applications are
// currently producing audio and on which device. This is informational only —
// it helps users identify the right loopback device for the "Them" party.

use crate::audio::AudioSessionInfo;

/// Enumerate all active audio sessions across output devices.
///
/// Returns a list of AudioSessionInfo structs with PID, process name,
/// display name, device name, and activity state.
pub fn enumerate_audio_sessions() -> Result<Vec<AudioSessionInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        enumerate_sessions_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec![])
    }
}

#[cfg(target_os = "windows")]
fn enumerate_sessions_windows() -> Result<Vec<AudioSessionInfo>, String> {
    let mut sessions = Vec::new();

    // Build a PID → process name map using Windows API
    let pid_map = build_pid_process_map();

    // Try to enumerate sessions via WASAPI COM API
    match enumerate_wasapi_sessions(&pid_map) {
        Ok(wasapi_sessions) => {
            sessions.extend(wasapi_sessions);
        }
        Err(e) => {
            log::warn!("WASAPI session enumeration failed: {}. Returning empty list.", e);
        }
    }

    Ok(sessions)
}

#[cfg(target_os = "windows")]
fn build_pid_process_map() -> std::collections::HashMap<u32, String> {
    // Simple approach: we'll fill the map as we discover PIDs during session enumeration
    // For now, return an empty map — PIDs will be resolved inline
    std::collections::HashMap::new()
}

#[cfg(target_os = "windows")]
fn enumerate_wasapi_sessions(
    _pid_map: &std::collections::HashMap<u32, String>,
) -> Result<Vec<AudioSessionInfo>, String> {
    // Run COM operations on a dedicated thread
    let result = std::thread::Builder::new()
        .name("session-monitor".to_string())
        .spawn(move || -> Result<Vec<AudioSessionInfo>, String> {
            unsafe {
                use windows::Win32::System::Com::{
                    CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED,
                };

                let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
                if hr.is_err() {
                    return Err(format!("CoInitializeEx failed: {:?}", hr));
                }

                struct ComGuard;
                impl Drop for ComGuard {
                    fn drop(&mut self) {
                        unsafe { CoUninitialize() };
                    }
                }
                let _guard = ComGuard;

                use windows::Win32::Media::Audio::{
                    IMMDeviceEnumerator, MMDeviceEnumerator, eRender,
                    IAudioSessionManager2, IAudioSessionEnumerator,
                    IAudioSessionControl, IAudioSessionControl2,
                    AudioSessionStateActive,
                    AudioSessionStateExpired,
                };
                use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
                use windows::core::Interface;

                // Create device enumerator
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                        .map_err(|e| format!("Failed to create device enumerator: {}", e))?;

                // Enumerate output (render) devices
                let devices = enumerator
                    .EnumAudioEndpoints(eRender, windows::Win32::Media::Audio::DEVICE_STATE(0x00000001)) // DEVICE_STATE_ACTIVE
                    .map_err(|e| format!("EnumAudioEndpoints failed: {}", e))?;

                let device_count = devices.GetCount()
                    .map_err(|e| format!("GetCount failed: {}", e))?;

                let mut all_sessions = Vec::new();

                for i in 0..device_count {
                    let device = match devices.Item(i) {
                        Ok(d) => d,
                        Err(_) => continue,
                    };

                    // Get device friendly name
                    let device_name = get_device_name(&device).unwrap_or_else(|| format!("Device {}", i));

                    // Activate IAudioSessionManager2
                    let mgr: IAudioSessionManager2 = match device.Activate(CLSCTX_ALL, None) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };

                    // Get session enumerator
                    let session_enum: IAudioSessionEnumerator = match mgr.GetSessionEnumerator() {
                        Ok(e) => e,
                        Err(_) => continue,
                    };

                    let session_count = match session_enum.GetCount() {
                        Ok(c) => c,
                        Err(_) => continue,
                    };

                    for j in 0..session_count {
                        let control: IAudioSessionControl = match session_enum.GetSession(j) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };

                        // Get extended control for PID
                        let control2: IAudioSessionControl2 = match control.cast() {
                            Ok(c) => c,
                            Err(_) => continue,
                        };

                        let pid = control2.GetProcessId().unwrap_or(0);
                        if pid == 0 {
                            continue; // System sounds — skip
                        }

                        let state = control.GetState().unwrap_or(AudioSessionStateExpired);
                        let is_active = state == AudioSessionStateActive;

                        // Get display name (may be empty)
                        let display_name = control.GetDisplayName()
                            .map(|s| s.to_string().unwrap_or_default())
                            .unwrap_or_default();

                        // Resolve process name from PID
                        let process_name = get_process_name(pid).unwrap_or_else(|| format!("PID {}", pid));

                        let final_display = if display_name.is_empty() {
                            process_name.clone()
                        } else {
                            display_name
                        };

                        all_sessions.push(AudioSessionInfo {
                            pid,
                            process_name,
                            display_name: final_display,
                            device_name: device_name.clone(),
                            is_active,
                        });
                    }
                }

                Ok(all_sessions)
            }
        })
        .map_err(|e| format!("Failed to spawn session monitor thread: {}", e))?
        .join()
        .map_err(|_| "Session monitor thread panicked".to_string())?;

    result
}

/// Get the friendly name of an IMMDevice via its property store.
#[cfg(target_os = "windows")]
fn get_device_name(device: &windows::Win32::Media::Audio::IMMDevice) -> Option<String> {
    unsafe {
        use windows::Win32::Foundation::PROPERTYKEY;
        use windows::core::GUID;

        // PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
        let pkey = PROPERTYKEY {
            fmtid: GUID::from_values(
                0xa45c254e,
                0xdf1c,
                0x4efd,
                [0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0],
            ),
            pid: 14,
        };

        // STGM_READ = 0x00000000
        let store = device.OpenPropertyStore(windows::Win32::System::Com::STGM(0)).ok()?;
        let prop = store.GetValue(&pkey).ok()?;

        // Use Display trait on PROPVARIANT to extract string value
        let s = format!("{}", prop);
        if s.is_empty() || s == "VT_EMPTY" {
            return None;
        }
        Some(s)
    }
}

/// Executable file name of a process (e.g. "Zoom.exe"), if it can be opened.
#[cfg(target_os = "windows")]
pub(crate) fn process_exe_name(pid: u32) -> Option<String> {
    get_process_name(pid)
}

/// Get process name from PID.
#[cfg(target_os = "windows")]
fn get_process_name(pid: u32) -> Option<String> {
    unsafe {
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW,
            PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::Foundation::CloseHandle;

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        let mut buf = [0u16; 260];
        let mut size = buf.len() as u32;
        let success = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        );

        let _ = CloseHandle(handle);

        if success.is_ok() {
            let path = String::from_utf16_lossy(&buf[..size as usize]);
            // Extract just the filename
            path.rsplit('\\').next().map(|s| s.to_string())
        } else {
            None
        }
    }
}
