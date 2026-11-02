//! IPolicyConfig-based default device override for Windows.
//!
//! When Web Speech API or Windows Speech Recognition is selected with a non-default
//! audio device, we temporarily set the Windows default recording endpoint to the
//! user's selected device. Both engines always capture from the OS default mic, so
//! this is the only way to redirect them.
//!
//! IPolicyConfig is an undocumented but widely-used COM interface (stable since Vista).
//! Used by EarTrumpet, SoundSwitch, and many other audio utilities.
//!
//! The original default is saved in AppState and restored on meeting end or app exit.

/// Get the current default capture endpoint ID (Windows MMDevice ID).
/// Returns a string like `{0.0.1.00000000}.{guid}`.
///
/// Caller must ensure COM is initialized on the current thread.
#[cfg(target_os = "windows")]
pub fn get_default_capture_endpoint_id() -> Result<String, String> {
    use std::ffi::c_void;
    use windows::Win32::Media::Audio::{eCapture, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("Device enumerator creation failed: {}", e))?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eCapture, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint(eCapture) failed: {}", e))?;

        let id_pwstr = device
            .GetId()
            .map_err(|e| format!("GetId failed: {}", e))?;

        let id_str = id_pwstr
            .to_string()
            .map_err(|e| format!("PWSTR to string failed: {}", e))?;

        // Free the CoTaskMem-allocated PWSTR
        windows::Win32::System::Com::CoTaskMemFree(Some(id_pwstr.0 as *const c_void));

        Ok(id_str)
    }
}

/// Find the Windows endpoint ID for a capture device matching the given cpal name.
/// cpal uses PKEY_Device_FriendlyName as device names, which this also reads.
///
/// Caller must ensure COM is initialized on the current thread.
#[cfg(target_os = "windows")]
pub fn find_capture_endpoint_id_by_name(cpal_name: &str) -> Result<String, String> {
    use std::ffi::c_void;
    use windows::Win32::Media::Audio::{
        eCapture, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("Device enumerator failed: {}", e))?;

        let collection = enumerator
            .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("EnumAudioEndpoints failed: {}", e))?;

        let count = collection
            .GetCount()
            .map_err(|e| format!("GetCount failed: {}", e))?;

        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };

            // Get friendly name using same property as cpal
            let name = get_device_friendly_name_internal(&device);

            if name.as_deref() == Some(cpal_name) {
                let id_pwstr = device
                    .GetId()
                    .map_err(|e| format!("GetId failed: {}", e))?;
                let id_str = id_pwstr
                    .to_string()
                    .map_err(|e| format!("PWSTR conversion: {}", e))?;
                windows::Win32::System::Com::CoTaskMemFree(Some(id_pwstr.0 as *const c_void));
                return Ok(id_str);
            }
        }

        Err(format!(
            "Capture device '{}' not found in MMDevice enumeration",
            cpal_name
        ))
    }
}

/// Set the Windows default capture endpoint using IPolicyConfig.
///
/// `endpoint_id` must be a Windows MMDevice endpoint ID (not a cpal name).
/// Sets the default for all three roles: eConsole, eMultimedia, eCommunications.
///
/// Caller must ensure COM is initialized on the current thread.
#[cfg(target_os = "windows")]
pub fn set_default_capture_endpoint(endpoint_id: &str) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::core::{IUnknown, Interface, GUID, HRESULT, PCWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    // IPolicyConfig COM interface constants (undocumented, stable since Vista)
    const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID {
        data1: 0x870AF99C,
        data2: 0x171D,
        data3: 0x4F9E,
        data4: [0xAF, 0x0D, 0xE6, 0x3D, 0xF4, 0x0C, 0x2B, 0xC9],
    };
    const IID_IPOLICY_CONFIG: GUID = GUID {
        data1: 0xF8679F50,
        data2: 0x850A,
        data3: 0x41CF,
        data4: [0x9C, 0x72, 0x43, 0x0F, 0x29, 0x02, 0x90, 0xC8],
    };

    // SetDefaultEndpoint is at vtable index 13 in IPolicyConfig:
    //   IUnknown: 0=QueryInterface, 1=AddRef, 2=Release
    //   IPolicyConfig: 3=GetMixFormat, 4=GetDeviceFormat, 5=ResetDeviceFormat,
    //     6=SetDeviceFormat, 7=GetProcessingPeriod, 8=SetProcessingPeriod,
    //     9=GetShareMode, 10=SetShareMode, 11=GetPropertyValue,
    //     12=SetPropertyValue, 13=SetDefaultEndpoint, 14=SetEndpointVisibility
    const VTABLE_SET_DEFAULT_ENDPOINT: usize = 13;

    type SetDefaultEndpointFn =
        unsafe extern "system" fn(this: *mut c_void, device_id: PCWSTR, role: u32) -> HRESULT;
    type QueryInterfaceFn = unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> HRESULT;
    type ReleaseFn = unsafe extern "system" fn(this: *mut c_void) -> u32;

    unsafe {
        // Create PolicyConfig COM object — request IUnknown first
        let unk: IUnknown = CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL)
            .map_err(|e| format!("PolicyConfig COM creation failed: {}", e))?;

        let raw = unk.as_raw();
        let vtable = *(raw as *const *const *const c_void);

        // QueryInterface for IPolicyConfig to get the right vtable
        let qi: QueryInterfaceFn = std::mem::transmute(*vtable);
        let mut ipc_ptr: *mut c_void = std::ptr::null_mut();
        let hr = qi(raw, &IID_IPOLICY_CONFIG, &mut ipc_ptr);
        if hr.is_err() {
            return Err(format!(
                "QueryInterface for IPolicyConfig failed: 0x{:08X}",
                hr.0
            ));
        }

        // Get SetDefaultEndpoint from IPolicyConfig vtable
        let ipc_vtable = *(ipc_ptr as *const *const *const c_void);
        let set_default: SetDefaultEndpointFn =
            std::mem::transmute(*ipc_vtable.add(VTABLE_SET_DEFAULT_ENDPOINT));

        let wide: Vec<u16> = endpoint_id
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // Set for all three roles: eConsole(0), eMultimedia(1), eCommunications(2)
        let role_names = ["eConsole", "eMultimedia", "eCommunications"];
        let mut last_error = None;
        for (idx, role) in [0u32, 1, 2].iter().enumerate() {
            let hr = set_default(ipc_ptr, PCWSTR(wide.as_ptr()), *role);
            if hr.is_err() {
                log::error!(
                    "IPolicyConfig::SetDefaultEndpoint({}) HRESULT=0x{:08X}",
                    role_names[idx], hr.0
                );
                last_error = Some(format!(
                    "SetDefaultEndpoint failed for {} (role {}): 0x{:08X}",
                    role_names[idx], role, hr.0
                ));
            } else {
                log::debug!(
                    "IPolicyConfig::SetDefaultEndpoint({}) OK (0x{:08X})",
                    role_names[idx], hr.0
                );
            }
        }

        // Release IPolicyConfig reference
        let release: ReleaseFn = std::mem::transmute(*ipc_vtable.add(2));
        release(ipc_ptr);

        if let Some(err) = last_error {
            return Err(err);
        }

        log::info!(
            "IPolicyConfig: Set default capture endpoint to '{}'",
            endpoint_id
        );
        Ok(())
    }
}

