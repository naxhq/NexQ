//! Where NexQ keeps its files, from one place. The folder comes from the
//! app's own identifier, so a build with another identifier (a test build)
//! never writes into the real app's folders; for the real identifier every
//! path is exactly where it always was.
//!
//! Set once at start from the Tauri identifier ([`init`]). Unit tests get a
//! private temporary folder, so a test can never touch the real ones.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The identifier of the real app (`tauri.conf.json`).
pub const DEFAULT_IDENTIFIER: &str = "com.nexq.app";

struct Resolved {
    /// Tauri's app data folder for this identifier.
    data_dir: PathBuf,
    identifier: String,
}

static RESOLVED: OnceLock<Resolved> = OnceLock::new();

/// Tauri's app data folder for `identifier`, from the environment (the same
/// folder `app_data_dir()` gives once the app runs).
pub fn data_dir_for(identifier: &str) -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    };
    base.unwrap_or_else(std::env::temp_dir).join(identifier)
}

/// Remember this run's identifier and data folder. The first call wins.
pub fn init(data_dir: PathBuf, identifier: &str) {
    let _ = RESOLVED.set(Resolved { data_dir, identifier: identifier.to_string() });
}

/// The identifier this run was set up with (the real one before [`init`]).
pub fn identifier() -> &'static str {
    RESOLVED.get().map(|r| r.identifier.as_str()).unwrap_or(DEFAULT_IDENTIFIER)
}

fn set() -> Option<(&'static Path, &'static str)> {
    RESOLVED.get().map(|r| (r.data_dir.as_path(), r.identifier.as_str()))
}

/// The app's data folder (the one holding `nexq.db`). In unit tests, a private
/// temporary folder.
pub fn data_dir() -> PathBuf {
    if cfg!(test) {
        return test_root().join("data");
    }
    RESOLVED.get().map(|r| r.data_dir.clone()).unwrap_or_else(|| data_dir_for(DEFAULT_IDENTIFIER))
}

/// Where the recordings go (`.../recordings`).
pub fn recordings_dir() -> PathBuf {
    recordings_impl(set(), &Env::current(), cfg!(test))
}

/// Where the copied context documents go (`.../context`).
pub fn context_dir() -> PathBuf {
    context_impl(set(), &Env::current(), cfg!(test))
}

/// The folder NexQ's private session folders live in: `%LOCALAPPDATA%\NexQ`
/// for the real app (unchanged), `...\NexQ\<identifier>` for any other
/// identifier, so two builds never share (or clean up) each other's folders.
pub fn local_root() -> PathBuf {
    local_root_impl(identifier(), &Env::current(), cfg!(test))
}

