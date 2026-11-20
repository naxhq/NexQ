//! Why an MCP server did not start. The CLI only reports `failed`, so a failed
//! Check starts the server on its own for a few seconds and reports what it
//! says: the last stderr line of a command that stopped, or the HTTP status a
//! URL answered with. Secret values never appear in the text.

use crate::sources::config::{McpServer, McpTransport};
use crate::sources::mcp_json::{credential_id, header_credential_id};
use super::command::{configure_command, sandbox_dir};
use super::process_tree::ProcessTree;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long a failed server is started on its own to find out why.
pub const DIAGNOSE_WAIT: Duration = Duration::from_secs(5);

/// The longest a whole diagnosis may take: the wait itself plus ending the
/// server and reading its last words.
pub const DIAGNOSE_LIMIT: Duration = Duration::from_secs(DIAGNOSE_WAIT.as_secs() + 3);

/// Why `server` won't start, or `None` when the attempt shows nothing (or took
/// longer than [`DIAGNOSE_LIMIT`]). `secret` looks a saved value up by
/// credential id.
pub async fn diagnose_start(
    server: &McpServer,
    secret: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Option<String> {
    tokio::time::timeout(DIAGNOSE_LIMIT, diagnose_inner(server, secret)).await.ok().flatten()
}

async fn diagnose_inner(
    server: &McpServer,
    secret: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Option<String> {
    match &server.transport {
        McpTransport::Stdio { command, args } => {
            let mut env: Vec<(String, String)> = Vec::new();
            let mut secrets: Vec<String> = Vec::new();
            for var in &server.env {
                let value = if var.secret {
                    let value = secret(&credential_id(&server.key, &var.name))?;
                    secrets.push(value.clone());
                    value
                } else {
                    var.value.clone().unwrap_or_default()
                };
                env.push((var.name.clone(), value));
            }
            let (command, args) = (command.clone(), args.clone());
            tokio::task::spawn_blocking(move || diagnose_stdio(&command, &args, &env, &secrets, DIAGNOSE_WAIT))
                .await
                .ok()
                .flatten()
        }
        McpTransport::Http { url, header_names } => {
            let mut headers: Vec<(String, String)> = Vec::new();
            for name in header_names {
                headers.push((name.clone(), secret(&header_credential_id(&server.key, name))?));
            }
            let secrets: Vec<String> = headers.iter().map(|(_, v)| v.clone()).collect();
            diagnose_http(url, &headers, &secrets).await
        }
    }
}

/// The last non-empty line of `text`, with every secret value hidden and cut
/// to a short length.
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets.iter().filter(|s| s.len() >= 3) {
        out = out.replace(secret.as_str(), "***");
    }
    let line = out.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() > 200 {
        let mut cut: String = line.chars().take(200).collect();
        cut.push('…');
        cut
    } else {
        line.to_string()
    }
}

/// How long the last stderr lines are waited for once the server has ended.
const STDERR_GRACE: Duration = Duration::from_secs(1);

/// The program to run for `command`, found the way the CLI finds it. Rust's
/// `Command` adds only `.exe`, so `npx` or `uvx` (shims named `npx.cmd`,
/// `uvx.cmd`) would not start; the CLI resolves them through `PATHEXT`. A name
/// with an extension, or one nothing matches, is returned unchanged. `path` is
/// the `PATH` to search (`None`: this process's).
pub fn resolve_command(command: &str, path: Option<&std::ffi::OsStr>) -> PathBuf {
    if !cfg!(windows) || Path::new(command).extension().is_some() {
        return PathBuf::from(command);
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<&str> = exts.split(';').filter(|e| !e.is_empty()).collect();
    let dirs: Vec<PathBuf> = if command.contains(['\\', '/']) {
        vec![PathBuf::new()]
    } else {
        let own = std::env::var_os("PATH");
        std::env::split_paths(path.or(own.as_deref()).unwrap_or_default()).collect()
    };
    for dir in dirs {
        for ext in &exts {
            let candidate = dir.join(format!("{command}{ext}"));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from(command)
}

/// Start the command like the CLI would (same folder and environment as a
/// session, shims found through `PATHEXT`) and wait up to `wait`. `Some(cause)`
/// when it could not be started, stopped by itself, or is still running but
/// printed a message; `None` when it ran quietly. Whatever it started is ended
/// too, and nothing here can wait on it for long: stderr is read through a
/// channel with a short cap.
pub fn diagnose_stdio(
    command: &str,
    args: &[String],
    env: &[(String, String)],
    secrets: &[String],
    wait: Duration,
) -> Option<String> {
    let path = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| std::ffi::OsString::from(v));
    let mut cmd = Command::new(resolve_command(command, path.as_deref()));
    configure_command(&mut cmd, &sandbox_dir());
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Some(redact(&format!("It couldn't start {command}: {e}."), secrets)),
    };
    let mut tree = Some(ProcessTree::adopt(&child));
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(stderr) = child.stderr.take() {
        // Ends when every holder of the pipe is gone; never joined.
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    let stdin = child.stdin.take(); // kept open while waiting: a server exits when it reads EOF
    let deadline = Instant::now() + wait;
    let exited = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => break None,
        }
    };
    drop(stdin);
    let mut lines: Vec<String> = Vec::new();
    if exited.is_none() {
        if let Some(tree) = tree.take() {
            tree.kill(&mut child);
        }
    }
    let grace = Instant::now() + STDERR_GRACE;
    while let Some(left) = grace.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(line) => lines.push(line),
            Err(_) => break, // pipe closed, or the grace is over
        }
    }
    drop(tree); // a server that stopped by itself: ends what it left behind
    let last = lines.iter().rev().find(|l| !l.trim().is_empty()).map(|l| redact(l, secrets));
    match (exited, last) {
        (Some(status), Some(line)) => {
            Some(format!("It stopped right away{}. Its last message: {line}", code_text(status)))
        }
        (Some(status), None) => Some(format!("It stopped right away{}, without saying why.", code_text(status))),
        (None, Some(line)) => Some(format!("Its last message: {line}")),
        (None, None) => None,
    }
}

