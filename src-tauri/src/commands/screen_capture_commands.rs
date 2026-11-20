//! Capture the screen the mouse pointer is on, for the Ask box shortcut.
//!
//! The picture lives in memory only: it is grabbed, shrunk, PNG-encoded and
//! handed to the frontend as raw bytes. Nothing is written to disk, and
//! nothing about the picture is logged (only steps, timings and error codes).
//!
//! Windows only for now: GDI `BitBlt` from the screen device context. It
//! respects `WDA_EXCLUDEFROMCAPTURE`, so with "Hide from screen share" on,
//! NexQ's windows are left out of the shot. NexQ never hides, moves or
//! re-flags its own windows to keep them out. Other systems get a clear error.

use std::io::Cursor;
use std::time::{Duration, Instant};

use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageEncoder, RgbImage};
use std::sync::atomic::Ordering;
use tauri::{command, State, Window};

use crate::state::AppState;

/// Longest edge of the picture handed to the frontend. Claude shrinks anything
/// larger anyway; this matches `MAX_IMAGE_EDGE` in `src/lib/imageAttachments.ts`.
const MAX_EDGE: u32 = 1568;

/// How the picture is shrunk.
const RESIZE_FILTER: FilterType = FilterType::Lanczos3;

const FAILED: &str = "Couldn't capture the screen";

/// A rectangle in virtual-desktop pixels (`right` and `bottom` are exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
    /// Squared distance from the point to the rectangle (0 when inside).
    fn distance_sq(&self, x: i32, y: i32) -> i64 {
        let dx = (self.left - x).max(0).max(x - (self.right - 1)) as i64;
        let dy = (self.top - y).max(0).max(y - (self.bottom - 1)) as i64;
        dx * dx + dy * dy
    }
}

/// The monitor under the pointer: the one that contains it, else the nearest
/// (the pointer can sit in a gap between differently sized monitors). All
/// coordinates are physical pixels of the virtual desktop, so negative values
/// (monitors left of or above the primary one) and monitors of different DPI
/// scaling need no special treatment. `None` only when there are no monitors.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn pick_monitor(monitors: &[Rect], x: i32, y: i32) -> Option<usize> {
    if let Some(i) = monitors.iter().position(|m| m.contains(x, y)) {
        return Some(i);
    }
    monitors
        .iter()
        .enumerate()
        .min_by_key(|(_, m)| m.distance_sq(x, y))
        .map(|(i, _)| i)
}

/// `width` x `height` scaled down (never up) so the long edge is at most `max`.
pub fn fit_within(width: u32, height: u32, max: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max {
        return (width, height);
    }
    let scale = max as f64 / longest as f64;
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

/// A raw frame from the OS: `bgra` is `width * height * 4` bytes, rows tightly packed.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

/// BGRA to RGB in one pass, and whether every pixel was pure black (a locked
/// screen, or content the system refuses to hand over: DRM video, protected
/// windows). Alpha is ignored (GDI leaves it at 0).
pub fn bgra_to_rgb(bgra: &[u8]) -> (Vec<u8>, bool) {
    let mut rgb = vec![0u8; bgra.len() / 4 * 3];
    let mut any = 0u8;
    for (src, dst) in bgra.chunks_exact(4).zip(rgb.chunks_exact_mut(3)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
        any |= src[0] | src[1] | src[2];
    }
    (rgb, any == 0)
}

/// Where the time of an encode went.
#[derive(Debug, Default, Clone, Copy)]
pub struct Timings {
    pub convert: Duration,
    pub resize: Duration,
    pub encode: Duration,
}

/// The frame as PNG bytes, shrunk so its long edge is at most `max_edge`.
pub fn encode_png(frame: Frame, max_edge: u32) -> Result<(Vec<u8>, Timings), String> {
    let Frame { width, height, bgra } = frame;
    if width == 0 || height == 0 || bgra.len() != width as usize * height as usize * 4 {
        log::warn!("screen capture: malformed frame {width}x{height}, {} bytes", bgra.len());
        return Err(FAILED.into());
    }
    let mut timings = Timings::default();

    let t = Instant::now();
    let (rgb, blank) = bgra_to_rgb(&bgra);
    drop(bgra);
    timings.convert = t.elapsed();
    if blank {
        log::warn!("screen capture: the screen came out entirely black");
        return Err("The screen came out black. It may be locked or showing protected content.".into());
    }
    let mut img = RgbImage::from_raw(width, height, rgb).ok_or_else(|| {
        log::warn!("screen capture: pixel buffer does not match {width}x{height}");
        FAILED
    })?;

    let t = Instant::now();
    let (new_w, new_h) = fit_within(width, height, max_edge);
    if (new_w, new_h) != (width, height) {
        img = image::imageops::resize(&img, new_w, new_h, RESIZE_FILTER);
    }
    timings.resize = t.elapsed();

    let t = Instant::now();
    let mut out = Cursor::new(Vec::new());
    PngEncoder::new(&mut out)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgb8)
        .map_err(|e| {
            log::warn!("screen capture: PNG encoding failed: {e}");
            FAILED
        })?;
    timings.encode = t.elapsed();
    Ok((out.into_inner(), timings))
}

