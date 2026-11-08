use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{command, AppHandle, Manager, Runtime, Window};

use crate::state::AppState;

/// Stealth mode ("Hide from screen share"): every NexQ window stays visible on
/// the user's own display but is left out of screen sharing, recordings and
/// screenshots.
///
/// - Windows: `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`
///   (Windows 10 version 2004 and later).
/// - macOS: `NSWindow.sharingType = NSWindowSharingNone`. Apps that capture
///   through ScreenCaptureKit on macOS 14+ may still see the window.
static STEALTH: AtomicBool = AtomicBool::new(false);

/// Whether stealth mode is on (read when windows are created and menus built).
pub fn stealth_enabled() -> bool {
    STEALTH.load(Ordering::SeqCst)
}

/// Which windows lose their Windows taskbar button while stealth is on. The
/// meeting-prompt window already uses `.skip_taskbar(true)` at build time,
/// and the dev-log window is a developer-only surface, so neither is listed
/// here.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_taskbar_managed_label(label: &str) -> bool {
    matches!(label, "overlay" | "launcher")
}

/// What to do with a NexQ window's taskbar button.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum TabAction {
    Remove,
    Restore,
    Leave,
}

/// Decide a window's taskbar button from the stealth setting.
///
/// Only visible windows change. Windows decides a hidden window's button
/// when the window is shown, and the show hook asks again then; putting a
/// button back on a hidden window would leave a taskbar button for a window
/// nobody can see. A button comes back only if stealth removed it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn taskbar_action(stealth: bool, visible: bool, removed_by_stealth: bool) -> TabAction {
    if !visible {
        TabAction::Leave
    } else if stealth {
        TabAction::Remove
    } else if removed_by_stealth {
        TabAction::Restore
    } else {
        TabAction::Leave
    }
}

/// What this platform offers, for the Settings note.
#[derive(Debug, Clone, Serialize)]
pub struct StealthSupport {
    pub supported: bool,
    /// Caveat to show next to the toggle, if any.
    pub note: Option<String>,
}

fn support() -> StealthSupport {
    if cfg!(target_os = "windows") {
        StealthSupport {
            supported: true,
            note: Some("Requires Windows 10 version 2004 or later.".to_string()),
        }
    } else if cfg!(target_os = "macos") {
        StealthSupport {
            supported: true,
            note: Some(
                "Some recorders on macOS 14 and later (ScreenCaptureKit) can still capture windows."
                    .to_string(),
            ),
        }
    } else {
        StealthSupport {
            supported: false,
            note: Some("Not available on this platform.".to_string()),
        }
    }
}

#[command]
pub fn get_stealth_support() -> StealthSupport {
    support()
}

/// Serializes stealth transitions (and new windows picking up the setting).
static TRANSITION: Mutex<()> = Mutex::new(());

/// Turn stealth mode on or off for every NexQ window (and for windows opened
/// later, see [`apply_to_new_window`]). All or nothing: if a window refuses,
/// the windows already changed are put back and the setting stays as it was.
/// Rebuilds the tray menu so its check mark follows.
#[command]
pub async fn set_stealth_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled && !support().supported {
        return Err("Hiding from screen share isn't available on this platform".to_string());
    }
    let result = {
        let _guard = TRANSITION.lock().unwrap_or_else(|e| e.into_inner());
        let windows: Vec<(String, Window)> = app
            .webview_windows()
            .into_iter()
            .map(|(label, w)| (label, w.as_ref().window()))
            .collect();
        for (_, window) in &windows {
            track_visibility(window);
        }
        let result = transition(&windows, stealth_enabled(), enabled, apply_setting);
        if result.is_ok() {
            STEALTH.store(enabled, Ordering::SeqCst);
            log::info!(
                "Stealth mode {}",
                if enabled { "on: windows hidden from screen capture" } else { "off" }
            );

            // Overlay + launcher: their Windows taskbar buttons follow
            // stealth. A failure only warns: the screen-share hiding above
            // is the main contract.
            for (_, window) in &windows {
                sync_taskbar(window);
            }
            sync_macos(&app);
        }
        result
    };

    let meeting_active = app.state::<AppState>().meeting_active.load(Ordering::SeqCst);
    if let Err(e) = crate::commands::tray_commands::rebuild_tray_menu(app.clone(), meeting_active).await {
        log::warn!("Failed to refresh the tray menu after a stealth change: {e}");
    }
    result
}

