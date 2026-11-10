use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// What a left click on the tray icon brings up.
#[derive(Debug, PartialEq)]
pub enum ClickTarget {
    MeetingOverlay,
    Dashboard,
}

/// During a meeting the click brings back the meeting overlay; otherwise the
/// dashboard. The tray menu offers both explicitly.
pub fn click_target(meeting_active: bool) -> ClickTarget {
    if meeting_active {
        ClickTarget::MeetingOverlay
    } else {
        ClickTarget::Dashboard
    }
}

/// Left click (or double-click) on the tray icon: bring NexQ to the front.
/// It only ever shows, never hides, because Windows reports a Click for each
/// mouse-up of a double-click too.
pub fn handle_left_click(app: &AppHandle) {
    let meeting_active = app
        .try_state::<AppState>()
        .map(|s| s.meeting_active.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(false);
    match click_target(meeting_active) {
        // The overlay window switches to the meeting view, then shows itself
        // (showing it first flashed an empty window).
        ClickTarget::MeetingOverlay => {
            let _ = app.emit("tray_show_overlay", ());
        }
        ClickTarget::Dashboard => crate::show_launcher(app),
    }
}

/// Middle-click: toggle mic mute during meeting. No-op when idle.
pub fn handle_middle_click(app: &AppHandle) {
    let state = app.state::<AppState>();
    let tray_mgr = state.tray_manager.clone();

    let mgr = tray_mgr.lock().unwrap();
    if let Some(ref manager) = *mgr {
        if manager.meeting_active {
            let _ = app.emit("tray_toggle_mic", ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_during_a_meeting_brings_back_the_meeting_overlay() {
        assert_eq!(click_target(true), ClickTarget::MeetingOverlay);
    }

    #[test]
    fn a_click_without_a_meeting_opens_the_dashboard() {
        assert_eq!(click_target(false), ClickTarget::Dashboard);
    }
}
