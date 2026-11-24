//! Locate the `claude` binary and query version/login state (no model calls).

use super::command::{configure_command, sandbox_dir};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// A Claude Code version, `(major, minor, patch)`. Tuples compare numerically.
pub type ClaudeVersion = (u32, u32, u32);

/// The oldest Claude Code NexQ can launch. It comes from `--permission-prompts`
/// (added in 2.1.259), which every session passes. The other flags are older:
/// `--restricted` needs 2.1.248 and `--safe-mode` 2.1.169, so this covers them.
pub const MIN_CLAUDE_VERSION: ClaudeVersion = (2, 1, 259);

/// `a.b.c` as text.
pub fn format_version(v: ClaudeVersion) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

/// The version in `claude --version` output (`2.1.330 (Claude Code)`): the
/// first word that starts with a digit, read as `major.minor.patch`. A suffix
/// after the patch number (`2.1.330-beta.1`) is ignored. `None` for anything else.
pub fn parse_claude_version(output: &str) -> Option<ClaudeVersion> {
    let word = output
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut parts = word.split('.');
    let number = |part: Option<&str>| -> Option<u32> {
        let digits: String = part?.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    };
    let major = number(parts.next())?;
    let minor = number(parts.next())?;
    let patch = number(parts.next())?;
    Some((major, minor, patch))
}

/// True when `v` is older than [`MIN_CLAUDE_VERSION`].
pub fn is_too_old(v: ClaudeVersion) -> bool {
    v < MIN_CLAUDE_VERSION
}

/// What a session, model list or connection test says instead of starting a
/// Claude Code that is too old. The phrase "is too old for NexQ" is what
/// `classify_error` reads as `Outdated`.
pub fn outdated_message(found: ClaudeVersion) -> String {
    format!(
        "Claude Code {} is too old for NexQ. Update it to {} or newer.",
        format_version(found),
        format_version(MIN_CLAUDE_VERSION)
    )
}

/// Why no usable Claude binary was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeBinaryError {
    NotFound,
    /// The chosen binary is older than [`MIN_CLAUDE_VERSION`]; the text is
    /// [`outdated_message`].
    TooOld(String),
}

/// [`find_claude_binary`], refusing a binary known to be too old. May run
/// `claude --version` once (cached), so call it from a blocking context.
pub fn find_current_claude() -> Result<PathBuf, ClaudeBinaryError> {
    let bin = find_claude_binary().ok_or(ClaudeBinaryError::NotFound)?;
    match claude_too_old(&bin) {
        Some(found) => Err(ClaudeBinaryError::TooOld(outdated_message(found))),
        None => Ok(bin),
    }
}

/// The version of `bin` when it is known and older than [`MIN_CLAUDE_VERSION`]
/// (cached, see [`claude_version_cached`]); `None` when it is new enough or unknown.
pub fn claude_too_old(bin: &Path) -> Option<ClaudeVersion> {
    claude_version_cached(bin).filter(|v| is_too_old(*v))
}

/// A Windows Store alias folder. `claude` there can be the Claude desktop app's
/// alias: running it would open a window, so it is never version-probed.
fn is_windows_apps(p: &Path) -> bool {
    p.to_string_lossy().replace('/', "\\").to_lowercase().contains("\\microsoft\\windowsapps\\")
}

/// Identity of a path for de-duplication (Windows paths ignore case and slash kind).
fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s.into_owned()
    }
}

/// Pick the Claude binary from `candidates` (preferred first; lazily read, so
/// a good first one never evaluates the rest). `version_of` gives a binary's
/// version, `None` when unknown.
///
/// - The first candidate wins when its version is at least [`MIN_CLAUDE_VERSION`]
///   or unknown: a good native install is used as before and no other
///   candidate is looked at.
/// - A later candidate wins only when its version is known and new enough.
/// - When none qualifies, the first one is returned (so the status can say it
///   is too old).
/// - A Windows Store alias is never looked up; it is only returned as the first
///   candidate.
fn select_claude(
    candidates: impl IntoIterator<Item = PathBuf>,
    mut version_of: impl FnMut(&Path) -> Option<ClaudeVersion>,
) -> Option<PathBuf> {
    let mut seen = HashSet::new();
    let mut first: Option<PathBuf> = None;
    for candidate in candidates {
        if !seen.insert(path_key(&candidate)) {
            continue;
        }
        if first.is_none() {
            first = Some(candidate.clone());
            if is_windows_apps(&candidate) || !version_of(&candidate).is_some_and(is_too_old) {
                return first;
            }
        } else if !is_windows_apps(&candidate) && version_of(&candidate).is_some_and(|v| !is_too_old(v)) {
            return Some(candidate);
        }
    }
    first
}