/// Apply `enabled` to every window; on the first failure, restore `previous`
/// on the windows already changed. The error says whether that worked.
fn transition<W>(
    windows: &[(String, W)],
    previous: bool,
    enabled: bool,
    apply: impl Fn(&W, bool) -> Result<(), String>,
) -> Result<(), String> {
    for (i, (label, window)) in windows.iter().enumerate() {
        if let Err(e) = apply(window, enabled) {
            let not_restored: Vec<&str> = windows[..i]
                .iter()
                .filter(|(_, w)| apply(w, previous).is_err())
                .map(|(l, _)| l.as_str())
                .collect();
            let state = if previous { "hidden from" } else { "visible in" };
            return Err(if not_restored.is_empty() {
                format!("Couldn't change screen-share visibility ({label}: {e}); NexQ is still {state} screen share")
            } else {
                format!(
                    "Couldn't change screen-share visibility ({label}: {e}), and these windows couldn't be put back: {}. Toggle it again or restart NexQ",
                    not_restored.join(", ")
                )
            });
        }
    }
    Ok(())
}

/// Apply the current stealth setting to a window that was just created
/// (e.g. the dev log window), so it is never captured before it is hidden.
pub fn apply_to_new_window<R: Runtime>(window: &Window<R>) {
    let _guard = TRANSITION.lock().unwrap_or_else(|e| e.into_inner());
    track_visibility(window);
    if stealth_enabled() {
        if let Err(e) = apply_setting(window, true) {
            log::warn!("Stealth mode: couldn't hide window '{}': {e}", window.label());
        }
        // A window that's already on screen when its page loads (the
        // launcher at startup) gets no show event: sync its button now.
        sync_taskbar(window);
    }
}