/// Whether `label` may capture: only the overlay window, and only during a
/// meeting (the shortcut is held by the overlay for the meeting's length).
pub fn check_allowed(label: &str, meeting_active: bool) -> Result<(), &'static str> {
    if label != "overlay" {
        return Err("Screen capture is only available from the meeting overlay");
    }
    if !meeting_active {
        return Err("Screen capture is only available during a meeting");
    }
    Ok(())
}

/// Captures the screen under the mouse pointer and returns it as PNG bytes
/// (at most 1568 px on the long edge). Only the overlay may ask, during a
/// meeting. Errors are plain sentences to show.
#[command]
pub async fn capture_screen_under_cursor(
    window: Window,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    if let Err(refusal) = check_allowed(window.label(), state.meeting_active.load(Ordering::SeqCst)) {
        log::warn!("screen capture refused for window '{}': {refusal}", window.label());
        return Err(refusal.into());
    }
    let started = Instant::now();
    let (png, grab, timings) = tokio::task::spawn_blocking(|| {
        let t = Instant::now();
        let frame = platform::grab_under_cursor()?;
        let grab = t.elapsed();
        let (png, timings) = encode_png(frame, MAX_EDGE)?;
        Ok::<_, String>((png, grab, timings))
    })
    .await
    .map_err(|e| {
        log::warn!("screen capture: worker thread failed: {e}");
        FAILED.to_string()
    })??;
    log::debug!(
        "screen capture: {} bytes in {:?} (grab {:?}, convert {:?}, resize {:?}, encode {:?})",
        png.len(),
        started.elapsed(),
        grab,
        timings.convert,
        timings.resize,
        timings.encode
    );
    Ok(tauri::ipc::Response::new(png))
}