/// High-level helper: override the system default capture device to match a cpal device name.
/// Returns the original endpoint ID so it can be restored later.
///
/// Handles COM initialization internally (safe to call from any thread).
#[cfg(target_os = "windows")]
/// Returns `Ok(Some(original_endpoint_id))` when an override was applied,
/// or `Ok(None)` when the target was already the default (no change made).
pub fn override_default_capture_device(cpal_device_name: &str) -> Result<Option<String>, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        let we_initialized = hr.0 == 0; // S_OK only — don't CoUninitialize if S_FALSE
        // RPC_E_CHANGED_MODE (0x80010106): COM already initialized with a different
        // threading model (e.g. APARTMENTTHREADED). COM is still usable — just don't
        // uninitialize it. S_FALSE (0x01): already initialized same mode — also usable.
        if hr.is_err() && hr.0 as u32 != 0x80010106 {
            return Err(format!("CoInitializeEx failed: 0x{:08X}", hr.0));
        }

        let result = (|| -> Result<Option<String>, String> {
            // Save current default
            let original = get_default_capture_endpoint_id()?;
            log::info!(
                "IPolicyConfig: Current default capture = '{}'",
                original
            );

            // Find the endpoint ID for the user's selected device
            let target = find_capture_endpoint_id_by_name(cpal_device_name)?;
            log::info!(
                "IPolicyConfig: Target device '{}' → endpoint '{}'",
                cpal_device_name,
                target
            );

            if target == original {
                log::info!("IPolicyConfig: Target is already the default — no override needed");
                return Ok(None);
            }

            // Set the new default
            set_default_capture_endpoint(&target)?;

            Ok(Some(original))
        })();

        if we_initialized {
            CoUninitialize();
        }
        result
    }
}

/// Restore the original default capture device.
///
/// Handles COM initialization internally (safe to call from any thread).
#[cfg(target_os = "windows")]
pub fn restore_default_capture_device(original_endpoint_id: &str) -> Result<(), String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        let we_initialized = hr.0 == 0; // S_OK only
        // RPC_E_CHANGED_MODE: COM already initialized with different threading model — still usable
        if hr.is_err() && hr.0 as u32 != 0x80010106 {
            return Err(format!("CoInitializeEx failed: 0x{:08X}", hr.0));
        }

        let result = set_default_capture_endpoint(original_endpoint_id);

        if result.is_ok() {
            log::info!(
                "IPolicyConfig: Restored default capture to '{}'",
                original_endpoint_id
            );
        }

        if we_initialized {
            CoUninitialize();
        }
        result
    }
}

/// Extract the friendly name from a Windows audio endpoint device,
/// matching the format that cpal uses for device names (PKEY_Device_FriendlyName).
#[cfg(target_os = "windows")]
fn get_device_friendly_name_internal(
    device: &windows::Win32::Media::Audio::IMMDevice,
) -> Option<String> {
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::core::GUID;

    unsafe {
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
        let store = device
            .OpenPropertyStore(windows::Win32::System::Com::STGM(0))
            .ok()?;
        let prop = store.GetValue(&pkey).ok()?;
        let s = format!("{}", prop);
        if s.is_empty() || s == "VT_EMPTY" {
            return None;
        }
        Some(s)
    }
}

// Provide no-op stubs on non-Windows platforms so the module compiles everywhere.
#[cfg(not(target_os = "windows"))]
pub fn get_default_capture_endpoint_id() -> Result<String, String> {
    Err("IPolicyConfig is only available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn override_default_capture_device(_cpal_device_name: &str) -> Result<Option<String>, String> {
    Err("IPolicyConfig is only available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn restore_default_capture_device(_original_endpoint_id: &str) -> Result<(), String> {
    Err("IPolicyConfig is only available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn find_capture_endpoint_id_by_name(_cpal_name: &str) -> Result<String, String> {
    Err("IPolicyConfig is only available on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn set_default_capture_endpoint(_endpoint_id: &str) -> Result<(), String> {
    Err("IPolicyConfig is only available on Windows".to_string())
}