/// Find `claude`: the native installer location first, then PATH, taking the
/// first one that is new enough (see [`select_claude`]).
pub fn find_claude_binary() -> Option<PathBuf> {
    select_claude(claude_candidates(), claude_version_cached)
}

/// Native install location, then every `claude.exe` on PATH (PATH is only
/// searched when the iterator reaches it).
#[cfg(windows)]
fn claude_candidates() -> impl Iterator<Item = PathBuf> {
    let native = std::env::var_os("USERPROFILE")
        .map(|home| PathBuf::from(home).join(".local").join("bin").join("claude.exe"))
        .filter(|p| p.is_file());
    native
        .into_iter()
        .chain(std::iter::once(()).flat_map(|_| find_on_path("claude").into_iter().filter(|p| has_extension(p, "exe"))))
}

/// An npm install of Claude Code (`claude.cmd` on PATH). NexQ can't use it:
/// it spawns `claude.exe` directly, never through a shell.
#[cfg(windows)]
pub fn find_npm_claude() -> Option<PathBuf> {
    find_on_path("claude").into_iter().find(|p| has_extension(p, "cmd"))
}

#[cfg(windows)]
fn has_extension(p: &Path, ext: &str) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// Every program `name` on PATH, in order (see [`find_on_path_in`]). Read here
/// rather than from `where.exe` / `which`: no process to resolve, and
/// `where.exe` looks in the current directory first.
pub(super) fn find_on_path(name: &str) -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|path| find_on_path_in(&path, name)).unwrap_or_default()
}

/// [`find_on_path`] for a given `PATH`. On Windows the `.exe` and the `.cmd` of
/// each folder, elsewhere the executable file. Empty and relative entries are
/// skipped: they name a folder under the current directory, where anyone could
/// have left a program of the same name.
fn find_on_path_in(path: &std::ffi::OsStr, name: &str) -> Vec<PathBuf> {
    let dirs = std::env::split_paths(path).filter(|dir| dir.is_absolute());
    #[cfg(windows)]
    let found = dirs
        .flat_map(|dir| ["exe", "cmd"].map(|ext| dir.join(format!("{name}.{ext}"))))
        // Not `is_file`: a Windows Store alias is a link that can't be followed.
        .filter(|p| std::fs::symlink_metadata(p).is_ok_and(|m| !m.is_dir()));
    #[cfg(unix)]
    let found = dirs.map(|dir| dir.join(name)).filter(|p| is_executable_file(p));
    found.collect()
}

/// The native installer location (`~/.local/bin/claude`, used by
/// `curl -fsSL https://claude.ai/install.sh | bash`), then every executable
/// `claude` on PATH.
#[cfg(unix)]
fn claude_candidates() -> impl Iterator<Item = PathBuf> {
    claude_candidates_in(std::env::var_os("HOME").as_deref(), std::env::var_os("PATH").as_deref()).into_iter()
}

/// [`claude_candidates`] for a given `HOME` and `PATH`.
#[cfg(unix)]
fn claude_candidates_in(home: Option<&std::ffi::OsStr>, path: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let native = home
        .map(|home| Path::new(home).join(".local").join("bin").join("claude"))
        .filter(|p| is_executable_file(p));
    let on_path = path.map(|path| find_on_path_in(path, "claude")).unwrap_or_default();
    native.into_iter().chain(on_path).collect()
}

/// Unix has no npm-vs-native distinction: any `claude` found via PATH or the
/// native installer location is directly spawnable, no shell needed.
#[cfg(unix)]
pub fn find_npm_claude() -> Option<PathBuf> {
    None
}

/// A regular file with at least one executable bit set.
#[cfg(unix)]
fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// How long the synchronous `--version` probe of the selection may run.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// `(canonical path, modified time, length)` of a binary: an in-place update
/// changes the last two, so it is noticed.
type VersionKey = (PathBuf, Option<SystemTime>, u64);
type VersionCache = Mutex<HashMap<VersionKey, ClaudeVersion>>;

fn version_key(bin: &Path) -> Option<VersionKey> {
    let meta = std::fs::metadata(bin).ok()?;
    let path = std::fs::canonicalize(bin).unwrap_or_else(|_| bin.to_path_buf());
    Some((path, meta.modified().ok(), meta.len()))
}

