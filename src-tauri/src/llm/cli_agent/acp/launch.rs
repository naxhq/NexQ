//! How NexQ starts Antigravity CLI: its arguments and where `agy` lives.

use super::super::detect::find_on_path;
use std::path::{Path, PathBuf};

/// NexQ's own Antigravity data folder, `%LOCALAPPDATA%\NexQ\agent-agy`
/// (`--gemini-dir`): sessions, the brain folder and settings of NexQ's sessions
/// live here, not in the user's `~/.gemini`, and none of the user's own MCP
/// servers, plugins, skills or rules in there are loaded. Checked with
/// `agy` 1.5.14: sign-in survives (it is kept outside that folder), the folder
/// is created by `agy`, and a user MCP server marker never started.
pub fn agy_home_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("NexQ").join("agent-agy")
}

/// Antigravity CLI: `agy acp --disable-telemetry --sandbox --gemini-dir <NexQ's folder>`.
///
/// - `--disable-telemetry`: no usage reporting from a hidden session.
/// - `--sandbox`: "terminal restrictions enabled", a second wall behind the
///   permission policy and the session's watch over tool calls.
/// - `--gemini-dir`: see [`agy_home_dir`].
///
/// `agy acp` has no `--model` flag: the model is set with `session/set_model`
/// after `session/new`. No folder of the user's is given to it: the cwd is an
/// empty NexQ folder and the notes come from the `nexq_notes` MCP server.
pub fn antigravity_args() -> Vec<String> {
    antigravity_args_in(&agy_home_dir())
}

/// [`antigravity_args`] for a given data folder.
pub fn antigravity_args_in(home: &Path) -> Vec<String> {
    vec![
        "acp".into(),
        "--disable-telemetry".into(),
        "--sandbox".into(),
        "--gemini-dir".into(),
        home.to_string_lossy().into_owned(),
    ]
}

/// `%LOCALAPPDATA%\agy\bin\agy.exe` (where the installer puts it) under `local_app_data`.
pub fn agy_in_local_app_data(local_app_data: &Path) -> PathBuf {
    local_app_data.join("agy").join("bin").join("agy.exe")
}

/// Where `agy.exe` is: the installer's folder first, else the first real
/// `agy.exe` on `PATH` (`find_on_path`). NexQ never spawns through a shell,
/// so only an `.exe` counts. Resolved on every spawn, so a fresh install is
/// picked up without restarting NexQ.
pub fn find_agy() -> Option<PathBuf> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let p = agy_in_local_app_data(Path::new(&local));
        if p.is_file() {
            return Some(p);
        }
    }
    first_exe(find_on_path("agy"))
}

/// The first of `candidates` that is an existing `.exe`.
pub fn first_exe(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| {
        p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("exe")) && p.is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_args_are_acp_without_telemetry() {
        let args = antigravity_args_in(Path::new("C:\\Data\\agent-agy"));
        assert_eq!(args, vec!["acp", "--disable-telemetry", "--sandbox", "--gemini-dir", "C:\\Data\\agent-agy"]);
        // NexQ's own folder, not the user's `.gemini`.
        let own = antigravity_args();
        assert!(own[4].ends_with("agent-agy") && !own[4].contains(".gemini"), "{own:?}");
    }

    #[test]
    fn the_installer_folder_is_under_local_app_data() {
        assert_eq!(
            agy_in_local_app_data(Path::new("C:\\Users\\a\\AppData\\Local")),
            PathBuf::from("C:\\Users\\a\\AppData\\Local").join("agy").join("bin").join("agy.exe")
        );
    }

    #[test]
    fn only_an_existing_exe_counts() {
        let dir = std::env::temp_dir().join(format!("nexq-agy-where-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("agy.exe");
        let shim = dir.join("agy.cmd");
        std::fs::write(&exe, "").unwrap();
        std::fs::write(&shim, "").unwrap();
        assert_eq!(first_exe(vec![shim.clone(), exe.clone()]), Some(exe.clone()));
        assert_eq!(first_exe(vec![shim]), None);
        assert_eq!(first_exe(vec![dir.join("missing.exe")]), None);
        assert_eq!(first_exe(Vec::new()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
