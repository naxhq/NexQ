//! Capture the screen the mouse pointer is on, for the Ask box shortcut.
//!
//! The picture lives in memory only: it is grabbed, shrunk, PNG-encoded and
//! handed to the frontend as raw bytes. Nothing is written to disk or logged.
//!
//! - Windows: GDI `BitBlt` from the screen device context. It works on every
//!   Windows version NexQ supports and respects `WDA_EXCLUDEFROMCAPTURE`, so
//!   with "Hide from screen share" on NexQ's windows are left out of the shot.
//!   NexQ never hides, moves or re-flags its own windows to keep them out.
//! - macOS: `CGDisplayCreateImage` (needs the Screen Recording permission).

use std::io::Cursor;

use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageEncoder, RgbImage, RgbaImage};
use tauri::command;

/// Longest edge of the picture handed to the frontend. Claude shrinks anything
/// larger anyway; this matches `MAX_IMAGE_EDGE` in `src/lib/imageAttachments.ts`.
const MAX_EDGE: u32 = 1568;

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

/// True when every pixel is pure black: a locked screen, or content the system
/// refuses to hand over (DRM video, protected windows). `bgra` is 4 bytes per
/// pixel; alpha is ignored.
pub fn is_blank(bgra: &[u8]) -> bool {
    bgra.chunks_exact(4).all(|px| px[0] == 0 && px[1] == 0 && px[2] == 0)
}

/// A raw frame from the OS: `bgra` is `width * height * 4` bytes, rows tightly packed.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

/// The frame as PNG bytes, shrunk so its long edge is at most `max_edge`.
pub fn encode_png(frame: Frame, max_edge: u32) -> Result<Vec<u8>, String> {
    const FAILED: &str = "Couldn't capture the screen";
    let Frame { width, height, mut bgra } = frame;
    if width == 0 || height == 0 || bgra.len() != width as usize * height as usize * 4 {
        return Err(FAILED.into());
    }
    if is_blank(&bgra) {
        return Err("The screen came out black. It may be locked or showing protected content.".into());
    }
    // BGRA -> RGBA; GDI leaves alpha at 0, so make every pixel opaque.
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    let mut img = RgbaImage::from_raw(width, height, bgra).ok_or(FAILED)?;
    let (new_w, new_h) = fit_within(width, height, max_edge);
    if (new_w, new_h) != (width, height) {
        img = image::imageops::resize(&img, new_w, new_h, FilterType::Lanczos3);
    }
    let rgb: RgbImage = image::DynamicImage::ImageRgba8(img).into_rgb8();
    let mut out = Cursor::new(Vec::new());
    PngEncoder::new(&mut out)
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .map_err(|_| FAILED)?;
    Ok(out.into_inner())
}

/// Captures the screen under the mouse pointer and returns it as PNG bytes
/// (at most 1568 px on the long edge). Errors are plain sentences to show.
#[command]
pub async fn capture_screen_under_cursor() -> Result<tauri::ipc::Response, String> {
    let png = tokio::task::spawn_blocking(|| platform::grab_under_cursor().and_then(|f| encode_png(f, MAX_EDGE)))
        .await
        .map_err(|_| "Couldn't capture the screen".to_string())??;
    Ok(tauri::ipc::Response::new(png))
}

#[cfg(windows)]
mod platform {
    use super::{pick_monitor, Frame, Rect};
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

    const FAILED: &str = "Couldn't capture the screen";

