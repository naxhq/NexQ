//! What the OS reports: processes with an active microphone session and the
//! visible top-level windows. Windows only for now; other platforms report
//! nothing (detection stays idle).

use super::rules::WindowInfo;

/// Lowercase executable names of processes capturing from any microphone
/// right now (active WASAPI capture sessions), excluding NexQ itself.
/// The calling thread must have COM initialized.
#[cfg(target_os = "windows")]
pub fn capturing_processes() -> Vec<String> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eCapture, AudioSessionStateActive, IAudioSessionControl, IAudioSessionControl2, IAudioSessionEnumerator,
        IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    // Per (detector) thread: one session manager per microphone, refreshed
    // every REFRESH_EVERY passes to pick up plugged/unplugged devices.
    // Activating them is most of a pass's cost, so they are kept between passes.
    const REFRESH_EVERY: u32 = 20;
    thread_local! {
        static MANAGERS: std::cell::RefCell<(u32, Vec<IAudioSessionManager2>)> =
            const { std::cell::RefCell::new((0, Vec::new())) };
    }
    fn session_managers() -> Vec<IAudioSessionManager2> {
        let mut managers = Vec::new();
        unsafe {
            let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else {
                return managers;
            };
            // DEVICE_STATE_ACTIVE
            let Ok(devices) = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE(0x1)) else {
                return managers;
            };
            for i in 0..devices.GetCount().unwrap_or(0) {
                if let Ok(mgr) = devices.Item(i).and_then(|d| d.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)) {
                    managers.push(mgr);
                }
            }
        }
        managers
    }
    thread_local! {
        // pid -> lowercase exe name (cleared on refresh, so reused pids heal).
        static EXE_NAMES: std::cell::RefCell<std::collections::HashMap<u32, Option<String>>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
    }
    fn cached_exe_name(pid: u32) -> Option<String> {
        EXE_NAMES.with(|names| {
            names
                .borrow_mut()
                .entry(pid)
                .or_insert_with(|| crate::audio::session_monitor::process_exe_name(pid).map(|e| e.to_lowercase()))
                .clone()
        })
    }
    let managers = MANAGERS.with(|cell| {
        let mut cell = cell.borrow_mut();
        if cell.0 % REFRESH_EVERY == 0 || cell.1.is_empty() {
            cell.1 = session_managers();
            EXE_NAMES.with(|names| names.borrow_mut().clear());
        }
        cell.0 = cell.0.wrapping_add(1);
        cell.1.clone()
    });

    let own_pid = std::process::id();
    let mut exes = Vec::new();
    unsafe {
        for mgr in &managers {
            let Ok(sessions) = mgr.GetSessionEnumerator() else { continue };
            let sessions: IAudioSessionEnumerator = sessions;
            for j in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(control) = sessions.GetSession(j) else { continue };
                let control: IAudioSessionControl = control;
                if control.GetState().ok() != Some(AudioSessionStateActive) {
                    continue;
                }
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                let pid = control2.GetProcessId().unwrap_or(0);
                if pid == 0 || pid == own_pid {
                    continue;
                }
                if let Some(exe) = cached_exe_name(pid) {
                    if !exes.contains(&exe) {
                        exes.push(exe);
                    }
                }
            }
        }
    }
    exes
}

/// Visible top-level windows with a title.
#[cfg(target_os = "windows")]
pub fn visible_windows() -> Vec<WindowInfo> {
    use std::collections::HashMap;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let handles = &mut *(lparam.0 as *mut Vec<HWND>);
        handles.push(hwnd);
        BOOL(1)
    }

    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<HWND> as isize));
    }

    let mut exe_by_pid: HashMap<u32, Option<String>> = HashMap::new();
    let mut out = Vec::new();
    for hwnd in handles {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
                continue;
            }
            let mut buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
            let mut cls = [0u16; 128];
            let cls_len = GetClassNameW(hwnd, &mut cls);
            let class = String::from_utf16_lossy(&cls[..cls_len.max(0) as usize]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let exe = exe_by_pid
                .entry(pid)
                .or_insert_with(|| crate::audio::session_monitor::process_exe_name(pid).map(|e| e.to_lowercase()))
                .clone();
            if let Some(exe) = exe {
                out.push(WindowInfo { exe, title, class });
            }
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
pub fn capturing_processes() -> Vec<String> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
pub fn visible_windows() -> Vec<WindowInfo> {
    Vec::new()
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    /// Live probe of this machine: `cargo test --lib live_probe -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_probe() {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
        println!("capturing: {:?}", super::capturing_processes());
        let n = 50;
        let t = std::time::Instant::now();
        for _ in 0..n { let _ = super::capturing_processes(); }
        let cap = t.elapsed() / n;
        let t = std::time::Instant::now();
        for _ in 0..n { let _ = super::visible_windows(); }
        let win = t.elapsed() / n;
        println!("per pass: mic sessions {:?}, windows {:?}", cap, win);
        for w in super::visible_windows().iter().take(40) {
            println!("{:<22} {:<28} {}", w.exe, w.class, w.title);
        }
    }
}
