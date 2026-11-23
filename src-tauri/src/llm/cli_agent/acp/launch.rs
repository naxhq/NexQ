//! How NexQ starts Antigravity CLI: its arguments and where `agy` lives.

use std::path::{Path, PathBuf};

/// Antigravity CLI: `agy acp --disable-telemetry --sandbox`.
///
/// - `--disable-telemetry`: no usage reporting from a hidden session.
/// - `--sandbox`: "terminal restrictions enabled", a second wall behind the
///   permission policy (verified: reads and MCP calls still work).
///
/// `agy acp` has no flag that drops the user's own MCP servers, plugins or
/// rules (`agy mcp`/`agy plugin` manage them, the `--settings` flag exists only
/// on the main command), and no `--model` flag: the model is set with
/// `session/set_model` after `session/new`. A notes folder goes in
/// `session/new`'s `additionalDirectories` (advertised by the agent).
pub fn antigravity_args() -> Vec<String> {
    vec!["acp".into(), "--disable-telemetry".into(), "--sandbox".into()]
}

/// `%LOCALAPPDATA%\agy\bin\agy.exe` (where the installer puts it) under `local_app_data`.
pub fn agy_in_local_app_data(local_app_data: &Path) -> PathBuf {
    local_app_data.join("agy").join("bin").join("agy.exe")
}

/// Where `agy.exe` is: the installer's folder first, else the first real
/// `agy.exe` on `PATH` (`where.exe agy`). NexQ never spawns through a shell,
/// so only an `.exe` counts. Resolved on every spawn, so a fresh install is
/// picked up without restarting NexQ.
pub fn find_agy() -> Option<PathBuf> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let p = agy_in_local_app_data(Path::new(&local));
        if p.is_file() {
            return Some(p);
        }
    }
    #[cfg(windows)]
    let out = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("where.exe").arg("agy").creation_flags(0x0800_0000).output().ok()?
    };
    #[cfg(not(windows))]
    let out = std::process::Command::new("which").arg("agy").output().ok()?;
    first_exe(&String::from_utf8_lossy(&out.stdout))
}

/// The first line of `where agy` output that is an existing `.exe`.
pub fn first_exe(where_output: &str) -> Option<PathBuf> {
    where_output.lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from).find(|p| {
        p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("exe")) && p.is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_args_are_acp_without_telemetry() {
        assert_eq!(antigravity_args(), vec!["acp", "--disable-telemetry", "--sandbox"]);
    }

    #[test]
    fn the_installer_folder_is_under_local_app_data() {
        assert_eq!(
            agy_in_local_app_data(Path::new("C:\\Users\\a\\AppData\\Local")),
            PathBuf::from("C:\\Users\\a\\AppData\\Local").join("agy").join("bin").join("agy.exe")
        );
    }

    #[test]
    fn only_an_existing_exe_counts_from_where() {
        let dir = std::env::temp_dir().join(format!("nexq-agy-where-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("agy.exe");
        let shim = dir.join("agy.cmd");
        std::fs::write(&exe, "").unwrap();
        std::fs::write(&shim, "").unwrap();
        let out = format!("{}\r\n{}\r\n", shim.display(), exe.display());
        assert_eq!(first_exe(&out), Some(exe.clone()));
        assert_eq!(first_exe(&format!("{}\n", shim.display())), None);
        assert_eq!(first_exe(&format!("{}\\missing.exe\n", dir.display())), None);
        assert_eq!(first_exe(""), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