    /// Makes this thread per-monitor DPI aware while it captures, so the pointer
    /// and monitor rectangles are physical pixels on every monitor, and puts the
    /// previous awareness back (tokio reuses blocking threads).
    struct DpiAwareThread(DPI_AWARENESS_CONTEXT);
    impl DpiAwareThread {
        fn new() -> Self {
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

    fn monitors() -> Vec<Rect> {
        let mut list: Vec<Rect> = Vec::new();
        // SAFETY: the callback only runs during this call, with `list` alive.
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut list as *mut Vec<Rect> as isize));
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
            unsafe { let _ = DeleteDC(self.0); }
        }
    }
    struct Bitmap(HBITMAP);
    impl Drop for Bitmap {
        fn drop(&mut self) {
            // SAFETY: created by `CreateCompatibleBitmap`, no longer selected.
            unsafe { let _ = DeleteObject(HGDIOBJ(self.0 .0)); }
        }
    }

    pub fn grab_under_cursor() -> Result<Frame, String> {
        let _dpi = DpiAwareThread::new();
        let mut cursor = POINT::default();
        // SAFETY: `cursor` is a valid out pointer.
        unsafe { GetCursorPos(&mut cursor) }.map_err(|_| FAILED.to_string())?;
        let list = monitors();
        let monitor = pick_monitor(&list, cursor.x, cursor.y).map(|i| list[i]).ok_or(FAILED)?;
        let (width, height) = (monitor.width(), monitor.height());
        if width <= 0 || height <= 0 {
            return Err(FAILED.into());
        }

        // SAFETY: every handle is checked and released by its guard; the
        // buffer holds exactly `width * height * 4` bytes, as `GetDIBits` is told.
        unsafe {
            let screen = ScreenDc(GetDC(None));
            if screen.0.is_invalid() {
                return Err(FAILED.into());
            }
            let mem = MemDc(CreateCompatibleDC(Some(screen.0)));
            if mem.0.is_invalid() {
                return Err(FAILED.into());
            }
            let bitmap = Bitmap(CreateCompatibleBitmap(screen.0, width, height));
            if bitmap.0.is_invalid() {
                return Err(FAILED.into());
            }
            let previous = SelectObject(mem.0, HGDIOBJ(bitmap.0 .0));
            // CAPTUREBLT includes layered (transparent) windows.
            let copied = BitBlt(mem.0, 0, 0, width, height, Some(screen.0), monitor.left, monitor.top, SRCCOPY | CAPTUREBLT);
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
            let lines = GetDIBits(mem.0, bitmap.0, 0, height as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
            // Put the original bitmap back before the guards delete ours.
            SelectObject(mem.0, previous);
            if copied.is_err() || lines != height {
                return Err(FAILED.into());
            }
            Ok(Frame { width: width as u32, height: height as u32, bgra })
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Frame;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *const c_void) -> CGPoint;
        fn CGGetDisplaysWithPoint(point: CGPoint, max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCreateImage(display: u32) -> *mut c_void;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
        fn CGImageGetBytesPerRow(image: *const c_void) -> usize;
        fn CGImageGetBitsPerPixel(image: *const c_void) -> usize;
        fn CGImageGetDataProvider(image: *const c_void) -> *mut c_void;
        fn CGDataProviderCopyData(provider: *const c_void) -> *mut c_void;
        fn CGImageRelease(image: *mut c_void);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFDataGetLength(data: *const c_void) -> isize;
        fn CFRelease(object: *const c_void);
    }

    const FAILED: &str = "Couldn't capture the screen";

    pub fn grab_under_cursor() -> Result<Frame, String> {
        // SAFETY: Core Graphics calls with checked results; every object we
        // create is released on every path.
        unsafe {
            if !CGPreflightScreenCaptureAccess() {
                // Shows the system prompt the first time; later it does nothing.
                CGRequestScreenCaptureAccess();
                return Err(
                    "NexQ needs the Screen Recording permission. Allow it in System Settings > Privacy & Security, then try again."
                        .into(),
                );
            }
            // The display under the pointer (global coordinates, same space as the displays).
            let mut display = CGMainDisplayID();
            let event = CGEventCreate(std::ptr::null());
            if !event.is_null() {
                let point = CGEventGetLocation(event);
                CFRelease(event);
                let mut found = [0u32; 1];
                let mut count = 0u32;
                if CGGetDisplaysWithPoint(point, 1, found.as_mut_ptr(), &mut count) == 0 && count > 0 {
                    display = found[0];
                }
            }
            let image = CGDisplayCreateImage(display);
            if image.is_null() {
                return Err(FAILED.into());
            }
            let result = copy_pixels(image);
            CGImageRelease(image);
            result
        }
    }

    /// The image's pixels as tightly packed BGRA (Core Graphics hands out
    /// 32-bit little-endian BGRA, with row padding).
    unsafe fn copy_pixels(image: *mut c_void) -> Result<Frame, String> {
        let (width, height) = (CGImageGetWidth(image), CGImageGetHeight(image));
        let stride = CGImageGetBytesPerRow(image);
        if width == 0 || height == 0 || CGImageGetBitsPerPixel(image) != 32 || stride < width * 4 {
            return Err(FAILED.into());
        }
        let data = CGDataProviderCopyData(CGImageGetDataProvider(image));
        if data.is_null() {
            return Err(FAILED.into());
        }
        let len = CFDataGetLength(data).max(0) as usize;
        let ptr = CFDataGetBytePtr(data);
        let result = if ptr.is_null() || len < stride * (height - 1) + width * 4 {
            Err(FAILED.to_string())
        } else {
            let src = std::slice::from_raw_parts(ptr, len);
            let mut bgra = Vec::with_capacity(width * height * 4);
            for row in 0..height {
                bgra.extend_from_slice(&src[row * stride..row * stride + width * 4]);
            }
            Ok(Frame { width: width as u32, height: height as u32, bgra })
        };
        CFRelease(data);
        result
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::Frame;

    pub fn grab_under_cursor() -> Result<Frame, String> {
        Err("Capturing the screen isn't supported on this system".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn r(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect { left, top, right, bottom }
    }

    // The author's setup: a 5120x1440 primary at the origin and a 3840x2160
    // monitor above-right of it (physical pixels, mixed DPI scaling).
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
    fn blank_detection_ignores_alpha_and_needs_every_pixel_black() {
        assert!(is_blank(&[0, 0, 0, 0, 0, 0, 0, 255]));
        assert!(!is_blank(&[0, 0, 0, 0, 0, 1, 0, 0]));
        assert!(is_blank(&[]));
    }

    fn frame(width: u32, height: u32, fill: [u8; 4]) -> Frame {
        Frame { width, height, bgra: fill.iter().copied().cycle().take((width * height * 4) as usize).collect() }
    }

    #[test]
    fn encodes_a_png_with_swapped_channels_and_the_right_size() {
        // BGRA (blue 10, green 20, red 30) must come out as RGB (30, 20, 10).
        let png = encode_png(frame(40, 20, [10, 20, 30, 0]), MAX_EDGE).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap().into_rgb8();
        assert_eq!(img.dimensions(), (40, 20));
        assert_eq!(img.get_pixel(5, 5).0, [30, 20, 10]);
    }

    #[test]
    fn shrinks_a_wide_screen_to_the_edge_limit() {
        let png = encode_png(frame(5120, 1440, [200, 100, 50, 0]), MAX_EDGE).unwrap();
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
}