/// Line the overlay's and launcher's taskbar buttons up with stealth mode.
/// Windows only: macOS has no per-window Dock entry.
#[cfg(target_os = "windows")]
fn sync_taskbar<R: Runtime>(window: &Window<R>) {
    if !is_taskbar_managed_label(window.label()) {
        return;
    }
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    // ITaskbarList is COM: call it on the main thread, where COM is set up.
    if let Err(e) = window.run_on_main_thread(move || visibility_hook::sync_taskbar_button(hwnd)) {
        log::warn!("Stealth mode: couldn't reach the main thread: {e}");
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_taskbar<R: Runtime>(_window: &Window<R>) {}

/// Set a window's capture visibility for the stealth setting `on`.
///
/// Windows: a hidden window is left as it is. Changing the display affinity of
/// a hidden WebView2 window makes Windows draw it again, and its frame stays on
/// the desktop with a white client area (the dashboard while the meeting
/// window is up) or the overlay's blur. [`track_visibility`] applies the
/// setting just before the window is shown again.
fn apply_setting<R: Runtime>(window: &Window<R>, on: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if !window.is_visible().unwrap_or(true) {
        return Ok(());
    }
    set_capture_excluded(window, on)
}

/// Give a window the stealth setting as it is shown.
#[cfg(target_os = "windows")]
fn track_visibility<R: Runtime>(window: &Window<R>) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    // The overlay's resize edges keep the arrow cursor under stealth, like
    // the rest of the overlay (useStealthCursor covers the page).
    let arrow_edges = window.label() == "overlay";
    let taskbar = is_taskbar_managed_label(window.label());
    let target = window.clone();
    // A subclass must be installed from the thread that owns the window.
    let installed = window.run_on_main_thread(move || {
        if let Err(e) = visibility_hook::install(hwnd) {
            log::warn!("Stealth mode: can't follow visibility of '{}': {e}", target.label());
        }
        if arrow_edges {
            visibility_hook::keep_arrow_at_edges(hwnd);
        }
        if taskbar {
            visibility_hook::manage_taskbar(hwnd);
        }
    });
    if let Err(e) = installed {
        log::warn!("Stealth mode: couldn't reach the main thread: {e}");
    }
}

#[cfg(not(target_os = "windows"))]
fn track_visibility<R: Runtime>(_window: &Window<R>) {}

/// macOS counterpart of the Windows taskbar and edge-cursor handling. While
/// stealth is on:
/// - NexQ leaves the Dock. macOS ties the Dock icon to Cmd+Tab and the menu
///   bar, so those go too; the menu-bar icon and the shortcuts still work.
/// - The overlay's native resizing is off, so macOS doesn't show its resize
///   cursors at the edges; the overlay's own invisible edge handles resize
///   it instead (`OverlayResizeHandles.tsx`).
#[cfg(target_os = "macos")]
fn sync_macos(app: &AppHandle) {
    let on = stealth_enabled();
    if let Err(e) = app.set_dock_visibility(!on) {
        log::warn!("Stealth mode: couldn't change the Dock icon: {e}");
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        if let Err(e) = overlay.set_resizable(!on) {
            log::warn!("Stealth mode: couldn't change overlay resizing: {e}");
        }
    }
    // tao skips a Dock hide that comes within 1 s of a Dock show (it works
    // around a macOS bug that leaves duplicate Dock icons), so turning
    // stealth off and quickly on again would leave the icon up. Hide it again
    // once that second has passed.
    if on {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1100));
            if stealth_enabled() {
                let _ = app.set_dock_visibility(false);
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
fn sync_macos(_app: &AppHandle) {}

/// macOS: let the overlay float over full-screen apps. A meeting in full
/// screen gets its own Space, which other apps' windows don't join by
/// default, so the overlay vanished there. Not tied to stealth. Windows needs
/// nothing: always-on-top already covers full-screen apps.
#[cfg(target_os = "macos")]
pub fn float_over_full_screen<R: Runtime>(window: &Window<R>) {
    let target = window.clone();
    // AppKit must only be touched from the main thread.
    let queued = window.run_on_main_thread(move || match target.ns_window() {
        // SAFETY: `ptr` is the live NSWindow backing this Tauri window.
        Ok(ptr) if !ptr.is_null() => unsafe { macos_spaces::join_all_spaces(ptr) },
        Ok(_) => log::warn!("Full screen: NSWindow pointer was null for '{}'", target.label()),
        Err(e) => log::warn!("Full screen: no NSWindow for '{}': {e}", target.label()),
    });
    if let Err(e) = queued {
        log::warn!("Full screen: couldn't reach the main thread: {e}");
    }
}

/// NSWindow collection behavior (AppKit), set through the Objective-C
/// runtime like `setSharingType` above.
#[cfg(target_os = "macos")]
mod macos_spaces {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // NSWindowCollectionBehavior bits.
    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const MOVE_TO_ACTIVE_SPACE: usize = 1 << 1;
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;

    /// Show the window on every Space, including a full-screen app's.
    /// CanJoinAllSpaces and MoveToActiveSpace are exclusive.
    ///
    /// # Safety
    /// `ns_window` must point to a live NSWindow, on the main thread.
    pub unsafe fn join_all_spaces(ns_window: *mut std::ffi::c_void) {
        let ns_window: &AnyObject = &*(ns_window as *const AnyObject);
        let current: usize = msg_send![ns_window, collectionBehavior];
        let wanted = (current & !MOVE_TO_ACTIVE_SPACE) | CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY;
        let _: () = msg_send![ns_window, setCollectionBehavior: wanted];
    }
}

/// Live blur of the desktop behind `window` (the overlay's glass), only while
/// it is on screen. Windows keeps drawing an accent blur for a hidden window
/// whenever it recomposites it, which showed as a pinned blurred box where the
/// overlay sits between meetings.
#[cfg(target_os = "windows")]
pub fn blur_behind_while_visible<R: Runtime>(window: &Window<R>) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    let visible = window.is_visible().unwrap_or(false);
    let target = window.clone();
    let queued = window.run_on_main_thread(move || {
        if let Err(e) = visibility_hook::install(hwnd) {
            log::warn!("Can't follow visibility of '{}': {e}", target.label());
            return;
        }
        visibility_hook::blur_while_visible(hwnd, visible);
    });
    if let Err(e) = queued {
        log::warn!("Blur behind: couldn't reach the main thread: {e}");
    }
}

/// A window subclass that follows a window being shown and hidden: just before
/// the window is shown it gets the stealth setting, and its blur-behind turns
/// on and off with it. A window being hidden keeps its affinity (see
/// `apply_setting`).
#[cfg(target_os = "windows")]
mod visibility_hook {
    use std::sync::{LazyLock, Mutex};

    use windows::core::s;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_SERVER};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList, RemoveWindowSubclass, SetWindowSubclass, TaskbarList,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        IsWindowVisible, KillTimer, LoadCursorW, RegisterWindowMessageA, SetCursor, SetTimer,
        SetWindowDisplayAffinity, HTBOTTOMRIGHT, HTLEFT, IDC_ARROW, SWP_HIDEWINDOW, SWP_SHOWWINDOW, WINDOWPOS,
        WINDOW_DISPLAY_AFFINITY, WM_NCDESTROY, WM_SETCURSOR, WM_TIMER, WM_WINDOWPOSCHANGED,
        WM_WINDOWPOSCHANGING,
    };

    use super::TabAction;

    const SUBCLASS_ID: usize = 0x4E58_5153; // "NXQS"
    // WDA_EXCLUDEFROMCAPTURE = 0x11 (Windows 10 v2004+), WDA_NONE = 0.
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;
    const WDA_NONE: u32 = 0;

    static HOOKED: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    /// Windows excluded from capture (see [`set_excluded`]).
    static EXCLUDED: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    /// Windows whose desktop blur follows their visibility.
    static BLURRED: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    /// Windows whose resize edges show the arrow while stealth is on.
    static ARROW_EDGES: Mutex<Vec<isize>> = Mutex::new(Vec::new());

    /// Show the arrow instead of the resize cursors at `hwnd`'s edges while
    /// stealth is on (main thread only). Resizing itself still works.
    pub fn keep_arrow_at_edges(hwnd: isize) {
        let mut edges = ARROW_EDGES.lock().unwrap_or_else(|e| e.into_inner());
        if !edges.contains(&hwnd) {
            edges.push(hwnd);
        }
    }

    fn keeps_arrow_at_edges(hwnd: HWND) -> bool {
        ARROW_EDGES.lock().unwrap_or_else(|e| e.into_inner()).contains(&(hwnd.0 as isize))
    }

    /// Windows whose taskbar button follows stealth (the overlay, the launcher).
    static TASKBAR_MANAGED: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    /// Windows whose taskbar button stealth removed, so turning it off knows
    /// which buttons to put back.
    static TABS_REMOVED: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    /// Sent to every top-level window when Explorer (re)creates the taskbar,
    /// which rebuilds every button (same registration as tao's).
    static TASKBAR_CREATED: LazyLock<u32> =
        LazyLock::new(|| unsafe { RegisterWindowMessageA(s!("TaskbarCreated")) });
    /// One-shot timer that syncs a button again shortly after a show, in
    /// case the taskbar adds the button back after our first sync.
    const TASKBAR_RESYNC_TIMER: usize = 0x4E58_5154; // "NXQT"
    const TASKBAR_RESYNC_MS: u32 = 150;

    /// Let `hwnd`'s taskbar button follow stealth (main thread only).
    pub fn manage_taskbar(hwnd: isize) {
        let mut managed = TASKBAR_MANAGED.lock().unwrap_or_else(|e| e.into_inner());
        if !managed.contains(&hwnd) {
            managed.push(hwnd);
        }
    }

    fn is_taskbar_managed(hwnd: HWND) -> bool {
        TASKBAR_MANAGED.lock().unwrap_or_else(|e| e.into_inner()).contains(&(hwnd.0 as isize))
    }

    /// Line `hwnd`'s taskbar button up with stealth (main thread only: COM).
    /// tao's `set_skip_taskbar` isn't used: its `DeleteTab` doesn't survive a
    /// hide and show, and its `AddTab` on a hidden window leaves a taskbar
    /// button for a window that isn't on screen. Locks are not held across
    /// the COM calls, which can pump messages.
    pub fn sync_taskbar_button(hwnd: isize) {
        let handle = HWND(hwnd as *mut _);
        if !is_taskbar_managed(handle) {
            return;
        }
        let visible = unsafe { IsWindowVisible(handle) }.as_bool();
        let removed = TABS_REMOVED.lock().unwrap_or_else(|e| e.into_inner()).contains(&hwnd);
        match super::taskbar_action(super::stealth_enabled(), visible, removed) {
            TabAction::Remove => match set_tab(handle, false) {
                Ok(()) => {
                    let mut tabs = TABS_REMOVED.lock().unwrap_or_else(|e| e.into_inner());
                    if !tabs.contains(&hwnd) {
                        tabs.push(hwnd);
                    }
                }
                Err(e) => log::warn!("Stealth mode: couldn't remove a taskbar button: {e}"),
            },
            TabAction::Restore => match set_tab(handle, true) {
                Ok(()) => TABS_REMOVED.lock().unwrap_or_else(|e| e.into_inner()).retain(|&h| h != hwnd),
                Err(e) => log::warn!("Stealth mode: couldn't put a taskbar button back: {e}"),
            },
            TabAction::Leave => {}
        }
    }

    /// Add or remove `hwnd`'s taskbar button through `ITaskbarList`.
    fn set_tab(hwnd: HWND, show: bool) -> windows::core::Result<()> {
        unsafe {
            let list: ITaskbarList = CoCreateInstance(&TaskbarList, None, CLSCTX_SERVER)?;
            list.HrInit()?;
            if show {
                list.AddTab(hwnd)
            } else {
                list.DeleteTab(hwnd)
            }
        }
    }

    /// Turn blur-behind on for `hwnd` while it's visible (main thread only).
    pub fn blur_while_visible(hwnd: isize, visible_now: bool) {
        let mut blurred = BLURRED.lock().unwrap_or_else(|e| e.into_inner());
        if !blurred.contains(&hwnd) {
            blurred.push(hwnd);
        }
        drop(blurred);
        set_blur(HWND(hwnd as *mut _), visible_now);
    }

    fn wants_blur(hwnd: HWND) -> bool {
        BLURRED.lock().unwrap_or_else(|e| e.into_inner()).contains(&(hwnd.0 as isize))
    }

    /// Live blur of what's behind the window, via the undocumented
    /// `SetWindowCompositionAttribute` (user32): `DwmEnableBlurBehindWindow`
    /// is a no-op on Windows 10/11, and this one composites the live desktop.
    /// The gradient alpha is 1 (0 would disable the blur); the overlay's CSS
    /// (`.overlay-bg`) provides the tint.
    fn set_blur(hwnd: HWND, on: bool) {
        use std::ffi::c_void;
        use windows::core::PCSTR;
        use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};

        #[repr(C)]
        struct AccentPolicy {
            accent_state: u32,
            accent_flags: u32,
            gradient_color: u32,
            animation_id: u32,
        }

        #[repr(C)]
        struct WindowCompositionAttribData {
            attrib: u32,
            pv_data: *mut c_void,
            cb_data: usize,
        }

        const WCA_ACCENT_POLICY: u32 = 19;
        const ACCENT_DISABLED: u32 = 0;
        const ACCENT_ENABLE_BLURBEHIND: u32 = 3;

        // Not in user32.lib's import table: resolved at runtime.
        type SetWindowCompositionAttributeFn =
            unsafe extern "system" fn(HWND, *mut WindowCompositionAttribData) -> i32;

        unsafe {
            let Ok(module) = GetModuleHandleA(PCSTR(b"user32.dll\0".as_ptr())) else {
                return;
            };
            let Some(proc) = GetProcAddress(module, PCSTR(b"SetWindowCompositionAttribute\0".as_ptr()))
            else {
                return;
            };
            let set_window_composition_attribute: SetWindowCompositionAttributeFn =
                std::mem::transmute(proc);
            let mut policy = AccentPolicy {
                accent_state: if on { ACCENT_ENABLE_BLURBEHIND } else { ACCENT_DISABLED },
                accent_flags: 0,
                gradient_color: if on { 0x0100_0000 } else { 0 },
                animation_id: 0,
            };
            let mut data = WindowCompositionAttribData {
                attrib: WCA_ACCENT_POLICY,
                pv_data: &mut policy as *mut _ as *mut c_void,
                cb_data: std::mem::size_of::<AccentPolicy>(),
            };
            set_window_composition_attribute(hwnd, &mut data);
        }
    }

    /// Install once per window (page reloads call this again). Main thread only.
    pub fn install(hwnd: isize) -> Result<(), String> {
        let mut hooked = HOOKED.lock().unwrap_or_else(|e| e.into_inner());
        if hooked.contains(&hwnd) {
            return Ok(());
        }
        let ok = unsafe { SetWindowSubclass(HWND(hwnd as *mut _), Some(subclass_proc), SUBCLASS_ID, 0) };
        if !ok.as_bool() {
            return Err("SetWindowSubclass failed".into());
        }
        hooked.push(hwnd);
        Ok(())
    }

    /// Exclude a window from capture or not (any thread), and remember it:
    /// `GetWindowDisplayAffinity` reports no exclusion for a hidden window.
    pub fn set_excluded(hwnd: HWND, excluded: bool) -> windows::core::Result<()> {
        let affinity = WINDOW_DISPLAY_AFFINITY(if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
        unsafe { SetWindowDisplayAffinity(hwnd, affinity) }?;
        let mut list = EXCLUDED.lock().unwrap_or_else(|e| e.into_inner());
        list.retain(|&h| h != hwnd.0 as isize);
        if excluded {
            list.push(hwnd.0 as isize);
        }
        Ok(())
    }

    fn is_excluded(hwnd: HWND) -> bool {
        EXCLUDED.lock().unwrap_or_else(|e| e.into_inner()).contains(&(hwnd.0 as isize))
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            WM_WINDOWPOSCHANGING => {
                let pos = &*(lparam.0 as *const WINDOWPOS);
                // About to be shown: apply the stealth setting first, so no
                // frame of it reaches a screen share.
                let on = super::stealth_enabled();
                if pos.flags.contains(SWP_SHOWWINDOW) && is_excluded(hwnd) != on {
                    if let Err(e) = set_excluded(hwnd, on) {
                        log::warn!("Stealth mode: SetWindowDisplayAffinity failed: {e}");
                    }
                }
                // About to be hidden: drop the blur first, or it stays on screen.
                if pos.flags.contains(SWP_HIDEWINDOW) && wants_blur(hwnd) {
                    set_blur(hwnd, false);
                }
            }
            WM_WINDOWPOSCHANGED => {
                let pos = &*(lparam.0 as *const WINDOWPOS);
                // Shown: the accent only takes on a visible window.
                if pos.flags.contains(SWP_SHOWWINDOW) && wants_blur(hwnd) {
                    set_blur(hwnd, true);
                }
                // Shown: Windows may give the window its taskbar button back.
                // Sync now, and again shortly after under stealth, in case the
                // taskbar adds the button after this first sync.
                if pos.flags.contains(SWP_SHOWWINDOW) && is_taskbar_managed(hwnd) {
                    sync_taskbar_button(hwnd.0 as isize);
                    if super::stealth_enabled() {
                        let _ = SetTimer(Some(hwnd), TASKBAR_RESYNC_TIMER, TASKBAR_RESYNC_MS, None);
                    }
                }
            }
            WM_TIMER if wparam.0 == TASKBAR_RESYNC_TIMER => {
                let _ = KillTimer(Some(hwnd), TASKBAR_RESYNC_TIMER);
                sync_taskbar_button(hwnd.0 as isize);
                return LRESULT(0);
            }
            m if m == *TASKBAR_CREATED => {
                // Explorer restarted and rebuilt every taskbar button.
                sync_taskbar_button(hwnd.0 as isize);
            }
            WM_SETCURSOR => {
                // The hit-test code is the low word of lParam. Over the
                // window's resize border (HTLEFT..=HTBOTTOMRIGHT) Windows
                // would show a two-headed arrow: keep the plain arrow under
                // stealth. Tauri's undecorated-resize border is a child
                // window, and its WM_SETCURSOR reaches this parent first.
                let hit = (lparam.0 as u32) & 0xFFFF;
                if (HTLEFT..=HTBOTTOMRIGHT).contains(&hit)
                    && super::stealth_enabled()
                    && keeps_arrow_at_edges(hwnd)
                {
                    if let Ok(arrow) = LoadCursorW(None, IDC_ARROW) {
                        SetCursor(Some(arrow));
                        return LRESULT(1);
                    }
                }
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                let mut hooked = HOOKED.lock().unwrap_or_else(|e| e.into_inner());
                hooked.retain(|&h| h != hwnd.0 as isize);
                drop(hooked);
                BLURRED.lock().unwrap_or_else(|e| e.into_inner()).retain(|&h| h != hwnd.0 as isize);
                EXCLUDED.lock().unwrap_or_else(|e| e.into_inner()).retain(|&h| h != hwnd.0 as isize);
                ARROW_EDGES.lock().unwrap_or_else(|e| e.into_inner()).retain(|&h| h != hwnd.0 as isize);
                TASKBAR_MANAGED.lock().unwrap_or_else(|e| e.into_inner()).retain(|&h| h != hwnd.0 as isize);
                TABS_REMOVED.lock().unwrap_or_else(|e| e.into_inner()).retain(|&h| h != hwnd.0 as isize);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

/// At startup, before the webviews load their settings: hide the windows
/// right away when stealth mode was saved on (the frontend's `config.json`
/// store, key `stealthMode`), so reopening NexQ mid-share never shows them.
pub fn restore_on_startup(app: &AppHandle) {
    let saved_on = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(FRONTEND_STORE)).ok())
        .map_or(false, |text| saved_stealth(&text));
    if !saved_on || !support().supported {
        return;
    }
    let _guard = TRANSITION.lock().unwrap_or_else(|e| e.into_inner());
    let windows: Vec<(String, Window)> = app
        .webview_windows()
        .into_iter()
        .map(|(label, w)| (label, w.as_ref().window()))
        .collect();
    // Stealth is on from here, so windows shown later are hidden from capture.
    STEALTH.store(true, Ordering::SeqCst);
    for (_, window) in &windows {
        track_visibility(window);
    }
    match transition(&windows, false, true, apply_setting) {
        Ok(()) => {
            log::info!("Stealth mode restored at startup");
            for (_, window) in &windows {
                sync_taskbar(window);
            }
            sync_macos(app);
        }
        Err(e) => {
            STEALTH.store(false, Ordering::SeqCst);
            log::warn!("Stealth mode: couldn't restore at startup: {e}");
        }
    }
}

/// The frontend config store file (src/stores/configStore.ts `STORE_FILE`).
const FRONTEND_STORE: &str = "config.json";

fn saved_stealth(store_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(store_json)
        .ok()
        .and_then(|v| v.get("stealthMode").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn set_capture_excluded<R: Runtime>(window: &Window<R>, excluded: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;

    let hwnd = window.hwnd().map_err(|e| format!("no window handle: {e}"))?;
    visibility_hook::set_excluded(HWND(hwnd.0 as *mut _), excluded)
        .map_err(|e| format!("SetWindowDisplayAffinity failed: {e}"))
}

#[cfg(target_os = "macos")]
fn set_capture_excluded<R: Runtime>(window: &Window<R>, excluded: bool) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // NSWindowSharingType: 0 = None (left out of capture), 1 = ReadOnly (default).
    let sharing_type: usize = if excluded { 0 } else { 1 };
    let target = window.clone();
    // AppKit must only be touched from the main thread.
    window
        .run_on_main_thread(move || match target.ns_window() {
            Ok(ptr) if !ptr.is_null() => {
                // SAFETY: `ptr` is the live NSWindow backing this Tauri window.
                let ns_window: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
                let _: () = unsafe { msg_send![ns_window, setSharingType: sharing_type] };
            }
            Ok(_) => log::warn!("Stealth mode: NSWindow pointer was null for '{}'", target.label()),
            Err(e) => log::warn!("Stealth mode: no NSWindow for '{}': {e}", target.label()),
        })
        .map_err(|e| format!("couldn't reach the main thread: {e}"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn set_capture_excluded<R: Runtime>(_window: &Window<R>, excluded: bool) -> Result<(), String> {
    if excluded {
        Err("not supported on this platform".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Fake windows: (fails_when_set_to, current state).
    fn windows(specs: &[(&str, Option<bool>)]) -> Vec<(String, (Option<bool>, RefCell<bool>))> {
        specs
            .iter()
            .map(|(l, fail)| (l.to_string(), (*fail, RefCell::new(false))))
            .collect()
    }

    fn apply(w: &(Option<bool>, RefCell<bool>), on: bool) -> Result<(), String> {
        if w.0 == Some(on) {
            return Err("refused".into());
        }
        *w.1.borrow_mut() = on;
        Ok(())
    }

    #[test]
    fn all_windows_change_together() {
        let ws = windows(&[("launcher", None), ("overlay", None)]);
        assert!(transition(&ws, false, true, apply).is_ok());
        assert!(ws.iter().all(|(_, w)| *w.1.borrow()));
    }

    #[test]
    fn a_refusal_rolls_back_the_windows_already_changed() {
        let ws = windows(&[("launcher", None), ("overlay", Some(true))]);
        let err = transition(&ws, false, true, apply).unwrap_err();
        assert!(err.contains("still visible in"), "{err}");
        assert!(ws.iter().all(|(_, w)| !*w.1.borrow()));
    }

    #[test]
    fn a_failed_rollback_names_the_windows_left_changed() {
        // launcher accepts "on" but refuses going back to "off".
        let ws = windows(&[("launcher", Some(false)), ("overlay", Some(true))]);
        let err = transition(&ws, false, true, apply).unwrap_err();
        assert!(err.contains("couldn't be put back: launcher"), "{err}");
    }

    #[test]
    fn saved_setting_is_read_from_the_frontend_store() {
        assert!(saved_stealth(r#"{"stealthMode":true,"theme":"dark"}"#));
        assert!(!saved_stealth(r#"{"stealthMode":false}"#));
        assert!(!saved_stealth("{}"));
        assert!(!saved_stealth("not json"));
    }

    #[test]
    fn only_the_overlay_and_launcher_follow_the_taskbar_skip() {
        // The two NexQ windows the user sees in the taskbar today.
        assert!(is_taskbar_managed_label("overlay"));
        assert!(is_taskbar_managed_label("launcher"));
        // The meeting-prompt window uses .skip_taskbar(true) at build
        // time already; the dev-log window is a developer-only surface.
        // Neither should be touched by the stealth taskbar-skip loop.
        assert!(!is_taskbar_managed_label("meeting-prompt"));
        assert!(!is_taskbar_managed_label("devlog"));
        assert!(!is_taskbar_managed_label("something-else"));
    }

    #[test]
    fn stealth_removes_taskbar_buttons_only_from_visible_windows() {
        // Stealth on: a visible window loses its button, again after each
        // show (Windows may have put it back); a hidden one waits for its show.
        assert_eq!(taskbar_action(true, true, false), TabAction::Remove);
        assert_eq!(taskbar_action(true, true, true), TabAction::Remove);
        assert_eq!(taskbar_action(true, false, false), TabAction::Leave);
    }

    #[test]
    fn turning_stealth_off_puts_back_only_buttons_it_removed_on_visible_windows() {
        assert_eq!(taskbar_action(false, true, true), TabAction::Restore);
        // Never removed by stealth: nothing to put back.
        assert_eq!(taskbar_action(false, true, false), TabAction::Leave);
        // Hidden: adding a button now would leave one for a window nobody can
        // see. Its show hook restores it when it appears.
        assert_eq!(taskbar_action(false, false, true), TabAction::Leave);
    }
}