fn code_text(status: std::process::ExitStatus) -> String {
    status.code().map(|c| format!(" (exit code {c})")).unwrap_or_default()
}

/// Ask the URL what an MCP client asks first and report a refusal.
pub async fn diagnose_http(url: &str, headers: &[(String, String)], secrets: &[String]) -> Option<String> {
    let client = reqwest::Client::builder().timeout(DIAGNOSE_WAIT).build().ok()?;
    let mut req = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {},
                        "clientInfo": { "name": "nexq-check", "version": "1" } }
        }));
    for (name, value) in headers {
        req = req.header(name.as_str(), value.as_str());
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => None,
        Ok(resp) => {
            let status = resp.status();
            let reason = status.canonical_reason().map(|r| format!(" {r}")).unwrap_or_default();
            Some(format!("The server answered {}{reason}.", status.as_u16()))
        }
        Err(e) => {
            let e = e.without_url();
            let mut text = e.to_string();
            let mut source = std::error::Error::source(&e);
            while let Some(inner) = source {
                text = format!("{text}: {inner}");
                source = inner.source();
            }
            Some(redact(&format!("It couldn't be reached: {text}"), secrets))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_hides_secrets_and_keeps_one_short_line() {
        let secrets = vec!["s3cret-value".to_string(), "ab".to_string()];
        assert_eq!(redact("error: bad key s3cret-value\n", &secrets), "error: bad key ***");
        assert_eq!(redact("first\n\nlast line ab\n", &secrets), "last line ab", "values under 3 chars are left alone");
        let long = "x".repeat(500);
        assert!(redact(&long, &[]).chars().count() <= 201);
    }

    fn shell(script_windows: &str, script_unix: &str) -> (String, Vec<String>) {
        if cfg!(windows) {
            ("cmd".into(), vec!["/C".into(), script_windows.into()])
        } else {
            ("sh".into(), vec!["-c".into(), script_unix.into()])
        }
    }

    #[test]
    fn a_command_that_stops_shows_its_last_stderr_line_without_secrets() {
        let (cmd, args) = shell(
            "echo starting 1>&2 & echo token s3cret-value is wrong 1>&2 & exit 3",
            "echo starting >&2; echo token s3cret-value is wrong >&2; exit 3",
        );
        let cause =
            diagnose_stdio(&cmd, &args, &[], &["s3cret-value".to_string()], Duration::from_secs(5)).unwrap();
        assert!(cause.contains("exit code 3") && cause.contains("token *** is wrong"), "{cause}");
        assert!(!cause.contains("s3cret-value") && !cause.contains("starting"), "{cause}");
    }

    #[test]
    fn a_missing_command_says_it_couldnt_start() {
        let cause = diagnose_stdio("nexq-no-such-command-xyz", &[], &[], &[], Duration::from_secs(1)).unwrap();
        assert!(cause.contains("couldn't start nexq-no-such-command-xyz"), "{cause}");
    }

    #[test]
    fn a_command_that_keeps_running_quietly_shows_nothing() {
        let (cmd, args) = if cfg!(windows) {
            ("ping".to_string(), vec!["-n".to_string(), "4".to_string(), "127.0.0.1".to_string()])
        } else {
            ("sleep".to_string(), vec!["3".to_string()])
        };
        assert_eq!(diagnose_stdio(&cmd, &args, &[], &[], Duration::from_millis(400)), None);
    }

    /// How many `ping.exe` processes run with `-n <count>` (the marker of one test).
    #[cfg(windows)]
    fn pings_running(count: u32) -> usize {
        let script = format!(
            "(Get-CimInstance Win32_Process | Where-Object {{ $_.Name -eq 'PING.EXE' -and $_.CommandLine -like '*-n {count} *' }} | Measure-Object).Count"
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
    }

    /// A full path: a test run from a Unix-style shell can have no System32 on PATH.
    #[cfg(windows)]
    fn system32_ping() -> String {
        format!(r"{}\System32\PING.EXE", std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()))
    }

    #[cfg(windows)]
    fn wait_until_no_pings(count: u32) -> usize {
        for _ in 0..20 {
            if pings_running(count) == 0 {
                return 0;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        pings_running(count)
    }

    #[cfg(windows)]
    #[test]
    fn a_server_with_a_child_that_outlives_the_wait_is_ended_with_its_children() {
        // cmd starts ping, as `cmd /c npx` starts node. ping keeps stderr open.
        let args: Vec<String> = ["/c", &system32_ping(), "-n", "37", "127.0.0.1"].iter().map(|s| s.to_string()).collect();
        let started = Instant::now();
        let cause = diagnose_stdio("cmd", &args, &[], &[], Duration::from_millis(600));
        assert!(started.elapsed() < Duration::from_secs(6), "took {:?}", started.elapsed());
        assert_eq!(cause, None);
        assert_eq!(wait_until_no_pings(37), 0, "ping survived");
    }

    #[cfg(windows)]
    #[test]
    fn a_server_that_stops_but_leaves_a_child_holding_stderr_still_returns() {
        // cmd exits at once, the background ping keeps the stderr pipe open.
        let args = vec!["/c".to_string(), format!("start /b {} -n 41 127.0.0.1 & exit 2", system32_ping())];
        let started = Instant::now();
        let cause = diagnose_stdio("cmd", &args, &[], &[], Duration::from_secs(5)).unwrap();
        assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
        assert!(cause.contains("exit code 2"), "{cause}");
        assert_eq!(wait_until_no_pings(41), 0, "ping survived");
    }

    #[cfg(windows)]
    #[test]
    fn a_bare_command_name_is_found_through_pathext_like_the_cli_does() {
        let dir = std::env::temp_dir().join(format!("nexq-resolve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fakenpx.cmd"), "@echo off

echo from the shim 1>&2

exit 4

").unwrap();
        let path = std::env::join_paths([dir.clone()]).unwrap();
        let found = resolve_command("fakenpx", Some(&path));
        assert!(found.to_string_lossy().eq_ignore_ascii_case(&dir.join("fakenpx.cmd").to_string_lossy()), "{found:?}");
        // Not found: left alone, so the spawn error names it.
        assert_eq!(resolve_command("nexq-nothing-xyz", Some(&path)), PathBuf::from("nexq-nothing-xyz"));
        // An explicit extension or path is kept.
        assert_eq!(resolve_command("fakenpx.cmd", Some(&path)), PathBuf::from("fakenpx.cmd"));
        let env = vec![("PATH".to_string(), path.to_string_lossy().into_owned())];
        let cause = diagnose_stdio("fakenpx", &[], &env, &[], Duration::from_secs(5)).unwrap();
        assert!(cause.contains("exit code 4") && cause.contains("from the shim"), "{cause}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_http_refusal_shows_its_status() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
        });
        let cause = diagnose_http(&url, &[("Authorization".into(), "Bearer tok-123".into())], &["Bearer tok-123".into()]).await;
        assert_eq!(cause.as_deref(), Some("The server answered 401 Unauthorized."));
    }

    #[tokio::test]
    async fn a_server_that_cannot_be_reached_says_so_without_its_url() {
        let cause = diagnose_http("http://127.0.0.1:1/mcp?token=hunter22", &[], &["hunter22".into()]).await.unwrap();
        assert!(cause.starts_with("It couldn't be reached"), "{cause}");
        assert!(!cause.contains("hunter22"), "{cause}");
    }
}
