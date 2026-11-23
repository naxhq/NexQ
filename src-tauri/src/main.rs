#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `nexq.exe --notes-mcp`: the read-only notes server that the Antigravity
    // and Codex sessions start. Decided before anything else, so it never
    // reaches the single-instance hand-off, a window or the tray.
    if nexq_lib::notes_mcp::is_notes_mode(std::env::args_os()) {
        std::process::exit(nexq_lib::notes_mcp::run_stdio());
    }
    nexq_lib::run()
}
