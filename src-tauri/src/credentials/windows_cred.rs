/// Windows Credential Manager via windows-rs crate.
/// Key naming convention: `NexQ:{provider}`
use std::slice;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

/// Format the credential target name.
fn target_name(provider: &str) -> String {
    format!("NexQ:{}", provider)
}

/// Convert a Rust string to a null-terminated wide (UTF-16) string.
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Write a credential to the Windows Credential Manager.
pub fn credential_write(provider: &str, key: &str) -> Result<(), String> {
    let target = target_name(provider);
    let target_wide = to_wide(&target);
    let key_bytes = key.as_bytes();

    let mut cred = CREDENTIALW {
        Flags: CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target_wide.as_ptr() as *mut u16),
        Comment: PWSTR::null(),
        CredentialBlobSize: key_bytes.len() as u32,
        CredentialBlob: key_bytes.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };

    unsafe {
        CredWriteW(&mut cred, 0).map_err(|e| {
            format!(
                "Failed to write credential for {}: {}",
                provider,
                e.message()
            )
        })?;
    }

    Ok(())
}

/// Read a credential from the Windows Credential Manager.
/// Returns None if the credential does not exist.
pub fn credential_read(provider: &str) -> Result<Option<String>, String> {
    let target = target_name(provider);
    let target_wide = to_wide(&target);

    let mut pcred: *mut CREDENTIALW = std::ptr::null_mut();

    unsafe {
        let result = CredReadW(
            PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut pcred,
        );

        match result {
            Ok(()) => {
                let cred = &*pcred;
                let blob_size = cred.CredentialBlobSize as usize;
                let blob_ptr = cred.CredentialBlob;

                let key = if blob_size > 0 && !blob_ptr.is_null() {
                    let blob_slice = slice::from_raw_parts(blob_ptr, blob_size);
                    String::from_utf8(blob_slice.to_vec())
                        .map_err(|e| format!("Invalid UTF-8 in credential: {}", e))?
                } else {
                    String::new()
                };

                CredFree(pcred as *const std::ffi::c_void);
                Ok(Some(key))
            }
            Err(e) => {
                if e.code() == ERROR_NOT_FOUND.into() {
                    Ok(None)
                } else {
                    Err(format!(
                        "Failed to read credential for {}: {}",
                        provider,
                        e.message()
                    ))
                }
            }
        }
    }
}

/// Delete a credential from the Windows Credential Manager.
pub fn credential_delete(provider: &str) -> Result<(), String> {
    let target = target_name(provider);
    let target_wide = to_wide(&target);

    unsafe {
        let result = CredDeleteW(
            PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
        );

        match result {
            Ok(()) => Ok(()),
            Err(e) => {
                if e.code() == ERROR_NOT_FOUND.into() {
                    // Deleting a non-existent credential is not an error
                    Ok(())
                } else {
                    Err(format!(
                        "Failed to delete credential for {}: {}",
                        provider,
                        e.message()
                    ))
                }
            }
        }
    }
}