#[cfg(windows)]
mod platform {
    use super::{pick_monitor, Frame, Rect, FAILED};
    use std::ffi::c_void;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP,
        HDC, HGDIOBJ, HMONITOR, SRCCOPY,
    };
    use windows::Win32::UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    /// Makes this thread per-monitor DPI aware while it captures, so the pointer
    /// and monitor rectangles are physical pixels on every monitor, and puts the
    /// previous awareness back (tokio reuses blocking threads).
    pub struct DpiAwareThread(DPI_AWARENESS_CONTEXT);
    impl DpiAwareThread {
        pub fn new() -> Self {
            // SAFETY: plain Win32 call with a constant context.
            Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
        }
    }
    impl Drop for DpiAwareThread {
        fn drop(&mut self) {
            if !self.0 .0.is_null() {
                // SAFETY: restores the context this thread had.
                unsafe { SetThreadDpiAwarenessContext(self.0) };
            }
        }
    }

    unsafe extern "system" fn collect(_: HMONITOR, _: HDC, rect: *mut RECT, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the `Vec<Rect>` passed by `monitors`; `rect` is valid for the call.
        let list = &mut *(data.0 as *mut Vec<Rect>);
        let r = &*rect;
        list.push(Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
        BOOL(1)
    }

    /// Every monitor, in physical pixels of the virtual desktop (call on a
    /// per-monitor DPI aware thread).
    pub fn monitors() -> Vec<Rect> {
        let mut list: Vec<Rect> = Vec::new();
        // SAFETY: the callback only runs during this call, with `list` alive.
        let listed =
            unsafe { EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut list as *mut Vec<Rect> as isize)) };
        if !listed.as_bool() {
            log::warn!("screen capture: EnumDisplayMonitors failed");
        }
        list
    }

    struct ScreenDc(HDC);
    impl Drop for ScreenDc {
        fn drop(&mut self) {
            // SAFETY: obtained from `GetDC(None)`.
            unsafe { ReleaseDC(None, self.0) };
        }
    }
    struct MemDc(HDC);
    impl Drop for MemDc {
        fn drop(&mut self) {
            // SAFETY: created by `CreateCompatibleDC`.
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }
    struct Bitmap(HBITMAP);
    impl Drop for Bitmap {
        fn drop(&mut self) {
            // SAFETY: created by `CreateCompatibleBitmap`; never selected into a DC at this point.
            unsafe {
                let _ = DeleteObject(HGDIOBJ(self.0 .0));
            }
        }
    }

    pub fn grab_under_cursor() -> Result<Frame, String> {
        let _dpi = DpiAwareThread::new();
        let mut cursor = POINT::default();
        // SAFETY: `cursor` is a valid out pointer.
        unsafe { GetCursorPos(&mut cursor) }.map_err(|e| {
            log::warn!("screen capture: GetCursorPos failed: {e}");
            FAILED.to_string()
        })?;
        let list = monitors();
        let monitor = pick_monitor(&list, cursor.x, cursor.y).map(|i| list[i]).ok_or_else(|| {
            log::warn!("screen capture: no monitors found");
            FAILED.to_string()
        })?;
        grab_monitor(&monitor)
    }

    /// The pixels of one monitor (a rectangle of the virtual desktop).
    pub fn grab_monitor(monitor: &Rect) -> Result<Frame, String> {
        let (width, height) = (monitor.width(), monitor.height());
        if width <= 0 || height <= 0 {
            log::warn!("screen capture: monitor rectangle {width}x{height} is empty");
            return Err(FAILED.into());
        }
        let fail = |step: &str| -> String {
            log::warn!("screen capture: {step} failed: {}", windows::core::Error::from_thread());
            FAILED.to_string()
        };

        // SAFETY: every handle is checked and released by its guard; the
        // buffer holds exactly `width * height * 4` bytes, as `GetDIBits` is told.
        unsafe {
            let screen = ScreenDc(GetDC(None));
            if screen.0.is_invalid() {
                return Err(fail("GetDC"));
            }
            let mem = MemDc(CreateCompatibleDC(Some(screen.0)));
            if mem.0.is_invalid() {
                return Err(fail("CreateCompatibleDC"));
            }
            let bitmap = Bitmap(CreateCompatibleBitmap(screen.0, width, height));
            if bitmap.0.is_invalid() {
                return Err(fail("CreateCompatibleBitmap"));
            }
            let previous = SelectObject(mem.0, HGDIOBJ(bitmap.0 .0));
            if previous.is_invalid() {
                return Err(fail("SelectObject"));
            }
            // CAPTUREBLT includes layered (transparent) windows.
            let copied = BitBlt(mem.0, 0, 0, width, height, Some(screen.0), monitor.left, monitor.top, SRCCOPY | CAPTUREBLT);
            // GetDIBits needs the bitmap out of every DC: put the original back first.
            SelectObject(mem.0, previous);
            if let Err(e) = copied {
                log::warn!("screen capture: BitBlt failed: {e}");
                return Err(FAILED.into());
            }
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bgra = vec![0u8; width as usize * height as usize * 4];
            let lines = GetDIBits(
                screen.0,
                bitmap.0,
                0,
                height as u32,
                Some(bgra.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            );
            if lines != height {
                log::warn!("screen capture: GetDIBits returned {lines} of {height} lines");
                return Err(FAILED.into());
            }
            Ok(Frame { width: width as u32, height: height as u32, bgra })
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Frame;

    pub fn grab_under_cursor() -> Result<Frame, String> {
        Err("Capturing the screen is only available on Windows for now".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn r(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect { left, top, right, bottom }
    }

    // A 5120x1440 primary at the origin and a 3840x2160 monitor above-right of
    // it (physical pixels, mixed DPI scaling).
    const PRIMARY: Rect = r(0, 0, 5120, 1440);
    const ABOVE: Rect = r(812, -2160, 4652, 0);

    #[test]
    fn picks_the_monitor_that_contains_the_pointer() {
        let monitors = [PRIMARY, ABOVE];
        assert_eq!(pick_monitor(&monitors, 100, 100), Some(0));
        assert_eq!(pick_monitor(&monitors, 2000, -1), Some(1));
        assert_eq!(pick_monitor(&monitors, 2000, 0), Some(0));
        assert_eq!(pick_monitor(&monitors, 812, -2160), Some(1));
    }

    #[test]
    fn right_and_bottom_edges_belong_to_the_next_monitor() {
        let monitors = [r(0, 0, 1920, 1080), r(1920, 0, 3840, 1080)];
        assert_eq!(pick_monitor(&monitors, 1919, 500), Some(0));
        assert_eq!(pick_monitor(&monitors, 1920, 500), Some(1));
    }

    #[test]
    fn handles_monitors_left_of_the_primary_with_negative_coordinates() {
        let monitors = [r(0, 0, 1920, 1080), r(-2560, -200, 0, 1240)];
        assert_eq!(pick_monitor(&monitors, -1, 0), Some(1));
        assert_eq!(pick_monitor(&monitors, -2560, -200), Some(1));
        assert_eq!(pick_monitor(&monitors, 0, 0), Some(0));
    }

    #[test]
    fn a_pointer_in_a_gap_goes_to_the_nearest_monitor() {
        // A small monitor next to a tall one leaves empty desktop beside it.
        let monitors = [r(0, 0, 1920, 1080), r(1920, 0, 3840, 600)];
        // Directly under the second monitor: 300 px from it, 580 px from the first.
        assert_eq!(pick_monitor(&monitors, 2500, 900), Some(1));
        // Far off to the left: nearest is the first.
        assert_eq!(pick_monitor(&monitors, -50, 1500), Some(0));
    }

    #[test]
    fn no_monitors_means_none() {
        assert_eq!(pick_monitor(&[], 0, 0), None);
    }

    #[test]
    fn fits_within_the_edge_without_enlarging() {
        assert_eq!(fit_within(800, 600, 1568), (800, 600));
        assert_eq!(fit_within(1568, 900, 1568), (1568, 900));
        assert_eq!(fit_within(5120, 1440, 1568), (1568, 441));
        assert_eq!(fit_within(1440, 5120, 1568), (441, 1568));
        assert_eq!(fit_within(3840, 2160, 1568), (1568, 882));
        // Never collapses to nothing.
        assert_eq!(fit_within(100_000, 10, 1568), (1568, 1));
    }

    #[test]
    fn converts_bgra_to_rgb_in_one_pass_and_spots_a_black_screen() {
        let (rgb, blank) = bgra_to_rgb(&[10, 20, 30, 0, 1, 2, 3, 255]);
        assert_eq!(rgb, [30, 20, 10, 3, 2, 1]);
        assert!(!blank);
        // Alpha is ignored; every pixel must be black.
        assert!(bgra_to_rgb(&[0, 0, 0, 0, 0, 0, 0, 255]).1);
        assert!(!bgra_to_rgb(&[0, 0, 0, 0, 0, 1, 0, 0]).1);
        assert_eq!(bgra_to_rgb(&[]), (vec![], true));
    }

    fn frame(width: u32, height: u32, fill: [u8; 4]) -> Frame {
        Frame { width, height, bgra: fill.iter().copied().cycle().take((width * height * 4) as usize).collect() }
    }

    #[test]
    fn encodes_a_png_with_swapped_channels_and_the_right_size() {
        // BGRA (blue 10, green 20, red 30) must come out as RGB (30, 20, 10).
        let (png, _) = encode_png(frame(40, 20, [10, 20, 30, 0]), MAX_EDGE).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap().into_rgb8();
        assert_eq!(img.dimensions(), (40, 20));
        assert_eq!(img.get_pixel(5, 5).0, [30, 20, 10]);
    }

    #[test]
    fn shrinks_a_wide_screen_to_the_edge_limit() {
        let (png, _) = encode_png(frame(5120, 1440, [200, 100, 50, 0]), MAX_EDGE).unwrap();
        let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap().into_rgb8();
        assert_eq!(img.dimensions(), (1568, 441));
        assert_eq!(img.get_pixel(700, 200).0, [50, 100, 200]);
    }

    #[test]
    fn refuses_a_black_screen_and_a_malformed_frame() {
        let black = encode_png(frame(64, 64, [0, 0, 0, 0]), MAX_EDGE).unwrap_err();
        assert!(black.contains("black"), "{black}");
        let short = Frame { width: 10, height: 10, bgra: vec![1; 12] };
        assert!(encode_png(short, MAX_EDGE).is_err());
        assert!(encode_png(Frame { width: 0, height: 0, bgra: vec![] }, MAX_EDGE).is_err());
    }

    #[test]
    fn only_the_overlay_during_a_meeting_may_capture() {
        assert!(check_allowed("overlay", true).is_ok());
        assert!(check_allowed("overlay", false).is_err());
        assert!(check_allowed("launcher", true).is_err());
        assert!(check_allowed("", true).is_err());
    }

    /// Release timing of grab + convert + resize + encode on every monitor
    /// (does not move the pointer). Nothing is saved.
    /// `cargo test --release --lib -- --ignored capture_timing --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn capture_timing() {
        let _dpi = platform::DpiAwareThread::new();
        let monitors = platform::monitors();
        assert!(!monitors.is_empty());
        for (i, m) in monitors.iter().enumerate() {
            let mut totals = Vec::new();
            for run in 1..=5 {
                let t0 = Instant::now();
                let frame = platform::grab_monitor(m).expect("grab");
                let grab = t0.elapsed();
                let (w, h) = (frame.width, frame.height);
                let (png, t) = encode_png(frame, MAX_EDGE).expect("encode");
                let total = t0.elapsed();
                println!(
                    "monitor {i} ({w}x{h}) run {run}: total {total:?} = grab {grab:?} + convert {:?} + resize {:?} + encode {:?}; {} bytes",
                    t.convert,
                    t.resize,
                    t.encode,
                    png.len()
                );
                totals.push(total);
            }
            totals.sort();
            println!("monitor {i}: median {:?}", totals[2]);
        }
    }
}