/// `probe(bin)` unless `cache` already holds that file's version. Failures
/// (`None`) are not cached, so a timeout is tried again next time.
fn version_with_cache(
    cache: &VersionCache,
    bin: &Path,
    probe: impl FnOnce(&Path) -> Option<ClaudeVersion>,
) -> Option<ClaudeVersion> {
    let key = version_key(bin);
    if let Some(found) = key.as_ref().and_then(|k| cache.lock().ok()?.get(k).copied()) {
        return Some(found);
    }
    let found = probe(bin)?;
    if let (Some(key), Ok(mut map)) = (key, cache.lock()) {
        map.insert(key, found);
    }
    Some(found)
}

/// The version of `bin`, from a process-wide cache or one `claude --version`
/// run (synchronous, 5 s limit; callers already run on a blocking thread). A
/// Windows Store alias is never run: its version is unknown.
pub fn claude_version_cached(bin: &Path) -> Option<ClaudeVersion> {
    static CACHE: OnceLock<VersionCache> = OnceLock::new();
    if is_windows_apps(bin) {
        return None;
    }
    version_with_cache(CACHE.get_or_init(Default::default), bin, |b| probe_version_blocking(b, VERSION_PROBE_TIMEOUT))
}

/// Run `bin --version` with the session's hygiene (no console window, sandbox
/// cwd, API-key env stripped, stdin closed) and read the version. The child is
/// killed after `timeout`; its output is read on a thread so a full pipe can't
/// block it.
fn probe_version_blocking(bin: &Path, timeout: Duration) -> Option<ClaudeVersion> {
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--version");
    configure_command(&mut cmd, &sandbox_dir());
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let bytes = rx.recv_timeout(Duration::from_secs(1)).ok()?;
    parse_claude_version(&String::from_utf8_lossy(&bytes))
}

/// How a Claude login is billed. Only a claude.ai login with a plan uses
/// the subscription; any other login (Console / API key) bills an API
/// account.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeLogin {
    #[default]
    LoggedOut,
    Subscription,
    ApiBilled,
}

/// Shown wherever an API-billed login would otherwise read as connected.
pub const API_BILLED_NOTE: &str = "This Claude login bills an API account, not your subscription.";