/// The environment the paths come from.
pub struct Env {
    pub appdata: Option<PathBuf>,
    pub localappdata: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

impl Env {
    fn current() -> Self {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        Self { appdata: var("APPDATA"), localappdata: var("LOCALAPPDATA"), home: var("HOME").or_else(|| var("USERPROFILE")) }
    }
}

/// A private folder for this unit-test process.
fn test_root() -> PathBuf {
    std::env::temp_dir().join(format!("nexq-test-{}", std::process::id()))
}

/// The recordings folder. The real identifier: where the recorder has always
/// put it. Another identifier: inside that run's own data folder. `isolate`
/// (unit tests): a private temporary folder whatever the identifier.
pub fn recordings_impl(set: Option<(&Path, &str)>, env: &Env, isolate: bool) -> PathBuf {
    match set {
        _ if isolate => test_root().join("recordings"),
        Some((data, id)) if id != DEFAULT_IDENTIFIER => data.join("recordings"),
        _ => {
            let base = env
                .appdata
                .clone()
                .or_else(|| env.home.clone().map(|h| h.join(".config")))
                .or_else(|| env.localappdata.clone())
                .unwrap_or_else(std::env::temp_dir);
            base.join(DEFAULT_IDENTIFIER).join("recordings")
        }
    }
}

/// The context folder: under `APPDATA` for the real identifier (`~/.nexq`
/// without it), like [`recordings_impl`] otherwise.
pub fn context_impl(set: Option<(&Path, &str)>, env: &Env, isolate: bool) -> PathBuf {
    match set {
        _ if isolate => test_root().join("context"),
        Some((data, id)) if id != DEFAULT_IDENTIFIER => data.join("context"),
        _ => match &env.appdata {
            Some(appdata) => appdata.join(DEFAULT_IDENTIFIER).join("context"),
            None => env.home.clone().unwrap_or_else(|| PathBuf::from(".")).join(".nexq").join("context"),
        },
    }
}

/// See [`local_root`].
pub fn local_root_impl(identifier: &str, env: &Env, isolate: bool) -> PathBuf {
    if isolate {
        return test_root().join("local");
    }
    let base = env.localappdata.clone().unwrap_or_else(std::env::temp_dir).join("NexQ");
    if identifier == DEFAULT_IDENTIFIER { base } else { base.join(identifier) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        Env {
            appdata: Some(PathBuf::from("R")),
            localappdata: Some(PathBuf::from("L")),
            home: Some(PathBuf::from("H")),
        }
    }

    #[test]
    fn another_identifier_never_uses_the_real_apps_folders() {
        let data = PathBuf::from("R").join("com.nexq.test");
        let set = Some((data.as_path(), "com.nexq.test"));
        assert_eq!(recordings_impl(set, &env(), false), data.join("recordings"));
        assert_eq!(context_impl(set, &env(), false), data.join("context"));
        assert_eq!(local_root_impl("com.nexq.test", &env(), false), PathBuf::from("L").join("NexQ").join("com.nexq.test"));
        // Not before init either, once the identifier is known to be another one.
        assert_ne!(recordings_impl(set, &env(), false), recordings_impl(None, &env(), false));
    }

    #[test]
    fn the_real_identifier_keeps_the_paths_it_always_had() {
        let e = env();
        let data = PathBuf::from("R").join("com.nexq.app");
        let real = Some((data.as_path(), DEFAULT_IDENTIFIER));
        assert_eq!(recordings_impl(real, &e, false), PathBuf::from("R").join("com.nexq.app").join("recordings"));
        assert_eq!(recordings_impl(None, &e, false), recordings_impl(real, &e, false));
        assert_eq!(context_impl(real, &e, false), PathBuf::from("R").join("com.nexq.app").join("context"));
        assert_eq!(local_root_impl(DEFAULT_IDENTIFIER, &e, false), PathBuf::from("L").join("NexQ"));
        // Without APPDATA: where they always went.
        let none = Env { appdata: None, localappdata: Some(PathBuf::from("L")), home: Some(PathBuf::from("H")) };
        assert_eq!(recordings_impl(None, &none, false), PathBuf::from("H").join(".config").join("com.nexq.app").join("recordings"));
        assert_eq!(context_impl(None, &none, false), PathBuf::from("H").join(".nexq").join("context"));
        // Tauri's own folder is the same one on Windows.
        if cfg!(windows) {
            if let Some(appdata) = std::env::var_os("APPDATA") {
                assert_eq!(data_dir_for(DEFAULT_IDENTIFIER), PathBuf::from(appdata).join(DEFAULT_IDENTIFIER));
            }
        }
    }

    #[test]
    fn a_unit_test_never_reaches_the_real_folders_even_with_the_real_identifier() {
        let data = PathBuf::from("R").join("com.nexq.app");
        let real = Some((data.as_path(), DEFAULT_IDENTIFIER));
        for path in [recordings_impl(real, &env(), true), context_impl(None, &env(), true), local_root_impl(DEFAULT_IDENTIFIER, &env(), true)] {
            assert!(path.starts_with(std::env::temp_dir()), "{path:?}");
            assert!(!path.to_string_lossy().contains("com.nexq.app"), "{path:?}");
        }
        // And the functions the app calls are those isolated ones under cargo test.
        for path in [recordings_dir(), context_dir(), local_root()] {
            assert!(path.starts_with(std::env::temp_dir()), "{path:?}");
        }
    }
}
