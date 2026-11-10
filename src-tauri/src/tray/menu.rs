use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Wry,
};

/// One row of a tray menu.
pub(crate) enum Entry {
    /// A clickable item: menu id (handled in lib.rs `on_menu_event`) and label.
    Item(&'static str, &'static str),
    /// "Hide from Screen Share" (stealth mode), checked while it is on.
    ScreenShare,
    Separator,
}

use Entry::{Item, ScreenShare, Separator};

/// Idle: opening the dashboard comes first, since NexQ has no taskbar
/// button under stealth mode and the tray is the way back to it.
pub(crate) const IDLE_MENU: &[Entry] = &[
    Item("open_dashboard", "Open Dashboard"),
    Item("start_meeting", "Start Meeting"),
    Separator,
    Item("copy_ai_answer", "Copy Last AI Answer"),
    Item("copy_action_items", "Copy Action Items"),
    Item("copy_summary", "Copy Summary"),
    Item("copy_transcript", "Copy Transcript"),
    Separator,
    ScreenShare,
    Item("settings", "Settings"),
    Item("quit", "Quit NexQ"),
];

/// During a meeting: back to the meeting or to the dashboard first.
pub(crate) const MEETING_MENU: &[Entry] = &[
    Item("show_overlay", "Show Overlay"),
    Item("open_dashboard", "Open Dashboard"),
    Separator,
    Item("stop_meeting", "Stop Meeting"),
    Separator,
    Item("toggle_mic", "Mute Microphone"),
    Item("toggle_system", "Mute System Audio"),
    Separator,
    ScreenShare,
    Item("toggle_stealth", "Hide Overlay"),
    Separator,
    Item("copy_ai_answer", "Copy Last AI Answer"),
    Item("copy_action_items", "Copy Action Items"),
    Item("copy_summary", "Copy Summary"),
    Item("copy_transcript", "Copy Transcript"),
    Separator,
    Item("settings", "Settings"),
    Item("quit", "Quit NexQ"),
];

fn build(app: &AppHandle, layout: &[Entry]) -> Result<Menu<Wry>, tauri::Error> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::with_capacity(layout.len());
    for entry in layout {
        items.push(match entry {
            Item(id, label) => Box::new(MenuItem::with_id(app, *id, *label, true, None::<&str>)?),
            ScreenShare => Box::new(CheckMenuItem::with_id(
                app,
                "toggle_screen_share_stealth",
                "Hide from Screen Share",
                true,
                crate::commands::stealth_commands::stealth_enabled(),
                None::<&str>,
            )?),
            Separator => Box::new(PredefinedMenuItem::separator(app)?),
        });
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Build the idle-state tray menu.
pub fn build_idle_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    build(app, IDLE_MENU)
}

/// Build the meeting-active tray menu.
pub fn build_meeting_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    build(app, MEETING_MENU)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(layout: &[Entry]) -> Vec<&'static str> {
        layout
            .iter()
            .filter_map(|e| match e {
                Entry::Item(id, _) => Some(*id),
                Entry::ScreenShare => Some("toggle_screen_share_stealth"),
                Entry::Separator => None,
            })
            .collect()
    }

    #[test]
    fn the_dashboard_is_first_in_both_menus() {
        assert_eq!(ids(IDLE_MENU)[0], "open_dashboard");
        assert_eq!(&ids(MEETING_MENU)[..2], ["show_overlay", "open_dashboard"]);
    }

    #[test]
    fn both_menus_keep_settings_and_quit_last() {
        for layout in [IDLE_MENU, MEETING_MENU] {
            assert_eq!(ids(layout)[ids(layout).len() - 2..], ["settings", "quit"]);
        }
    }
}