/// Classify a `claude auth status` result (see [`ClaudeLogin`]).
pub fn classify_login(logged_in: bool, auth_method: &str, subscription_type: Option<&str>) -> ClaudeLogin {
    if !logged_in {
        ClaudeLogin::LoggedOut
    } else if auth_method == "claude.ai" && subscription_type.is_some() {
        ClaudeLogin::Subscription
    } else {
        ClaudeLogin::ApiBilled
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeAuthStatus {
    pub logged_in: bool,
    pub auth_method: String,
    pub subscription_type: Option<String>,
    pub email: Option<String>,
    /// How this login is billed (derived from the fields above).
    #[serde(default)]
    pub login: ClaudeLogin,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuth {
    #[serde(default)]
    logged_in: bool,
    #[serde(default)]
    auth_method: Option<String>,
    #[serde(default)]
    subscription_type: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

/// Parse the JSON printed by `claude auth status`.
pub fn parse_auth_status(json: &str) -> Result<ClaudeAuthStatus, String> {
    let raw: RawAuth =
        serde_json::from_str(json.trim()).map_err(|e| format!("invalid auth status JSON: {e}"))?;
    let auth_method = raw.auth_method.unwrap_or_default();
    let login = classify_login(raw.logged_in, &auth_method, raw.subscription_type.as_deref());
    Ok(ClaudeAuthStatus {
        logged_in: raw.logged_in,
        auth_method,
        subscription_type: raw.subscription_type,
        email: raw.email,
        login,
    })
}

/// Run `claude --version` and `claude auth status` (10 s timeout each, no
/// console window, API-key env stripped). `auth status` exits 1 when logged
/// out but still prints JSON, so a non-zero exit is not an error by itself.
pub async fn claude_status(bin: &Path) -> Result<(String, ClaudeAuthStatus), String> {
    let version = claude_version(bin).await?;
    let status = claude_auth_status(bin).await?;
    Ok((version, status))
}

/// `claude --version`, trimmed.
pub async fn claude_version(bin: &Path) -> Result<String, String> {
    Ok(run_probe(bin, &["--version"]).await?.trim().to_string())
}

/// `claude auth status`, parsed.
pub async fn claude_auth_status(bin: &Path) -> Result<ClaudeAuthStatus, String> {
    parse_auth_status(&run_probe(bin, &["auth", "status"]).await?)
}

async fn run_probe(bin: &Path, args: &[&str]) -> Result<String, String> {
    let label = args.join(" ");
    let mut std_cmd = std::process::Command::new(bin);
    std_cmd.args(args);
    configure_command(&mut std_cmd, &sandbox_dir());
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("`claude {label}` timed out after 10 s"))?
        .map_err(|e| format!("failed to run `claude {label}`: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stdout.trim().is_empty() && !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("`claude {label}` failed: {}", stderr.trim()));
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_status_parses_logged_in() {
        let s = parse_auth_status(
            r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"a@b"}"#,
        )
        .unwrap();
        assert!(s.logged_in);
        assert_eq!(s.auth_method, "claude.ai");
        assert_eq!(s.subscription_type.as_deref(), Some("max"));
        assert_eq!(s.email.as_deref(), Some("a@b"));
        assert_eq!(s.login, ClaudeLogin::Subscription);
    }

    #[test]
    fn only_a_claude_ai_login_with_a_plan_uses_the_subscription() {
        assert_eq!(classify_login(true, "claude.ai", Some("pro")), ClaudeLogin::Subscription);
        assert_eq!(classify_login(true, "claude.ai", None), ClaudeLogin::ApiBilled);
        assert_eq!(classify_login(true, "api_key", None), ClaudeLogin::ApiBilled);
        assert_eq!(classify_login(true, "console", Some("max")), ClaudeLogin::ApiBilled);
        assert_eq!(classify_login(false, "claude.ai", Some("max")), ClaudeLogin::LoggedOut);
        let s = parse_auth_status(r#"{"loggedIn":true,"authMethod":"api_key"}"#).unwrap();
        assert_eq!(s.login, ClaudeLogin::ApiBilled);
    }

    #[test]
    fn auth_status_parses_logged_out_and_rejects_garbage() {
        let s = parse_auth_status(r#"{"loggedIn":false}"#).unwrap();
        assert!(!s.logged_in);
        assert_eq!(s.subscription_type, None);
        assert_eq!(s.login, ClaudeLogin::LoggedOut);
        assert!(parse_auth_status("nope").is_err());
    }

    /// A fresh directory for one test. Tests pass `HOME`/`PATH` explicitly:
    /// changing the process environment would race the tests running beside them.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexq-detect-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A `claude` script in `dir` with permission bits `mode`.
    #[cfg(unix)]
    fn claude_script(dir: &Path, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(mode)).unwrap();
        bin
    }

    #[cfg(unix)]
    #[test]
    fn finds_the_first_executable_claude_on_path() {
        let root = temp_dir("path");
        let plain = claude_script(&root.join("a"), 0o644);
        let exe = claude_script(&root.join("b"), 0o755);
        let path = std::env::join_paths([plain.parent().unwrap(), exe.parent().unwrap()]).unwrap();
        assert_eq!(claude_candidates_in(None, Some(path.as_os_str())), vec![exe]);
        assert!(claude_candidates_in(None, None).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn native_installer_location_takes_priority_over_path() {
        let root = temp_dir("home");
        let native = claude_script(&root.join("home").join(".local").join("bin"), 0o755);
        let on_path = claude_script(&root.join("bin"), 0o755);
        let home = root.join("home");
        let found = claude_candidates_in(Some(home.as_os_str()), Some(on_path.parent().unwrap().as_os_str()));
        assert_eq!(found, vec![native, on_path]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn programs_are_found_on_path_in_order() {
        let root = temp_dir("find");
        for (dir, file) in [("a", "tool"), ("a", "tool.cmd"), ("b", "tool.cmd"), ("b", "tool.EXE"), ("c", "other.exe")] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join(file), "x").unwrap();
        }
        std::fs::create_dir_all(root.join("c").join("tool.exe")).unwrap();
        let path = std::env::join_paths([root.join("a"), root.join("b"), root.join("c"), root.join("missing")]).unwrap();
        // npm's extensionless script and a folder of that name don't count.
        assert_eq!(
            find_on_path_in(&path, "tool"),
            [root.join("a").join("tool.cmd"), root.join("b").join("tool.exe"), root.join("b").join("tool.cmd")]
        );
        assert!(find_on_path_in(&path, "absent").is_empty());
        assert!(find_on_path_in(std::ffi::OsStr::new(""), "tool").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The manifest folder is the current directory of a test run.
    #[test]
    fn the_current_directory_is_never_searched() {
        let dir = PathBuf::from("target").join(format!("nexq-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(if cfg!(windows) { "nexqtool.exe" } else { "nexqtool" });
        std::fs::write(&file, "x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // Found by its full path, so the file is really there to be found.
        let absolute = std::env::current_dir().unwrap().join(&dir);
        let full = std::env::join_paths([absolute.clone()]).unwrap();
        assert_eq!(find_on_path_in(&full, "nexqtool").len(), 1);
        // Not through a relative or an empty entry.
        let relative = std::env::join_paths([dir.as_path(), Path::new("."), Path::new("")]).unwrap();
        assert!(find_on_path_in(&relative, "nexqtool").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_versions_are_parsed_and_compared_numerically() {
        assert_eq!(parse_claude_version("2.1.330 (Claude Code)\n"), Some((2, 1, 330)));
        assert_eq!(parse_claude_version("\r\n  2.1.206 (Claude Code)"), Some((2, 1, 206)));
        assert_eq!(parse_claude_version("2.1.330-beta.1 (Claude Code)"), Some((2, 1, 330)));
        assert_eq!(parse_claude_version("2.1.330+abc"), Some((2, 1, 330)));
        assert_eq!(parse_claude_version("claude 2.2.0"), Some((2, 2, 0)));
        for garbage in ["", "nope", "2.1", "2.x.3", "Claude Code", "\n\n"] {
            assert_eq!(parse_claude_version(garbage), None, "{garbage:?}");
        }
        assert!(is_too_old((2, 1, 99)), "99 is below 259, not above it as text");
        assert!(is_too_old((2, 1, 206)));
        assert!(is_too_old((1, 9, 999)));
        assert!(!is_too_old((2, 1, 259)));
        assert!(!is_too_old((2, 2, 0)));
        assert!(!is_too_old((3, 0, 0)));
        assert_eq!(format_version(MIN_CLAUDE_VERSION), "2.1.259");
    }

    #[test]
    fn the_refusal_names_both_versions_and_reads_as_outdated() {
        use crate::llm::cli_agent::protocol::{classify_error, AgentErrorKind};
        let message = outdated_message((2, 1, 206));
        assert_eq!(message, "Claude Code 2.1.206 is too old for NexQ. Update it to 2.1.259 or newer.");
        assert_eq!(classify_error(&message), AgentErrorKind::Outdated);
    }

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    /// Selection over fake versions, recording which candidates were looked up.
    fn select(list: &[&str], versions: &[(&str, ClaudeVersion)]) -> (Option<PathBuf>, Vec<String>) {
        let mut asked = Vec::new();
        let found = select_claude(paths(list), |p| {
            let name = p.to_string_lossy().into_owned();
            asked.push(name.clone());
            versions.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
        });
        (found, asked)
    }

    const OLD: ClaudeVersion = (2, 1, 206);
    const NEW: ClaudeVersion = (2, 1, 330);

    #[test]
    fn a_good_first_candidate_is_used_and_nothing_else_is_looked_up() {
        let (found, asked) = select(&["a", "b", "c"], &[("a", NEW), ("b", NEW)]);
        assert_eq!(found, Some(PathBuf::from("a")));
        assert_eq!(asked, ["a"]);
        // Exactly the minimum is good.
        let (found, asked) = select(&["a", "b"], &[("a", MIN_CLAUDE_VERSION)]);
        assert_eq!((found, asked), (Some(PathBuf::from("a")), vec!["a".to_string()]));
    }

    #[test]
    fn an_unknown_first_candidate_is_kept() {
        let (found, asked) = select(&["a", "b"], &[("b", NEW)]);
        assert_eq!(found, Some(PathBuf::from("a")));
        assert_eq!(asked, ["a"]);
    }

    #[test]
    fn an_old_first_candidate_gives_way_to_a_newer_one() {
        let (found, asked) = select(&["a", "b", "c"], &[("a", OLD), ("b", OLD), ("c", NEW)]);
        assert_eq!(found, Some(PathBuf::from("c")));
        assert_eq!(asked, ["a", "b", "c"]);
        // The first good one wins; later ones are not looked at.
        let (found, asked) = select(&["a", "b", "c"], &[("a", OLD), ("b", NEW), ("c", NEW)]);
        assert_eq!((found, asked), (Some(PathBuf::from("b")), vec!["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn when_every_candidate_is_old_or_unknown_the_first_is_returned() {
        let (found, _) = select(&["a", "b"], &[("a", OLD), ("b", OLD)]);
        assert_eq!(found, Some(PathBuf::from("a")));
        // A later candidate of unknown version is never picked over an old first.
        let (found, _) = select(&["a", "b"], &[("a", OLD)]);
        assert_eq!(found, Some(PathBuf::from("a")));
        assert_eq!(select(&[], &[]).0, None);
    }

    #[test]
    fn duplicates_are_looked_up_once() {
        let (found, asked) = select(&["a", "a", "b", "b"], &[("a", OLD), ("b", NEW)]);
        assert_eq!(found, Some(PathBuf::from("b")));
        assert_eq!(asked, ["a", "b"]);
    }

    #[cfg(windows)]
    #[test]
    fn duplicates_ignore_case_and_slash_kind_on_windows() {
        let (_, asked) = select(&["C:\\Bin\\claude.exe", "c:/bin/CLAUDE.exe"], &[("C:\\Bin\\claude.exe", OLD)]);
        assert_eq!(asked.len(), 1);
    }

    #[test]
    fn a_windows_store_alias_is_never_looked_up() {
        let alias = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe";
        assert!(is_windows_apps(Path::new(alias)));
        assert!(is_windows_apps(Path::new("c:/users/u/appdata/local/MICROSOFT/windowsapps/claude.exe")));
        assert!(!is_windows_apps(Path::new("C:\\Users\\u\\.local\\bin\\claude.exe")));
        // Later candidate: skipped, even though it would be new.
        let (found, asked) = select(&["a", alias, "c"], &[("a", OLD), (alias, NEW), ("c", NEW)]);
        assert_eq!(found, Some(PathBuf::from("c")));
        assert_eq!(asked, ["a", "c"]);
        // Only candidate: returned, not looked up.
        let (found, asked) = select(&[alias], &[(alias, OLD)]);
        assert_eq!(found, Some(PathBuf::from(alias)));
        assert!(asked.is_empty());
        // First candidate: returned unprobed, the rest untouched.
        let (found, asked) = select(&[alias, "b"], &[("b", NEW)]);
        assert_eq!(found, Some(PathBuf::from(alias)));
        assert!(asked.is_empty());
        // Never run by the cached lookup either.
        assert_eq!(claude_version_cached(Path::new(alias)), None);
    }

    #[test]
    fn later_candidates_are_not_even_read_when_the_first_is_good() {
        let pulled = std::cell::Cell::new(0);
        let lazy = ["a", "b"].into_iter().map(|p| {
            pulled.set(pulled.get() + 1);
            PathBuf::from(p)
        });
        let found = select_claude(lazy, |_| Some(NEW));
        assert_eq!(found, Some(PathBuf::from("a")));
        assert_eq!(pulled.get(), 1, "the PATH scan stays unrun");
    }

    #[test]
    fn a_version_is_probed_once_per_file_and_again_after_it_changes() {
        let dir = std::env::temp_dir().join(format!("nexq-version-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude.exe");
        std::fs::write(&bin, "one").unwrap();
        let cache = VersionCache::default();
        let probes = std::cell::Cell::new(0);
        let probe = |v: Option<ClaudeVersion>| {
            let probes = &probes;
            move |_: &Path| {
                probes.set(probes.get() + 1);
                v
            }
        };
        assert_eq!(version_with_cache(&cache, &bin, probe(Some(OLD))), Some(OLD));
        assert_eq!(version_with_cache(&cache, &bin, probe(Some(NEW))), Some(OLD), "cached");
        assert_eq!(probes.get(), 1);
        // An in-place update changes the length (and the time).
        std::fs::write(&bin, "a longer file").unwrap();
        assert_eq!(version_with_cache(&cache, &bin, probe(Some(NEW))), Some(NEW));
        assert_eq!(probes.get(), 2);
        assert_eq!(version_with_cache(&cache, &bin, probe(None)), Some(NEW));
        assert_eq!(probes.get(), 2);
        // A failed probe is not cached: the next call asks again.
        let other = dir.join("other.exe");
        std::fs::write(&other, "x").unwrap();
        assert_eq!(version_with_cache(&cache, &other, probe(None)), None);
        assert_eq!(version_with_cache(&cache, &other, probe(Some(NEW))), Some(NEW));
        assert_eq!(probes.get(), 4);
        // A missing file is probed and never cached.
        let gone = dir.join("gone.exe");
        assert_eq!(version_with_cache(&cache, &gone, probe(Some(NEW))), Some(NEW));
        assert_eq!(version_with_cache(&cache, &gone, probe(Some(NEW))), Some(NEW));
        assert_eq!(probes.get(), 6);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
